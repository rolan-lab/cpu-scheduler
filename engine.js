/* ============================================================================
 * engine.js: the scheduling engine of the CS3608 CPU Scheduling Simulator
 * ============================================================================
 *
 * WHAT THIS FILE IS
 *   Pure scheduling logic: no DOM, no timers, no hidden randomness. The same
 *   input always gives the same output, so every result can be checked by
 *   hand (run Engine.runTextbookTest() in the browser console), and the UI
 *   can play a run forwards and backwards without recomputing anything.
 *
 * HOW TO USE IT
 *   Each algorithm is a function that takes (processes, options):
 *
 *     Engine.fcfs(processes, options)
 *     Engine.sjf(processes, options)
 *     Engine.srtf(processes, options)
 *     Engine.priorityNonPreemptive(processes, options)
 *     Engine.priorityPreemptive(processes, options)
 *     Engine.roundRobin(processes, options)        // uses options.quantum
 *
 *   processes  [{ pid: "P1", arrival: 0, burst: 8, priority: 2 }, ...]
 *              (priority may be left out; it defaults to 1)
 *   options    { quantum: 2, contextSwitch: 0,
 *                aging: { enabled: false, every: 5, by: 1 } }   (all optional)
 *
 *   Each one returns a result:
 *     timeline   the Gantt chart: [{ pid: "P1", start: 0, end: 8 }, ...]
 *                pid "IDLE" = the CPU is idle, pid "CS" = a context switch
 *                ("CS" blocks also say which process they switch from and to)
 *     metrics    one row per process: completion, turnaround, waiting,
 *                dispatch latency, response
 *     averages   { turnaround, waiting, response }
 *     summary    makespan, CPU utilization, throughput, number of switches
 *     frames     one snapshot per tick, for the animated UI
 *     events     what happened at each instant and why, for the event log
 *
 * TIME MODEL
 *   Time is counted in whole ticks: 0, 1, 2, ...
 *   Frame t = a snapshot at the instant t, plus what the CPU does during the
 *   interval [t, t+1). One extra frame at the end (t = makespan) shows the
 *   finished state, so frames.length === makespan + 1.
 *
 * METRICS (per process, following Silberschatz's definitions)
 *   completion       = the instant the process finished its last tick of work
 *   turnaround       = completion - arrival
 *   waiting          = ticks spent waiting IN THE READY QUEUE
 *   dispatch latency = ticks spent being loaded by context switches into the
 *                      CPU (the dispatcher's work for this process)
 *   so that   turnaround = burst + waiting + dispatch latency.
 *   With no context-switch cost, dispatch latency is 0 and
 *   waiting = turnaround - burst, the usual textbook formula.
 *   response         = first tick it executed - arrival. This includes the
 *                      dispatch latency of its first switch-in, because a
 *                      process cannot respond before it runs.
 *
 * SYSTEM METRICS
 *   CPU utilization and throughput are measured over the time the system had
 *   work: from the first arrival to the last completion. Idle time before the
 *   first process even arrives is not held against the scheduler.
 *
 * TIE-BREAKING (the same for every algorithm)
 *   When two processes are equal by the algorithm's own rule, the one that
 *   arrived EARLIER goes first. If they also arrived together, the LOWER PID
 *   goes first. PIDs are compared "naturally": P2 comes before P10.
 *
 * HOW THE ALGORITHMS ARE BUILT
 *   All six share ONE simulation loop (section 6), so arrivals, context
 *   switches, idle time, tie-breaking and the metric formulas are written once
 *   and behave identically for every algorithm. That also keeps "Compare All"
 *   fair. An algorithm is described by just two answers (section 4):
 *     1. Which ready process goes next?
 *        -> its KEY: the smallest key wins (no key = take the head of the queue)
 *     2. May a ready process take the CPU away from the running one?
 *        -> PREEMPTIVE or not
 *   Round Robin adds one more rule, the time quantum (step 3 of the loop).
 *
 * THE MAIN LOOP: one pass per tick. Every convention lives in this order.
 *   1. FINISH    A process whose remaining time reached 0 completes at t.
 *                A context switch that has used up its time hands the CPU to
 *                the process it was loading.
 *   2. ARRIVE    Processes whose arrival time is t join the ready queue
 *                (several at once: earlier arrival, then lower PID, first).
 *   3. QUANTUM   (RR) A process that used its whole quantum goes to the back
 *                of the ready queue, BEHIND the processes that arrived in
 *                step 2. That is the rule "a newcomer enters the queue before
 *                the preempted process".
 *   4. AGE       (Priority + aging) Processes that have waited `every` ticks
 *                in a row in the ready queue improve their priority by `by`
 *                levels. The boost ends when the process starts running.
 *   5. PREEMPT   (SRTF, preemptive Priority) If a ready process is STRICTLY
 *                better than the running one, the running one goes back to
 *                the ready queue. Progress guarantee: a process that a context
 *                switch has just loaded first executes at least one tick.
 *   6. DISPATCH  If the CPU is free, the algorithm picks the next process.
 *                If a DIFFERENT process's context is still loaded in the CPU,
 *                a context switch is paid first.
 *   7. RECORD + EXECUTE   Save frame t, then let one tick pass.
 * ========================================================================== */

const Engine = (function () {
  "use strict";

  /* ==========================================================================
   * 1. VOCABULARY
   * ======================================================================== */

  // The four process states. Each one is a zone in the UI's state diagram.
  const STATE = Object.freeze({
    NEW: "NEW",               // has not arrived yet (arrival > t)
    READY: "READY",           // arrived, waiting for the CPU
    RUNNING: "RUNNING",       // executing on the CPU
    TERMINATED: "TERMINATED", // finished its whole burst
  });

  // What the CPU does during one tick.
  const CPU = Object.freeze({
    RUN: "run",    // executes a process (useful work)
    SWITCH: "cs",  // context switch (overhead, no useful work)
    IDLE: "idle",  // nothing is ready
    DONE: "done",  // only in the very last frame: everything has finished
  });

  // Timeline labels for ticks that belong to no process. They are reserved:
  // a process may not be called "IDLE" or "CS".
  const IDLE = "IDLE";
  const CS = "CS";

  // Things that can happen at an instant. They feed the event-log panel and
  // tell the UI which token moves from which zone to which zone.
  const EVENT = Object.freeze({
    ARRIVE: "ARRIVE",                 // NEW     -> READY
    CS_START: "CS_START",             // a context switch begins
    DISPATCH: "DISPATCH",             // READY   -> RUNNING
    FIRST_RUN: "FIRST_RUN",           // executes for the first time (response time is now known)
    PREEMPT: "PREEMPT",               // RUNNING -> READY (a strictly better process is ready)
    QUANTUM_EXPIRE: "QUANTUM_EXPIRE", // RUNNING -> READY (RR time slice used up)
    QUANTUM_RENEW: "QUANTUM_RENEW",   // RR time slice used up, but nobody is waiting
    AGE: "AGE",                       // a waiting process's priority improved
    PRIORITY_RESET: "PRIORITY_RESET", // an aged priority returns to its base value
    COMPLETE: "COMPLETE",             // RUNNING -> TERMINATED
    IDLE: "IDLE",                     // the CPU becomes idle
    FINISH: "FINISH",                 // every process has terminated
  });

  /* ==========================================================================
   * 2. CONVENTIONS AND DEFAULTS
   * ======================================================================== */

  // Textbooks disagree on these two points, so each one is a single switch.
  // Flip one here (or pass options.conventions) and the whole simulator
  // follows.
  const DEFAULT_CONVENTIONS = Object.freeze({
    // true:  lower number = higher priority (0 is the best).
    // false: higher number = higher priority.
    lowerNumberIsHigherPriority: true,

    // Round Robin only. A process arrives at the same instant that the
    // running process's quantum runs out. Who gets in line first?
    // true:  the newcomer, then the process whose quantum expired.
    // false: the process whose quantum expired, then the newcomer.
    rrArrivalsBeforeExpired: true,
  });

  const DEFAULT_OPTIONS = Object.freeze({
    algorithm: "FCFS", // only used by simulate(); the six functions set it themselves
    quantum: 2,        // RR time slice, in ticks
    contextSwitch: 0,  // ticks spent switching between two DIFFERENT processes
    aging: Object.freeze({
      enabled: false,  // only used by the two Priority algorithms
      every: 5,        // after this many ticks of waiting in a row...
      by: 1,           // ...the priority improves by this many levels
      limit: null,     // the best value aging can reach. null means 0 when lower
                       // numbers are higher priority, and no limit otherwise
    }),
    conventions: DEFAULT_CONVENTIONS,
  });

  // Priority given to a process whose priority was left empty, so that the
  // Priority algorithms can still run on any workload.
  const DEFAULT_PRIORITY = 1;

  // Size limits, checked by validate() before a run starts:
  //   MAX_TICKS       the longest run allowed, in ticks
  //   MAX_FRAME_ROWS  frames x processes. Every frame stores a row per
  //                   process, so this is what bounds the memory a run needs.
  //                   (10 processes x 100,000 ticks fits exactly.)
  const MAX_TICKS = 100000;
  const MAX_FRAME_ROWS = 1000000;

  /* ==========================================================================
   * 3. TIE-BREAKING
   * ======================================================================== */

  // Compares two PIDs "naturally": the text is compared letter by letter, but
  // a run of digits is compared as a number. So "P2" < "P10", whereas plain
  // text comparison would put "P10" first (because "1" < "2").
  // The second part only matters for odd pairs like "P01" and "P1", which are
  // numerically equal; it keeps the order fixed anyway.
  function comparePids(a, b) {
    return a.localeCompare(b, "en", { numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);
  }

  // The tie-breaker used by every algorithm: earlier arrival first, then the
  // lower PID. Returns a negative number if a goes before b.
  function byArrivalThenPid(a, b) {
    return a.arrival - b.arrival || comparePids(a.pid, b.pid);
  }

  /* ==========================================================================
   * 4. THE SIX ALGORITHMS
   *
   * For each algorithm: an explanation, its RULE (the two answers described
   * in the header), and its public function. A rule has:
   *   key(p)      the number the algorithm sorts the ready queue by. The
   *               SMALLEST key is dispatched first; equal keys fall back to
   *               byArrivalThenPid. key === null means "do not sort: take the
   *               process at the head of the queue" (first in, first out).
   *   preemptive  whether a ready process with a STRICTLY smaller key takes
   *               the CPU away from the running one (loop step 5).
   *   why(p)      a short reason, written into the event log.
   *
   * The worked examples all use the same textbook workload, which
   * runTextbookTest() (section 9) runs and checks:
   *   P1 (arrival 0, burst 8)   P2 (1, 4)   P3 (2, 9)   P4 (3, 5)
   * ======================================================================== */

  // Returns a copy of the options with the algorithm filled in.
  function withAlgorithm(options, id) {
    return Object.assign({}, options, { algorithm: id });
  }

  /* --------------------------------------------------------------------------
   * FCFS: First-Come, First-Served (non-preemptive)
   *
   * Idea   The ready queue is a line at a counter: whoever arrived first is
   *        served first, and keeps the CPU until its whole burst is done.
   * Rule   No key: the dispatcher always takes the HEAD of the queue.
   *        Processes arriving at the same instant join the line in
   *        tie-break order (lower PID first). Never preempts.
   * Example
   *        P1 0-8 | P2 8-12 | P3 12-21 | P4 21-26
   *        waiting = start - arrival = 0, 7, 10, 18   ->  average 8.75
   * Exam points
   *        Simplest algorithm, and no starvation. Suffers the CONVOY EFFECT:
   *        short jobs pile up behind a long one (P2 waits 7 ticks behind P1).
   * ------------------------------------------------------------------------ */
  const FCFS_RULE = Object.freeze({
    id: "FCFS",
    name: "First-Come, First-Served",
    short: "FCFS",
    preemptive: false,
    usesPriority: false,
    usesQuantum: false,
    key: null,
    why: () => "head of the ready queue",
  });

  function fcfs(processes, options) {
    return simulate(processes, withAlgorithm(options, "FCFS"));
  }

  /* --------------------------------------------------------------------------
   * SJF: Shortest Job First (non-preemptive)
   *
   * Idea   Whenever the CPU becomes free, give it to the ready process with
   *        the SHORTEST CPU burst. Once started, a process runs to the end.
   * Rule   key = burst. Not preemptive: the key is only consulted when the
   *        CPU is free, so a short job that arrives while another one runs
   *        has to wait. Equal bursts: earlier arrival, then lower PID.
   * Example
   *        t=0   only P1 has arrived, so it runs 0-8 even though it is long.
   *        t=8   ready: P2 (4), P4 (5), P3 (9)  ->  P2, then P4, then P3.
   *        P1 0-8 | P2 8-12 | P4 12-17 | P3 17-26
   *        waiting = 0, 7, 15, 9   ->  average 7.75
   * Exam points
   *        Gives the minimum average waiting time among NON-preemptive
   *        algorithms when all jobs are ready together. Needs to know burst
   *        lengths in advance (real systems predict them, e.g. with
   *        exponential averaging). Long jobs can starve.
   * ------------------------------------------------------------------------ */
  const SJF_RULE = Object.freeze({
    id: "SJF",
    name: "Shortest Job First (non-preemptive)",
    short: "SJF",
    preemptive: false,
    usesPriority: false,
    usesQuantum: false,
    key: (p) => p.burst,
    why: (p) => `shortest burst: ${p.burst}`,
  });

  function sjf(processes, options) {
    return simulate(processes, withAlgorithm(options, "SJF"));
  }

  /* --------------------------------------------------------------------------
   * SRTF: Shortest Remaining Time First (preemptive SJF)
   *
   * Idea   At every instant, the process with the LEAST WORK LEFT should be
   *        on the CPU.
   * Rule   key = remaining time. Preemptive: every tick (in practice, every
   *        time a process arrives) the best ready process is compared with
   *        the running one. If its remaining time is STRICTLY smaller, the
   *        running one goes back to the ready queue. An equal remaining time
   *        does not preempt (it would only cost a useless switch).
   * Example
   *        t=0   P1 starts (it is alone).
   *        t=1   P2 arrives: 4 < P1's remaining 7      ->  P2 preempts P1.
   *        t=2   P3 arrives: 9 is not < P2's 3         ->  no change.
   *        t=3   P4 arrives: 5 is not < P2's 2         ->  no change.
   *        t=5   P2 done. Ready: P1 7, P3 9, P4 5      ->  P4.
   *        t=10  P4 done. Ready: P1 7, P3 9            ->  P1, then P3.
   *        P1 0-1 | P2 1-5 | P4 5-10 | P1 10-17 | P3 17-26
   *        waiting = 9, 0, 15, 2   ->  average 6.5
   * Exam points
   *        Provably the minimum average waiting time of ANY algorithm (when
   *        switches cost nothing). Costs more context switches. Long jobs
   *        can starve. Needs remaining-time knowledge.
   * ------------------------------------------------------------------------ */
  const SRTF_RULE = Object.freeze({
    id: "SRTF",
    name: "Shortest Remaining Time First (preemptive SJF)",
    short: "SRTF",
    preemptive: true,
    usesPriority: false,
    usesQuantum: false,
    key: (p) => p.remaining,
    keyName: "remaining time",
    value: (p) => p.remaining,
    why: (p) => `shortest remaining time: ${p.remaining}`,
  });

  function srtf(processes, options) {
    return simulate(processes, withAlgorithm(options, "SRTF"));
  }

  /* --------------------------------------------------------------------------
   * Priority (non-preemptive)
   *
   * Idea   Every process has a priority number, and the best priority goes
   *        first. Here LOWER number = HIGHER priority (switchable in
   *        DEFAULT_CONVENTIONS).
   * Rule   key = effective priority. Not preemptive: consulted only when the
   *        CPU is free. Equal priority: earlier arrival, then lower PID.
   * Aging (optional)
   *        Step 4 of the loop: a process that has waited `every` ticks in a
   *        row in the ready queue improves by `by` levels (never past the
   *        best level, 0). The boost exists to get the process dispatched:
   *        when it starts running, its priority returns to its base value.
   *        Aging stops low-priority processes from waiting forever
   *        (starvation): however many better processes keep arriving, a
   *        waiting process reaches the best level after at most
   *        (base / by) x every ticks, and then it gets the CPU.
   * Example
   *        The textbook workload gives no priorities, so all four get the
   *        default 1. Every comparison is a tie, decided by arrival time, so
   *        the result is exactly FCFS: average waiting 8.75.
   * Exam points
   *        Starvation of low-priority processes (the fix: aging). SJF is a
   *        special case of priority scheduling, with priority = burst.
   * ------------------------------------------------------------------------ */
  // Priority as a key (smaller key = dispatched first). With the default
  // convention the priority number already works that way. With the opposite
  // convention, negating it makes the biggest number the smallest key.
  function priorityKey(p, ctx) {
    return ctx.lowerIsHigher ? p.priority : -p.priority;
  }

  const PRIO_NP_RULE = Object.freeze({
    id: "PRIO_NP",
    name: "Priority (non-preemptive)",
    short: "Priority NP",
    preemptive: false,
    usesPriority: true,
    usesQuantum: false,
    key: priorityKey,
    why: (p) => `best priority: ${p.priority}`,
  });

  function priorityNonPreemptive(processes, options) {
    return simulate(processes, withAlgorithm(options, "PRIO_NP"));
  }

  /* --------------------------------------------------------------------------
   * Priority (preemptive)
   *
   * Idea   Like Priority, but a ready process with a STRICTLY better priority
   *        takes the CPU away immediately.
   * Rule   key = effective priority, preemptive (loop step 5). A preemption
   *        can be caused by an arrival, or by aging: a waiting process that
   *        ages past the running one takes the CPU at that tick. An aged
   *        process returns to its base priority when it starts running, so
   *        a process better than that base can preempt it after its first
   *        tick; it then ages up again. It still gets at least one tick of
   *        work every time, so it cannot starve.
   * Example
   *        All priorities are equal (default 1), so no process is ever
   *        strictly better: the result is again FCFS, average waiting 8.75.
   * Exam points
   *        Most responsive to important processes; same starvation problem
   *        and the same aging fix as the non-preemptive version.
   * ------------------------------------------------------------------------ */
  const PRIO_P_RULE = Object.freeze({
    id: "PRIO_P",
    name: "Priority (preemptive)",
    short: "Priority P",
    preemptive: true,
    usesPriority: true,
    usesQuantum: false,
    key: priorityKey,
    keyName: "priority",
    value: (p) => p.priority,
    why: (p) => `best priority: ${p.priority}`,
  });

  function priorityPreemptive(processes, options) {
    return simulate(processes, withAlgorithm(options, "PRIO_P"));
  }

  /* --------------------------------------------------------------------------
   * RR: Round Robin (preemptive, time quantum q)
   *
   * Idea   Time sharing. Each process runs for at most q ticks, then goes to
   *        the back of the line, so the CPU circulates among everyone.
   * Rule   No key: the dispatcher takes the HEAD of the queue (FIFO).
   *        Step 3 of the loop: when the running process has used all q ticks
   *        and someone is waiting, it goes to the BACK of the queue. If
   *        nobody is waiting it simply keeps the CPU with a fresh quantum (no
   *        switch). A process that finishes early gives the CPU up at once,
   *        and the next process gets a full quantum.
   * Same-instant rule
   *        A process that arrives at the same instant a quantum expires
   *        enters the queue BEFORE the expired process, because arrivals
   *        (step 2) are handled before the quantum check (step 3).
   * Example (q = 2)
   *        t=2   P3 arrives just as P1's quantum ends: queue P2, P3, P1.
   *        P1 0-2 | P2 2-4 | P3 4-6 | P1 6-8 | P4 8-10 | P2 10-12 |
   *        P3 12-14 | P1 14-16 | P4 16-18 | P3 18-20 | P1 20-22 |
   *        P4 22-23 | P3 23-26
   *        waiting = 14, 7, 15, 15   ->  average 12.75
   *        But response = 0, 1, 2, 5 ->  average 2.0, the best of all.
   * Example (q = 4)
   *        P1 0-4 | P2 4-8 | P3 8-12 | P4 12-16 | P1 16-20 | P3 20-24 |
   *        P4 24-25 | P3 25-26
   *        waiting = 12, 3, 15, 17   ->  average 11.75
   * Exam points
   *        Best response time; no starvation. A very large q behaves like
   *        FCFS; a very small q spends most of the time on context switches.
   * ------------------------------------------------------------------------ */
  const RR_RULE = Object.freeze({
    id: "RR",
    name: "Round Robin",
    short: "RR",
    preemptive: false, // RR's time-slice rule lives in step 3, not in step 5
    usesPriority: false,
    usesQuantum: true,
    key: null,
    why: () => "head of the ready queue",
  });

  function roundRobin(processes, options) {
    return simulate(processes, withAlgorithm(options, "RR"));
  }

  // All rules by id, and the order used by "Compare All" and its bar chart.
  const ALGORITHMS = Object.freeze({
    FCFS: FCFS_RULE,
    SJF: SJF_RULE,
    SRTF: SRTF_RULE,
    PRIO_NP: PRIO_NP_RULE,
    PRIO_P: PRIO_P_RULE,
    RR: RR_RULE,
  });
  const ALGORITHM_ORDER = Object.freeze(["FCFS", "SJF", "SRTF", "PRIO_NP", "PRIO_P", "RR"]);

  /* ==========================================================================
   * 5. INPUT CHECKING
   *
   * The engine is strict: numbers must already be numbers. Converting the
   * text typed into a form is the UI's job.
   * ======================================================================== */

  function hasValue(v) {
    return v !== undefined && v !== null && v !== "";
  }

  // Looks up an algorithm's rule by id, or returns null. Only the six ids
  // count: a plain ALGORITHMS[id] would also "find" names that every
  // JavaScript object has built in, such as "toString" or "constructor".
  function ruleFor(id) {
    return typeof id === "string" && Object.prototype.hasOwnProperty.call(ALGORITHMS, id)
      ? ALGORITHMS[id]
      : null;
  }

  // Fills in every option the caller left out with its default value.
  function normalizeOptions(options) {
    const o = options || {};
    return {
      algorithm: hasValue(o.algorithm) ? o.algorithm : DEFAULT_OPTIONS.algorithm,
      quantum: hasValue(o.quantum) ? o.quantum : DEFAULT_OPTIONS.quantum,
      contextSwitch: hasValue(o.contextSwitch) ? o.contextSwitch : DEFAULT_OPTIONS.contextSwitch,
      aging: Object.assign({}, DEFAULT_OPTIONS.aging, o.aging),
      conventions: Object.assign({}, DEFAULT_CONVENTIONS, o.conventions),
    };
  }

  // Returns a list of human-readable problems. An empty list means "valid".
  function validate(processes, options) {
    const opt = normalizeOptions(options);
    const errors = [];

    if (!Array.isArray(processes) || processes.length === 0) {
      errors.push("Add at least one process.");
      return errors;
    }

    const seen = new Set();
    processes.forEach((raw, i) => {
      const p = raw || {};
      const pid = hasValue(p.pid) ? String(p.pid).trim() : "";
      const where = pid || `Row ${i + 1}`;
      if (pid === "") errors.push(`${where}: the PID is empty.`);
      else if (pid.toUpperCase() === IDLE || pid.toUpperCase() === CS) {
        errors.push(`${where}: "${IDLE}" and "${CS}" are reserved for the timeline.`);
      } else if (seen.has(pid)) errors.push(`${where}: this PID is used twice.`);
      else seen.add(pid);

      // Number.isInteger rejects 2.5, "3", NaN and Infinity in one test.
      if (!Number.isInteger(p.arrival) || p.arrival < 0) {
        errors.push(`${where}: arrival time must be a whole number >= 0.`);
      }
      if (!Number.isInteger(p.burst) || p.burst < 1) {
        errors.push(`${where}: burst time must be a whole number >= 1.`);
      }
      if (hasValue(p.priority) && (!Number.isInteger(p.priority) || p.priority < 0)) {
        errors.push(`${where}: priority must be a whole number >= 0.`);
      }
    });

    const rule = ruleFor(opt.algorithm);
    if (!rule) errors.push(`Unknown algorithm "${opt.algorithm}".`);
    if (rule && rule.usesQuantum && (!Number.isInteger(opt.quantum) || opt.quantum < 1)) {
      errors.push("The time quantum must be a whole number >= 1.");
    }
    if (!Number.isInteger(opt.contextSwitch) || opt.contextSwitch < 0) {
      errors.push("The context-switch time must be a whole number >= 0.");
    }
    if (opt.aging.enabled) {
      if (!Number.isInteger(opt.aging.every) || opt.aging.every < 1) {
        errors.push("Aging: the interval must be a whole number >= 1.");
      }
      if (!Number.isInteger(opt.aging.by) || opt.aging.by < 1) {
        errors.push("Aging: the amount must be a whole number >= 1.");
      }
      if (opt.aging.limit !== null && !Number.isInteger(opt.aging.limit)) {
        errors.push("Aging: the limit must be a whole number.");
      }
    }

    // Size check. This bound is a guarantee, not a guess:
    //   - the CPU can only be idle before the last arrival (after it, some
    //     process is always ready until all are done): at most lastArrival
    //     idle ticks;
    //   - every context switch is followed by at least one tick of work (the
    //     progress guarantee in step 5): at most totalWork switches.
    // So a run never takes more than lastArrival + totalWork x (1 + cost)
    // ticks. reduce() is used instead of Math.max(...list), which fails on
    // very long lists.
    if (errors.length === 0) {
      const lastArrival = processes.reduce((max, p) => Math.max(max, p.arrival), 0);
      const totalWork = processes.reduce((sum, p) => sum + p.burst, 0);
      const worstTicks = lastArrival + totalWork * (1 + opt.contextSwitch);
      if (worstTicks > MAX_TICKS || (worstTicks + 1) * processes.length > MAX_FRAME_ROWS) {
        errors.push("The workload is too large to simulate.");
      }
    }
    return errors;
  }

  /* ==========================================================================
   * 6. THE SHARED SIMULATION LOOP
   *
   * simulate(processes, options) runs the algorithm named in options.algorithm.
   * The six functions in section 4 call it with their own name filled in.
   * ======================================================================== */

  function simulate(processes, options) {
    const opt = normalizeOptions(options);
    const errors = validate(processes, opt);
    if (errors.length > 0) {
      throw new Error("Invalid input:\n- " + errors.join("\n- "));
    }

    const rule = ruleFor(opt.algorithm);
    const ctx = { lowerIsHigher: opt.conventions.lowerNumberIsHigherPriority };
    const agingOn = rule.usesPriority && opt.aging.enabled;
    const agingLimit = opt.aging.limit !== null ? opt.aging.limit : ctx.lowerIsHigher ? 0 : Infinity;

    /* ---- Working copies ----------------------------------------------------
     * The engine never changes the caller's objects. "Compare All" passes the
     * SAME array to every algorithm, so each run must start from scratch. If
     * we decremented the caller's burst times, the second algorithm would
     * find every process already finished.
     * ---------------------------------------------------------------------- */
    const procs = processes.map((p) => {
      const priority = hasValue(p.priority) ? p.priority : DEFAULT_PRIORITY;
      return {
        pid: String(p.pid).trim(),
        arrival: p.arrival,
        burst: p.burst,
        basePriority: priority,  // as entered by the user
        priority,                // effective priority (changes with aging)
        state: STATE.NEW,
        remaining: p.burst,
        waitedSoFar: 0,          // ticks spent in the ready queue so far (live waiting time)
        dispatchSoFar: 0,        // ticks spent being switched in so far (dispatch latency)
        agingClock: 0,           // ticks waited in a row since the last aging step
        ranThisStint: false,     // executed at least one tick since it was dispatched?
        switchingIn: false,      // is a context switch loading it right now?
        firstRun: null,          // the first tick it executed  -> response time
        completion: null,        // the instant it finished     -> turnaround time
      };
    });

    // Processes in the order they arrive (same instant: lower PID first).
    // nextArrival points at the next one that has not arrived yet.
    const arrivalOrder = procs.slice().sort(byArrivalThenPid);
    let nextArrival = 0;

    /* ---- Scheduler state -------------------------------------------------- */
    const readyQueue = []; // READY processes, in the order they joined the queue
    let running = null;    // the process on the CPU, or null
    let quantumUsed = 0;   // RR: ticks the running process has used of its slice
    let cs = null;         // context switch in progress: { from, to, done, total }

    // Whose registers are currently loaded in the CPU. This is what decides
    // whether a dispatch costs a context switch. It stays set after a process
    // completes (its context is still loaded, so switching to another process
    // costs a switch). It is null at t = 0 and after an idle tick, since going
    // from an idle CPU to a process costs no switch.
    let loaded = null;

    let completed = 0;
    let wasIdle = false;   // was the previous tick idle? (to log IDLE only once)
    const stats = { busy: 0, idle: 0, switching: 0, switches: 0 };

    /* ---- Output ----------------------------------------------------------- */
    const frames = [];     // one per tick, plus the final frame
    const timeline = [];   // the Gantt chart: [{ pid, start, end }]
    const allEvents = [];  // every event, in order (the full event log)

    let t = 0;             // the current instant
    let events = [];       // the events of the current instant only

    // Records one event, both in this frame's list and in the full log.
    function log(type, p, note, extra) {
      const event = Object.assign({ t, type, pid: p ? p.pid : null, note }, extra);
      events.push(event);
      allEvents.push(event);
    }

    // The ready processes in the order the algorithm would pick them. The
    // dispatcher takes the first one, and the UI draws the queue in this order.
    function readyInPickOrder() {
      if (rule.key === null) return readyQueue.slice(); // FIFO: keep queue order
      return readyQueue.slice().sort(
        (a, b) => rule.key(a, ctx) - rule.key(b, ctx) || byArrivalThenPid(a, b)
      );
    }

    // Removes and returns the process the algorithm picks next.
    function takeNext() {
      const chosen = readyInPickOrder()[0];
      readyQueue.splice(readyQueue.indexOf(chosen), 1);
      return chosen;
    }

    // READY -> RUNNING.
    function startRunning(p, note) {
      p.state = STATE.RUNNING;
      p.switchingIn = false;
      p.ranThisStint = false; // it has not executed yet since this dispatch
      running = p;
      loaded = p;
      quantumUsed = 0; // every dispatch starts a fresh quantum
      log(EVENT.DISPATCH, p, note, { fromState: STATE.READY, toState: STATE.RUNNING });

      // Aging rule: a boosted priority exists to get the process dispatched.
      // Once it starts running, it returns to its base priority.
      if (p.priority !== p.basePriority) {
        log(
          EVENT.PRIORITY_RESET, p,
          `${p.pid} starts running, so its priority returns to the base value ${p.basePriority} (was ${p.priority})`,
          { before: p.priority, after: p.basePriority }
        );
        p.priority = p.basePriority;
      }
    }

    // RUNNING -> READY (after a preemption or an expired quantum).
    function sendBackToReady(p) {
      p.state = STATE.READY;
      p.agingClock = 0; // a new waiting period starts now
      p.ranThisStint = false;
      readyQueue.push(p); // joins at the back of the queue
    }

    // One aging step: move `by` levels toward the best priority, never past
    // the limit. A process that is already at (or better than) the limit
    // stays where it is: aging only ever improves a priority.
    function improvedPriority(priority) {
      if (ctx.lowerIsHigher) {
        return priority <= agingLimit ? priority : Math.max(agingLimit, priority - opt.aging.by);
      }
      return priority >= agingLimit ? priority : Math.min(agingLimit, priority + opt.aging.by);
    }

    /* ---- STEP 1: FINISH --------------------------------------------------- */
    function finishWhatEnded() {
      if (running && running.remaining === 0) {
        // The process executed its last tick during [t-1, t), so it completes
        // at the instant t.
        const p = running;
        running = null; // the CPU is free; `loaded` stays p (see above)
        p.state = STATE.TERMINATED;
        p.completion = t;
        p.ranThisStint = false;
        completed++;
        // turnaround = burst + waiting + dispatch latency (see METRICS above)
        const turnaround = t - p.arrival;
        const waiting = turnaround - p.burst - p.dispatchSoFar;
        const waitingSum = p.dispatchSoFar > 0
          ? `${turnaround} - ${p.burst} - ${p.dispatchSoFar} (switch-in) = ${waiting}`
          : `${turnaround} - ${p.burst} = ${waiting}`;
        log(
          EVENT.COMPLETE, p,
          `${p.pid} completes at ${t}: turnaround = ${t} - ${p.arrival} = ${turnaround}, waiting = ${waitingSum}`,
          { fromState: STATE.RUNNING, toState: STATE.TERMINATED }
        );
      } else if (cs && cs.done === cs.total) {
        // The switch has used all its ticks: the process it loaded now runs.
        const p = cs.to;
        cs = null;
        startRunning(p, `Context switch finished: ${p.pid} is now running`);
      }
    }

    /* ---- STEP 2: ARRIVE --------------------------------------------------- */
    function admitArrivals() {
      while (nextArrival < arrivalOrder.length && arrivalOrder[nextArrival].arrival <= t) {
        const p = arrivalOrder[nextArrival++];
        p.state = STATE.READY;
        p.agingClock = 0;
        readyQueue.push(p);
        const extra = rule.usesPriority ? `, priority ${p.priority}` : "";
        log(
          EVENT.ARRIVE, p,
          `${p.pid} arrives (burst ${p.burst}${extra}) and joins the ready queue`,
          { fromState: STATE.NEW, toState: STATE.READY }
        );
      }
    }

    /* ---- STEP 3: QUANTUM (Round Robin only) ------------------------------- */
    function checkQuantum() {
      if (!rule.usesQuantum || !running || quantumUsed < opt.quantum) return;

      if (readyQueue.length === 0) {
        // Nobody is waiting: the process keeps the CPU with a fresh quantum.
        // It is the same process, so there is no context switch.
        quantumUsed = 0;
        log(
          EVENT.QUANTUM_RENEW, running,
          `${running.pid} used its quantum (${opt.quantum}) but no one is waiting, ` +
            `so it keeps the CPU (no context switch)`
        );
        return;
      }

      const p = running;
      running = null;
      log(
        EVENT.QUANTUM_EXPIRE, p,
        `${p.pid} used its full quantum (${opt.quantum}) and goes to the back of the ready queue`,
        { fromState: STATE.RUNNING, toState: STATE.READY }
      );
      sendBackToReady(p);
    }

    /* ---- STEP 4: AGE (Priority algorithms with aging only) ---------------- */
    function applyAging() {
      if (!agingOn) return;
      for (const p of readyQueue) {
        if (p.agingClock < opt.aging.every) continue;
        p.agingClock = 0; // start counting the next `every` ticks
        const better = improvedPriority(p.priority);
        if (better !== p.priority) {
          log(
            EVENT.AGE, p,
            `${p.pid} has waited ${opt.aging.every} ticks: priority ${p.priority} -> ${better}`,
            { before: p.priority, after: better }
          );
          p.priority = better;
        }
      }
    }

    /* ---- STEP 5: PREEMPT (SRTF and preemptive Priority only) -------------- */
    function checkPreemption() {
      if (!rule.preemptive || !running || readyQueue.length === 0) return;

      // Progress guarantee: a process that a context switch has just loaded
      // executes at least one tick before it can be preempted. Without this
      // rule, a waiting process that keeps improving during the switch (aging)
      // could take the CPU back before the loaded process ever ran, and the
      // two could swap back and forth forever with no work done. With it,
      // every switch buys at least one tick of real work. (Real kernels use
      // the same idea: a minimum run time before a task can be preempted.)
      // Only a process loaded by a switch can be here without having run: a
      // process dispatched without a switch executes in this same tick.
      if (!running.ranThisStint) return;

      const best = readyInPickOrder()[0];
      // Strictly smaller key only: an equal challenger does not preempt.
      if (!(rule.key(best, ctx) < rule.key(running, ctx))) return;

      const p = running;
      running = null;
      log(
        EVENT.PREEMPT, p,
        `${p.pid} is preempted by ${best.pid}: ${rule.keyName} ${rule.value(best)} beats ${rule.value(p)}`,
        { fromState: STATE.RUNNING, toState: STATE.READY, by: best.pid }
      );
      sendBackToReady(p);
    }

    /* ---- STEP 6: DISPATCH ------------------------------------------------- */
    function dispatch() {
      if (running || cs || readyQueue.length === 0) return;

      const p = takeNext();
      const reason = rule.why(p);

      // A switch happens only between two DIFFERENT processes. There is none
      // at t = 0 or after an idle tick (loaded === null), and none when the
      // same process is picked again.
      const isSwitch = loaded !== null && loaded !== p;
      if (isSwitch) stats.switches++;

      if (isSwitch && opt.contextSwitch > 0) {
        // The choice is final from here on: the switch is never interrupted.
        cs = { from: loaded, to: p, done: 0, total: opt.contextSwitch };
        p.switchingIn = true; // still READY, but no longer in the queue
        const ticks = opt.contextSwitch === 1 ? "1 tick" : `${opt.contextSwitch} ticks`;
        log(
          EVENT.CS_START, p,
          `${p.pid} is chosen (${reason}); context switch ${loaded.pid} -> ${p.pid} takes ${ticks}`,
          { from: loaded.pid, to: p.pid }
        );
      } else {
        startRunning(p, `${p.pid} gets the CPU (${reason})`);
      }
    }

    /* ---- STEP 7: RECORD + EXECUTE ----------------------------------------- */
    function recordAndExecute() {
      // (a) Decide what the CPU does during [t, t+1).
      let cpu;
      if (running) {
        if (running.firstRun === null) {
          running.firstRun = t;
          log(
            EVENT.FIRST_RUN, running,
            `${running.pid} executes for the first time: response = ${t} - ${running.arrival} = ${t - running.arrival}`
          );
        }
        cpu = {
          kind: CPU.RUN,
          pid: running.pid,
          quantum: rule.usesQuantum ? opt.quantum : null,
          quantumTick: rule.usesQuantum ? quantumUsed + 1 : null, // 1-based: "tick 1 of 2"
        };
        wasIdle = false;
      } else if (cs) {
        cpu = {
          kind: CPU.SWITCH,
          pid: cs.to.pid,    // the process being loaded
          from: cs.from.pid,
          to: cs.to.pid,
          step: cs.done + 1, // 1-based: "switch tick 1 of 2"
          total: cs.total,
        };
        wasIdle = false;
      } else {
        if (!wasIdle) log(EVENT.IDLE, null, "The CPU is idle: no process is ready");
        cpu = { kind: CPU.IDLE, pid: null };
        wasIdle = true;
      }

      // (b) Record. The frame is taken BEFORE the tick passes, so it shows
      //     the values at the instant t.
      addToTimeline(cpu);
      frames.push(snapshot(cpu));

      // (c) One tick passes.
      if (running) {
        running.remaining--;
        running.ranThisStint = true;
        quantumUsed++;
        stats.busy++;
      } else if (cs) {
        cs.done++;
        cs.to.dispatchSoFar++; // being loaded: not in the ready queue, not executing
        stats.switching++;
      } else {
        stats.idle++;
        loaded = null; // after idling, the next dispatch costs no switch
      }
      for (const p of readyQueue) {
        p.waitedSoFar++;
        if (agingOn) p.agingClock++;
      }
    }

    // Extends the last timeline block if this tick continues it, or starts a
    // new block. Exactly one tick is added each time, so blocks never overlap
    // and never leave gaps.
    function addToTimeline(cpu) {
      const pid = cpu.kind === CPU.RUN ? cpu.pid : cpu.kind === CPU.SWITCH ? CS : IDLE;
      const last = timeline[timeline.length - 1];
      const continues =
        last && last.pid === pid && (pid !== CS || (last.from === cpu.from && last.to === cpu.to));
      if (continues) {
        last.end = t + 1;
      } else if (pid === CS) {
        timeline.push({ pid, start: t, end: t + 1, from: cpu.from, to: cpu.to });
      } else {
        timeline.push({ pid, start: t, end: t + 1 });
      }
    }

    /* ---- The frame: everything the UI needs to draw instant t -------------
     * The UI must never recompute scheduling, so a frame carries:
     *   cpu            what the CPU does during [t, t+1)
     *   readyQueue     PIDs of the READY processes, in the order the algorithm
     *                  would pick them (a process being switched in is NOT
     *                  in this list)
     *   procs          every process's live state, in input order
     *   events         what happened at instant t (state changes carry
     *                  fromState / toState)
     *   stats          running totals at instant t
     *   timelineIndex  the timeline block that contains this tick: draw
     *                  timeline[0..timelineIndex], cutting the last one at t + 1
     * ---------------------------------------------------------------------- */
    function snapshot(cpu) {
      return {
        t,
        cpu,
        readyQueue: readyInPickOrder().map((p) => p.pid),
        procs: procs.map((p) => ({
          pid: p.pid,
          state: p.state,
          switchingIn: p.switchingIn,
          remaining: p.remaining,
          executed: p.burst - p.remaining,
          priority: p.priority, // effective priority (the base is in result.processes)
          waitedSoFar: p.waitedSoFar,       // ticks in the ready queue so far
          dispatchLatency: p.dispatchSoFar, // ticks being switched in so far
          firstRun: p.firstRun,
          completion: p.completion,
          response: p.firstRun === null ? null : p.firstRun - p.arrival,
          turnaround: p.completion === null ? null : p.completion - p.arrival,
          waiting: p.completion === null ? null : p.completion - p.arrival - p.burst - p.dispatchSoFar,
        })),
        events,
        stats: Object.assign({ completed }, stats),
        timelineIndex: timeline.length - 1,
      };
    }

    /* ---- THE MAIN LOOP ---------------------------------------------------- */
    for (t = 0; ; t++) {
      // validate() proves every valid run ends within MAX_TICKS, so this is a
      // last line of defence that should never fire.
      if (t > MAX_TICKS) throw new Error("The simulation did not finish (internal limit reached).");
      events = [];

      finishWhatEnded();                                // STEP 1

      if (completed === procs.length) {
        // Everything is done: record the final frame and stop.
        log(EVENT.FINISH, null, `All processes have finished at t = ${t}`);
        frames.push(snapshot({ kind: CPU.DONE, pid: null }));
        break;
      }

      if (opt.conventions.rrArrivalsBeforeExpired) {
        admitArrivals();                                // STEP 2
        checkQuantum();                                 // STEP 3
      } else {
        checkQuantum();                                 // STEP 3 first, then
        admitArrivals();                                // STEP 2
      }
      applyAging();                                     // STEP 4
      checkPreemption();                                // STEP 5
      dispatch();                                       // STEP 6
      recordAndExecute();                               // STEP 7
    }

    /* ---- The result ------------------------------------------------------- */
    const makespan = t;
    const metrics = procs.map((p) => {
      const turnaround = p.completion - p.arrival;
      return {
        pid: p.pid,
        arrival: p.arrival,
        burst: p.burst,
        priority: p.basePriority,
        firstRun: p.firstRun,
        completion: p.completion,
        turnaround,
        waiting: turnaround - p.burst - p.dispatchSoFar, // = ticks in the ready queue
        dispatchLatency: p.dispatchSoFar,
        response: p.firstRun - p.arrival,
      };
    });
    // The system had work from the first arrival to the last completion.
    const firstArrival = arrivalOrder[0].arrival;
    const activeTime = makespan - firstArrival; // >= 1, since every burst is >= 1
    const average = (field) => metrics.reduce((sum, m) => sum + m[field], 0) / metrics.length;

    return {
      algorithm: rule.id,
      algorithmName: rule.name,
      options: opt,
      // The parts of each process that never change, in input order.
      processes: procs.map((p) => ({
        pid: p.pid,
        arrival: p.arrival,
        burst: p.burst,
        priority: p.basePriority,
      })),
      timeline,
      metrics,
      averages: {
        turnaround: average("turnaround"),
        waiting: average("waiting"),
        response: average("response"),
      },
      summary: {
        makespan,                                // the time the last process finished
        firstArrival,                            // the time the first process arrived
        busy: stats.busy,                        // ticks of useful work
        idle: stats.idle,                        // ticks with nothing ready (from t = 0)
        switching: stats.switching,              // ticks spent in context switches
        switches: stats.switches,                // switches between different processes
        cpuUtilization: stats.busy / activeTime, // useful work / time the system had work
        throughput: procs.length / activeTime,   // processes finished per tick of that time
      },
      frames,
      events: allEvents,
    };
  }

  /* ==========================================================================
   * 7. COMPARE ALL
   *
   * Runs every algorithm on the same workload with the same options, so the
   * comparison is fair. simulate() copies its input, so sharing is safe.
   * ======================================================================== */

  function compareAll(processes, options) {
    return ALGORITHM_ORDER.map((id) => simulate(processes, withAlgorithm(options, id)));
  }

  /* ==========================================================================
   * 8. RANDOM WORKLOAD GENERATOR
   *
   * Uses a SEEDED pseudo-random generator: the same seed always produces the
   * same workload, so an interesting random case can be reproduced in class
   * ("try seed 42"). The UI picks a new seed each time the button is pressed.
   * ======================================================================== */

  // mulberry32: a tiny, well-known 32-bit pseudo-random generator.
  // Returns a function that yields numbers in [0, 1).
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let x = a;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  function generateWorkload(options) {
    const o = Object.assign(
      { count: 5, maxArrival: 10, minBurst: 1, maxBurst: 10, maxPriority: 5, seed: 1 },
      options
    );
    const random = mulberry32(o.seed);
    const between = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1)); // inclusive

    const list = [];
    for (let i = 0; i < o.count; i++) {
      list.push({
        arrival: between(0, o.maxArrival),
        burst: between(o.minBurst, o.maxBurst),
        priority: between(0, o.maxPriority),
      });
    }
    // Number the processes in arrival order, so P1 arrives first. The sort is
    // stable, so equal arrival times keep the order they were generated in.
    list.sort((a, b) => a.arrival - b.arrival);
    return list.map((p, i) => Object.assign({ pid: `P${i + 1}` }, p));
  }

  /* ==========================================================================
   * 9. TEXTBOOK TEST (prints to the console)
   *
   * Runs the classic workload through every algorithm, prints each Gantt
   * chart and metrics table, and compares the results with the hand
   * calculations written in section 4. Open the browser console (F12) on
   * tests.html, or on any page that loads engine.js, and run:
   *
   *     Engine.runTextbookTest()
   *
   * It returns true when every result matches.
   * ======================================================================== */

  // A timeline as one line of text, for example "P1 0-8 | P2 8-12".
  function timelineText(timeline) {
    return timeline.map((b) => `${b.pid} ${b.start}-${b.end}`).join(" | ");
  }

  function runTextbookTest() {
    const workload = [
      { pid: "P1", arrival: 0, burst: 8 },
      { pid: "P2", arrival: 1, burst: 4 },
      { pid: "P3", arrival: 2, burst: 9 },
      { pid: "P4", arrival: 3, burst: 5 },
    ];

    // The hand-calculated answers (worked out in section 4).
    const cases = [
      {
        name: "FCFS",
        result: fcfs(workload),
        gantt: "P1 0-8 | P2 8-12 | P3 12-21 | P4 21-26",
        waiting: [0, 7, 10, 18],
        average: 8.75,
      },
      {
        name: "SJF (non-preemptive)",
        result: sjf(workload),
        gantt: "P1 0-8 | P2 8-12 | P4 12-17 | P3 17-26",
        waiting: [0, 7, 15, 9],
        average: 7.75,
      },
      {
        name: "SRTF",
        result: srtf(workload),
        gantt: "P1 0-1 | P2 1-5 | P4 5-10 | P1 10-17 | P3 17-26",
        waiting: [9, 0, 15, 2],
        average: 6.5,
      },
      {
        name: "Priority, non-preemptive (no priorities given: all equal, so = FCFS)",
        result: priorityNonPreemptive(workload),
        gantt: "P1 0-8 | P2 8-12 | P3 12-21 | P4 21-26",
        waiting: [0, 7, 10, 18],
        average: 8.75,
      },
      {
        name: "Priority, preemptive (no priorities given: all equal, so = FCFS)",
        result: priorityPreemptive(workload),
        gantt: "P1 0-8 | P2 8-12 | P3 12-21 | P4 21-26",
        waiting: [0, 7, 10, 18],
        average: 8.75,
      },
      {
        name: "Round Robin, quantum 2",
        result: roundRobin(workload, { quantum: 2 }),
        gantt:
          "P1 0-2 | P2 2-4 | P3 4-6 | P1 6-8 | P4 8-10 | P2 10-12 | P3 12-14 | " +
          "P1 14-16 | P4 16-18 | P3 18-20 | P1 20-22 | P4 22-23 | P3 23-26",
        waiting: [14, 7, 15, 15],
        average: 12.75,
      },
      {
        name: "Round Robin, quantum 4",
        result: roundRobin(workload, { quantum: 4 }),
        gantt: "P1 0-4 | P2 4-8 | P3 8-12 | P4 12-16 | P1 16-20 | P3 20-24 | P4 24-25 | P3 25-26",
        waiting: [12, 3, 15, 17],
        average: 11.75,
      },
    ];

    const round = (x) => Math.round(x * 100) / 100;
    console.log("Textbook workload: P1 (arrival 0, burst 8), P2 (1, 4), P3 (2, 9), P4 (3, 5). No context-switch cost.");

    let allMatch = true;
    const overview = [];
    for (const c of cases) {
      const r = c.result;
      const gantt = timelineText(r.timeline);
      const waiting = r.metrics.map((m) => m.waiting);
      const match =
        gantt === c.gantt &&
        JSON.stringify(waiting) === JSON.stringify(c.waiting) &&
        Math.abs(r.averages.waiting - c.average) < 1e-9;
      allMatch = allMatch && match;

      console.group(`${match ? "PASS" : "FAIL"}  ${c.name}`);
      console.log(`Gantt:     ${gantt}`);
      if (gantt !== c.gantt) console.log(`expected:  ${c.gantt}`);
      console.table(
        r.metrics.map((m) => ({
          PID: m.pid,
          Arrival: m.arrival,
          Burst: m.burst,
          Completion: m.completion,
          Turnaround: m.turnaround,
          Waiting: m.waiting,
          Response: m.response,
        }))
      );
      console.log(`Average waiting time: ${round(r.averages.waiting)} (hand calculation: ${c.average})`);
      console.groupEnd();

      overview.push({
        Algorithm: c.name,
        "Avg waiting (hand)": c.average,
        "Avg waiting (engine)": round(r.averages.waiting),
        "Avg turnaround": round(r.averages.turnaround),
        "Avg response": round(r.averages.response),
        Check: match ? "PASS" : "FAIL",
      });
    }

    console.table(overview);
    console.log(allMatch
      ? "All results match the hand calculations."
      : "Some results differ from the hand calculations: see the FAIL groups above.");
    return allMatch;
  }

  /* ==========================================================================
   * 10. PUBLIC INTERFACE
   * ======================================================================== */

  return Object.freeze({
    // The six algorithms: (processes, options) -> result
    fcfs,
    sjf,
    srtf,
    priorityNonPreemptive,
    priorityPreemptive,
    roundRobin,

    // Run any algorithm by id, or all of them
    simulate,
    compareAll,

    // Helpers
    validate,
    generateWorkload,
    timelineText,
    runTextbookTest,

    // Vocabulary and defaults
    STATE,
    CPU,
    EVENT,
    ALGORITHMS,
    ALGORITHM_ORDER,
    DEFAULT_OPTIONS,
    DEFAULT_CONVENTIONS,
  });
})();

// Lets the same file be loaded by Node.js for testing; ignored by browsers.
if (typeof module !== "undefined" && module.exports) module.exports = Engine;
