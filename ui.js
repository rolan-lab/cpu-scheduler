/* ============================================================================
 * ui.js: the user interface of the CS3608 CPU Scheduling Simulator
 * ============================================================================
 *
 * THE BIG IDEA
 *   engine.js computes the WHOLE run up front and returns a result: the
 *   timeline, the metrics, the events and one FRAME per tick. This file never
 *   schedules anything. Everything on screen is a function of two inputs:
 *
 *        (the engine's result, the current time)  ->  what is drawn
 *
 *   So the animation cannot disagree with the algorithm: the tokens, the CPU
 *   core, the ready queue, the Gantt chart, the narration, the log, the
 *   tables and the counters all read the same frame of the same result.
 *
 * DATA FLOW
 *   workload editor + scheduler settings
 *     -> rebuild()          calls Engine.simulate()            -> state.result
 *     -> build...()         creates the DOM pieces for that result, once
 *     -> the player clock   moves player.time (play, step, scrub)
 *     -> showFrame(f)       draws everything that changes once per tick
 *        drawContinuous(t)  draws what moves smoothly inside a tick
 *                           (the Gantt growth, the time cursor, the CPU ring)
 *
 * TIME
 *   player.time is a real number, for example 4.6 = 60% through tick 4.
 *   The frame on screen is floor(player.time): frame 4 describes the instant
 *   t = 4 and what the CPU does during [4, 5). When the time crosses 5, frame
 *   5 is shown and the tokens glide to their new zones.
 *
 * SECTIONS
 *    1. Constants             palette, presets, descriptions
 *    2. Helpers               DOM, numbers, animated counters
 *    3. State                 the workload, the options, the result, the player
 *    4. Workload editor       process table, presets, generator, JSON
 *    5. Scheduler settings    algorithm buttons, quantum, switch cost, aging
 *    6. Rebuild               validate, simulate, build every view
 *    7. Playback clock        play, pause, step, back, reset, scrub, speed
 *    8. Frame renderer        tokens, CPU core, narration, log, table, counters
 *    9. Continuous renderer   Gantt growth, time cursor, CPU progress ring
 *   10. Gantt chart           blocks, axis, tooltips
 *   11. Effects               flow arrows, CPU swap flash, particles
 *   12. Compare mode          bar charts, results table, schedules
 *   13. Start-up
 * ========================================================================== */

(function () {
  "use strict";

  /* ==========================================================================
   * 1. CONSTANTS
   * ======================================================================== */

  // Ten neon process colors, given out in this fixed order and never cycled,
  // which is why a workload has at most ten processes. They were checked with
  // a color-blindness validator: neighbouring slots stay distinguishable, and
  // the first five are distinct from each other in any combination. Every
  // token and Gantt block also shows its PID, so color is never the only cue.
  const PALETTE = [
    "#00E5FF", "#FF3DCB", "#B6FF3B", "#FF8A3D", "#8B7CFF",
    "#2DFFB0", "#FF5C7A", "#4D9BFF", "#FFD23F", "#D07BFF",
  ];
  const MAX_PROCESSES = PALETTE.length;

  const TOKEN = 44;              // token diameter in px (same as --token in style.css)
  const IDLE_CORE = "#4a5a78";   // CPU core color when idle
  const DONE_CORE = "#00e5ff";   // CPU core color when everything has finished
  const SPEED_MIN = 0.25;        // ticks per second, slider at 0
  const SPEED_MAX = 10;          // ticks per second, slider at 100
  const EASE_RATE = 9;           // how quickly a step eases to the next tick

  // Ink colors for text drawn on <canvas> (the same values as in style.css).
  const INK = { text: "#e4eeff", text2: "#a9badb", muted: "#7d8fb0" };
  const MONO = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "monospace";

  // Lower number = higher priority (the engine's default convention).
  const LOWER_IS_HIGHER = Engine.DEFAULT_CONVENTIONS.lowerNumberIsHigherPriority;

  const ALGO_INFO = {
    FCFS: "Non-preemptive. Serves processes in arrival order; each keeps the CPU until it finishes.",
    SJF: "Non-preemptive. Whenever the CPU is free, the ready process with the shortest burst goes next.",
    SRTF: "Preemptive SJF. The process with the least work left always runs; a shorter arrival preempts.",
    PRIO_NP: "Non-preemptive. Whenever the CPU is free, the best priority (lowest number) goes next.",
    PRIO_P: "Preemptive. A ready process with a strictly better priority takes the CPU at once.",
    RR: "Time slicing. Each process runs for at most one quantum, then rejoins the back of the queue.",
  };

  // One symbol per engine event type, for the event log.
  const EVENT_ICON = {
    ARRIVE: "+", CS_START: "⇄", DISPATCH: "▶", FIRST_RUN: "★", PREEMPT: "↩",
    QUANTUM_EXPIRE: "↻", QUANTUM_RENEW: "↻", AGE: "▲", PRIORITY_RESET: "▼",
    COMPLETE: "✓", IDLE: "○", FINISH: "■",
  };

  // Ready-made workloads: [pid, arrival, burst, priority].
  const PRESETS = [
    {
      id: "textbook",
      label: "Textbook: P1 to P4",
      processes: [["P1", 0, 8, 3], ["P2", 1, 4, 1], ["P3", 2, 9, 4], ["P4", 3, 5, 2]],
    },
    {
      id: "convoy",
      label: "Convoy effect (FCFS)",
      processes: [["P1", 0, 24, 2], ["P2", 1, 3, 1], ["P3", 2, 3, 3]],
      options: { algorithm: "FCFS" },
    },
    {
      id: "rr",
      label: "Round Robin, quantum 4",
      processes: [["P1", 0, 24, 1], ["P2", 0, 3, 1], ["P3", 0, 3, 1]],
      options: { algorithm: "RR", quantum: 4 },
    },
    {
      id: "aging",
      label: "Priority with aging",
      processes: [["P1", 0, 11, 1], ["P2", 1, 2, 4], ["P3", 2, 2, 3]],
      options: { algorithm: "PRIO_NP", aging: { enabled: true, every: 5, by: 1 } },
    },
    {
      id: "switches",
      label: "Idle gaps + context switches",
      processes: [["P1", 0, 3, 2], ["P2", 1, 2, 1], ["P3", 8, 4, 3], ["P4", 9, 1, 2]],
      options: { algorithm: "SRTF", contextSwitch: 1 },
    },
  ];

  // The four metrics of the Compare charts. All of them: lower is better.
  const COMPARE_METRICS = {
    waiting: { label: "Average waiting time", get: (r) => r.averages.waiting, integer: false },
    turnaround: { label: "Average turnaround time", get: (r) => r.averages.turnaround, integer: false },
    response: { label: "Average response time", get: (r) => r.averages.response, integer: false },
    switches: { label: "Context switches", get: (r) => r.summary.switches, integer: true },
  };

  // What each algorithm sorts the ready queue by. It is shown above the ready
  // lane, under every token and in the decision card, so the audience can see
  // the rule the scheduler applies, not only its result.
  //   fifo     the queue is not sorted: the head goes first (FCFS, RR)
  //   value    the number compared (smaller = picked first)
  //   caption  how that number is written under a token
  const PICK_RULE = {
    FCFS: { fifo: true, lane: "first come, first served", value: (p, i) => i.arrival, caption: (p, i) => `arrived ${i.arrival}` },
    SJF: { fifo: false, lane: "sorted by burst, shortest first", value: (p, i) => i.burst, caption: (p, i) => `burst ${i.burst}` },
    SRTF: { fifo: false, lane: "sorted by remaining time, least first", value: (p) => p.remaining, caption: (p) => `${p.remaining} left` },
    PRIO_NP: { fifo: false, priority: true, lane: "sorted by priority, 0 = best", value: (p) => p.priority, caption: (p) => `pri ${p.priority}` },
    PRIO_P: { fifo: false, priority: true, lane: "sorted by priority, 0 = best", value: (p) => p.priority, caption: (p) => `pri ${p.priority}` },
    RR: { fifo: true, lane: "first in, first out, one quantum each", value: (p, i) => i.arrival, caption: (p) => `${p.remaining} left` },
  };

  // Scrubber markers: the instants where the scheduler acted. When several
  // events happen at one instant, the first type in this list is shown.
  const MARKER_TYPES = [
    { type: "PREEMPT", cls: "is-preempt", glyph: "↩", label: "Preemption" },
    { type: "QUANTUM_EXPIRE", cls: "is-quantum", glyph: "↻", label: "Quantum expired" },
    { type: "COMPLETE", cls: "is-complete", glyph: "✓", label: "Completion" },
    { type: "CS_START", cls: "is-switch", glyph: "⇄", label: "Context switch" },
    { type: "DISPATCH", cls: "is-dispatch", glyph: "▶", label: "Dispatch" },
    { type: "ARRIVE", cls: "is-arrive", glyph: "+", label: "Arrival" },
  ];

  // Vertical layout of the Gantt track (px): the CPU row and its time axis on
  // top, then one lane per process.
  const GANTT_ROWS = { cpuTop: 10, cpuHeight: 58, laneTop: 100, laneHeight: 20, laneGap: 8 };

  /* ==========================================================================
   * 2. HELPERS
   * ======================================================================== */

  const $ = (id) => document.getElementById(id);

  // Creates an element. Text always goes in through textContent, never as
  // HTML, so a PID typed by the user can never inject markup.
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svgEl(tag, attrs) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
  }

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);
  const pad2 = (n) => String(n).padStart(2, "0");

  // Numbers as shown everywhere: whole numbers as they are, others with 2 decimals.
  function fmt(x) {
    if (x === null || x === undefined || !Number.isFinite(x)) return "-";
    return Number.isInteger(x) ? String(x) : x.toFixed(2);
  }
  const pct = (x) => (x === null || !Number.isFinite(x) ? "-" : `${(x * 100).toFixed(1)}%`);

  // Engine notes use "->"; on screen an arrow reads better.
  const prettyNote = (note) => note.replace(/->/g, "→");

  // "P2 arrives (...)" -> "arrives (...)" when a P2 chip is already shown in front.
  function withoutLeadingPid(text, pid) {
    return pid && text.startsWith(pid + " ") ? text.slice(pid.length + 1) : text;
  }

  // PIDs sorted naturally (P2 before P10), for display order only.
  const byPid = (a, b) => a.localeCompare(b, "en", { numeric: true });

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const reducedMotion = () => motionQuery.matches;

  // Restarts a CSS animation by removing its class, forcing a layout, and
  // adding the class again. Works for HTML and SVG elements.
  function restartAnimation(node, className) {
    node.classList.remove(className);
    node.getBoundingClientRect();
    node.classList.add(className);
  }

  // A node's box relative to another node (used to place tokens and arrows).
  function relRect(node, origin) {
    const a = node.getBoundingClientRect();
    const o = origin.getBoundingClientRect();
    const x = a.left - o.left;
    const y = a.top - o.top;
    return { x, y, w: a.width, h: a.height, right: x + a.width, bottom: y + a.height, cx: x + a.width / 2, cy: y + a.height / 2 };
  }

  // A colored PID chip (dot + PID). Its color comes from the process, and
  // clicking it follows that process (section 8b).
  function chip(pid) {
    const node = el("span", "pid-chip", pid);
    node.style.setProperty("--c", colorOf(pid));
    node.dataset.follow = pid;
    return node;
  }

  // Follow keys: every element that belongs to a process carries
  // data-pids="p0 p2" (its processes' positions in the workload). One CSS
  // rule can then dim everything that does NOT mention the followed process.
  // Positions are used instead of PIDs so that any PID text is safe in CSS.
  let followKeys = new Map(); // pid -> "p0", "p1", ...
  function keysOf(...pids) {
    return pids.filter((pid) => pid && followKeys.has(pid)).map((pid) => followKeys.get(pid)).join(" ");
  }

  /* ---- Animated counters --------------------------------------------------
   * setCounter(c, value) makes the displayed number glide to the new value
   * over COUNTER_MS. updateCounters() is called by the animation loop.
   * ------------------------------------------------------------------------ */
  const COUNTER_MS = 650;
  const allCounters = [];

  function createCounter(node, format) {
    const counter = { node, format, shown: null, from: 0, to: null, startedAt: 0 };
    allCounters.push(counter);
    return counter;
  }

  function setCounter(counter, value) {
    if (value === counter.to) return;
    counter.to = value;
    if (value === null) {
      counter.shown = null;
      counter.node.textContent = "-";
      return;
    }
    counter.from = counter.shown === null ? 0 : counter.shown;
    counter.startedAt = performance.now();
    if (reducedMotion()) {
      counter.shown = value;
      counter.node.textContent = counter.format(value);
    }
  }

  function updateCounters(now) {
    for (const c of allCounters) {
      if (c.to === null || c.shown === c.to) continue;
      const p = clamp((now - c.startedAt) / COUNTER_MS, 0, 1);
      c.shown = p >= 1 ? c.to : c.from + (c.to - c.from) * easeOutCubic(p);
      c.node.textContent = c.format(c.shown);
    }
  }

  /* ==========================================================================
   * 3. STATE
   * ======================================================================== */

  const state = {
    // The workload exactly as typed (strings), plus each process's color.
    processes: [],
    // The scheduler settings (numbers; NaN when a box holds no valid number).
    options: {
      algorithm: "SRTF",
      quantum: 2,
      contextSwitch: 0,
      aging: { enabled: false, every: 5, by: 1 },
    },
    result: null,       // Engine.simulate(...) for the workload above, or null if invalid
    compare: null,      // Engine.compareAll(...), filled when Compare mode is open
    errors: [],         // validation problems from Engine.validate
    notice: "",         // a one-off message (for example a failed import)
    mode: "simulate",   // "simulate" or "compare"
    colors: new Map(),  // pid -> color
    followed: null,     // the PID being followed (section 8b), or null
  };

  // The playback clock (section 7).
  const player = {
    time: 0,          // the time on screen, a real number in [0, makespan]
    target: 0,        // where a step / step-back is easing to
    playing: false,
    speed: 1.5,       // ticks per second
    frame: -1,        // the frame currently drawn (= floor(time))
    lastTs: null,     // timestamp of the previous animation frame
  };

  // Every element the code touches, looked up once.
  const dom = {
    procBody: $("procBody"), procCount: $("procCount"), btnAdd: $("btnAdd"),
    presetSelect: $("presetSelect"), genCount: $("genCount"), genSeed: $("genSeed"),
    btnGenerate: $("btnGenerate"), btnDice: $("btnDice"), btnExport: $("btnExport"),
    btnImport: $("btnImport"), fileImport: $("fileImport"), errors: $("errors"),
    algoGrid: $("algoGrid"), algoDesc: $("algoDesc"), fieldQuantum: $("fieldQuantum"),
    optQuantum: $("optQuantum"), optSwitch: $("optSwitch"), fieldAging: $("fieldAging"),
    optAging: $("optAging"), optAgingEvery: $("optAgingEvery"), optAgingBy: $("optAgingBy"),
    teleAlgo: $("teleAlgo"), teleClock: $("teleClock"), teleStatus: $("teleStatus"),
    teleStatusText: $("teleStatusText"), tabSimulate: $("tabSimulate"), tabCompare: $("tabCompare"),
    viewSimulate: $("viewSimulate"), viewCompare: $("viewCompare"),
    stage: $("stage"), stageMeta: $("stageMeta"), flow: $("flow"), flowPaths: $("flowPaths"),
    zoneNew: $("zoneNew"), zoneReady: $("zoneReady"), zoneDone: $("zoneDone"),
    cpu: $("cpu"), cpuCell: document.querySelector(".cpu-cell"), cpuStatus: $("cpuStatus"),
    cpuDetail: $("cpuDetail"), tokens: $("tokens"), fx: $("fx"), stageError: $("stageError"),
    narration: $("narration"), narrTime: $("narrTime"), narrLines: $("narrLines"),
    btnReset: $("btnReset"), btnBack: $("btnBack"), btnPlay: $("btnPlay"), btnStep: $("btnStep"),
    scrub: $("scrub"), scrubNow: $("scrubNow"), scrubMax: $("scrubMax"),
    speed: $("speed"), speedOut: $("speedOut"),
    mWait: $("mWait"), mTat: $("mTat"), mResp: $("mResp"), mUtil: $("mUtil"),
    mDone: $("mDone"), mSwitch: $("mSwitch"), mWaitSub: $("mWaitSub"), mTatSub: $("mTatSub"),
    mRespSub: $("mRespSub"), mDoneSub: $("mDoneSub"),
    ganttScroll: $("ganttScroll"), ganttTrack: $("ganttTrack"),
    liveBody: $("liveBody"), footTat: $("footTat"), footWait: $("footWait"), footResp: $("footResp"),
    log: $("log"), logCount: $("logCount"),
    compareMeta: $("compareMeta"), compareBody: $("compareBody"), schedules: $("schedules"),
    charts: document.querySelector(".charts"), tooltip: $("tooltip"),
    decision: $("decision"), readyRule: $("readyRule"),
    scrubMarkers: $("scrubMarkers"), btnPrevEvent: $("btnPrevEvent"), btnNextEvent: $("btnNextEvent"),
    ganttLabels: $("ganttLabels"), ganttCounters: $("ganttCounters"), lifeline: $("lifeline"),
  };

  const counters = {
    waiting: createCounter(dom.mWait, fmt),
    turnaround: createCounter(dom.mTat, fmt),
    response: createCounter(dom.mResp, fmt),
    utilization: createCounter(dom.mUtil, pct),
    finished: createCounter(dom.mDone, (x) => String(Math.round(x))),
    switches: createCounter(dom.mSwitch, (x) => String(Math.round(x))),
  };

  const colorOf = (pid) => state.colors.get(pid) || "#8aa0c4";
  const makespan = () => (state.result ? state.result.summary.makespan : 0);

  // The static facts of each process (arrival, burst, base priority), by PID.
  let infoCache = { result: null, map: new Map() };
  function processInfo() {
    if (infoCache.result !== state.result) {
      infoCache = { result: state.result, map: new Map(state.result.processes.map((p) => [p.pid, p])) };
    }
    return infoCache.map;
  }

  /* ==========================================================================
   * 4. WORKLOAD EDITOR
   * ======================================================================== */

  const FIELDS = [
    { key: "pid", label: "PID", type: "text" },
    { key: "arrival", label: "arrival time", type: "number", min: 0 },
    { key: "burst", label: "burst time", type: "number", min: 1 },
    { key: "priority", label: "priority", type: "number", min: 0, placeholder: "1" },
  ];

  // Text from a number box -> a number. An empty box becomes NaN, so the
  // engine reports "must be a whole number" instead of silently using 0.
  function toNumber(text) {
    const s = String(text).trim();
    return s === "" ? NaN : Number(s);
  }

  // The workload in the shape the engine expects.
  function engineWorkload() {
    return state.processes.map((p) => ({
      pid: String(p.pid).trim(),
      arrival: toNumber(p.arrival),
      burst: toNumber(p.burst),
      priority: String(p.priority).trim() === "" ? undefined : toNumber(p.priority),
    }));
  }

  // Replaces the workload. Colors are given out in palette order.
  function setWorkload(list) {
    state.processes = list.slice(0, MAX_PROCESSES).map((p, i) => ({
      pid: String(p.pid ?? `P${i + 1}`),
      arrival: String(p.arrival ?? ""),
      burst: String(p.burst ?? ""),
      priority: p.priority === undefined || p.priority === null ? "" : String(p.priority),
      color: PALETTE[i],
    }));
    renderWorkloadTable();
  }

  function renderWorkloadTable() {
    const rows = state.processes.map((p, i) => {
      const tr = el("tr");

      const swatchCell = el("td");
      const swatch = el("span", "swatch");
      swatch.style.setProperty("--c", p.color);
      swatchCell.append(swatch);
      tr.append(swatchCell);

      for (const f of FIELDS) {
        const td = el("td");
        const input = el("input");
        input.type = f.type;
        input.value = p[f.key];
        input.dataset.index = String(i);
        input.dataset.field = f.key;
        input.setAttribute("aria-label", `${f.label} of ${p.pid || `row ${i + 1}`}`);
        if (f.type === "number") {
          input.min = String(f.min);
          input.step = "1";
          input.inputMode = "numeric";
        } else {
          input.maxLength = 12;
          input.spellcheck = false;
          input.autocomplete = "off";
        }
        if (f.placeholder) input.placeholder = f.placeholder;
        td.append(input);
        tr.append(td);
      }

      const removeCell = el("td");
      const remove = el("button", "row-remove", "×");
      remove.type = "button";
      remove.dataset.remove = String(i);
      remove.disabled = state.processes.length <= 1;
      remove.setAttribute("aria-label", `Remove ${p.pid || `row ${i + 1}`}`);
      removeCell.append(remove);
      tr.append(removeCell);
      return tr;
    });
    dom.procBody.replaceChildren(...rows);
    dom.procCount.textContent = `${state.processes.length} / ${MAX_PROCESSES}`;
    dom.btnAdd.disabled = state.processes.length >= MAX_PROCESSES;
  }

  function nextFreePid() {
    const used = new Set(state.processes.map((p) => String(p.pid).trim().toUpperCase()));
    let n = 1;
    while (used.has(`P${n}`)) n++;
    return `P${n}`;
  }

  function addProcess() {
    if (state.processes.length >= MAX_PROCESSES) return;
    const usedColors = new Set(state.processes.map((p) => p.color));
    const lastArrival = Math.max(0, ...state.processes.map((p) => toNumber(p.arrival) || 0));
    state.processes.push({
      pid: nextFreePid(),
      arrival: String(lastArrival + 1),
      burst: "4",
      priority: "2",
      color: PALETTE.find((c) => !usedColors.has(c)), // survivors keep their colors
    });
    renderWorkloadTable();
    rebuild();
  }

  function loadPreset(id) {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setWorkload(preset.processes.map(([pid, arrival, burst, priority]) => ({ pid, arrival, burst, priority })));
    applyOptions(Object.assign(
      { quantum: 2, contextSwitch: 0, aging: { enabled: false, every: 5, by: 1 } },
      preset.options
    ));
    rebuild();
  }

  // Random workload from the engine's seeded generator (same seed = same workload).
  function generate(seed) {
    const count = clamp(Math.round(toNumber(dom.genCount.value)) || 5, 2, MAX_PROCESSES);
    const s = Number.isInteger(seed) ? seed : Math.round(toNumber(dom.genSeed.value)) || 0;
    dom.genCount.value = String(count);
    dom.genSeed.value = String(s);
    setWorkload(Engine.generateWorkload({ count, seed: s, maxArrival: 10, maxBurst: 9, maxPriority: 5 }));
    rebuild();
  }

  function exportJson() {
    const o = currentOptions();
    const data = {
      format: "cs3608-scheduler",
      version: 1,
      processes: engineWorkload().map((p) =>
        p.priority === undefined ? { pid: p.pid, arrival: p.arrival, burst: p.burst } : p),
      options: { algorithm: o.algorithm, quantum: o.quantum, contextSwitch: o.contextSwitch, aging: o.aging },
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = el("a");
    link.href = url;
    link.download = "workload.json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importJson(file) {
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data && data.processes;
      if (!Array.isArray(list) || list.length === 0) throw new Error("the file has no list of processes");
      if (list.length > MAX_PROCESSES) throw new Error(`at most ${MAX_PROCESSES} processes are supported`);
      setWorkload(list.map((p) => ({ pid: p.pid, arrival: p.arrival, burst: p.burst, priority: p.priority })));
      if (data.options && typeof data.options === "object") applyOptions(data.options);
      state.notice = `Imported ${list.length} processes from ${file.name}.`;
    } catch (err) {
      state.notice = `Import failed: ${err.message}.`;
    }
    rebuild();
  }

  /* ==========================================================================
   * 5. SCHEDULER SETTINGS
   * ======================================================================== */

  function buildAlgoButtons() {
    for (const id of Engine.ALGORITHM_ORDER) {
      const btn = el("button", "algo-btn", Engine.ALGORITHMS[id].short);
      btn.type = "button";
      btn.dataset.algo = id;
      btn.title = Engine.ALGORITHMS[id].name;
      btn.setAttribute("role", "radio");
      dom.algoGrid.append(btn);
    }
  }

  function selectAlgorithm(id) {
    state.options.algorithm = id;
    syncSchedulerControls();
    rebuild();
  }

  // Enables only the settings the chosen algorithm uses.
  function syncSchedulerControls() {
    const o = state.options;
    const rule = Engine.ALGORITHMS[o.algorithm];
    for (const btn of dom.algoGrid.children) {
      const on = btn.dataset.algo === o.algorithm;
      btn.setAttribute("aria-checked", String(on));
      btn.tabIndex = on ? 0 : -1;
    }
    dom.algoDesc.textContent = ALGO_INFO[o.algorithm];
    dom.fieldQuantum.classList.toggle("is-off", !rule.usesQuantum);
    dom.optQuantum.disabled = !rule.usesQuantum;
    dom.fieldAging.disabled = !rule.usesPriority;
    dom.teleAlgo.textContent = rule.short;
  }

  // state.options -> the input boxes (after a preset or an import).
  function writeSchedulerInputs() {
    const o = state.options;
    dom.optQuantum.value = Number.isFinite(o.quantum) ? String(o.quantum) : "";
    dom.optSwitch.value = Number.isFinite(o.contextSwitch) ? String(o.contextSwitch) : "";
    dom.optAging.checked = Boolean(o.aging.enabled);
    dom.optAgingEvery.value = Number.isFinite(o.aging.every) ? String(o.aging.every) : "";
    dom.optAgingBy.value = Number.isFinite(o.aging.by) ? String(o.aging.by) : "";
  }

  // The input boxes -> state.options (while the user types).
  function readSchedulerInputs() {
    const o = state.options;
    o.quantum = toNumber(dom.optQuantum.value);
    o.contextSwitch = toNumber(dom.optSwitch.value);
    o.aging = {
      enabled: dom.optAging.checked,
      every: toNumber(dom.optAgingEvery.value),
      by: toNumber(dom.optAgingBy.value),
    };
  }

  function applyOptions(options) {
    const o = state.options;
    // only the six real ids: a plain ALGORITHMS[name] lookup would also accept "toString"
    if (Engine.ALGORITHM_ORDER.includes(options.algorithm)) o.algorithm = options.algorithm;
    if (options.quantum !== undefined) o.quantum = Number(options.quantum);
    if (options.contextSwitch !== undefined) o.contextSwitch = Number(options.contextSwitch);
    if (options.aging && typeof options.aging === "object") {
      o.aging = {
        enabled: Boolean(options.aging.enabled ?? o.aging.enabled),
        every: Number(options.aging.every ?? o.aging.every),
        by: Number(options.aging.by ?? o.aging.by),
      };
    }
    writeSchedulerInputs();
    syncSchedulerControls();
  }

  // The options in the shape the engine expects.
  function currentOptions() {
    const o = state.options;
    return {
      algorithm: o.algorithm,
      quantum: o.quantum,
      contextSwitch: o.contextSwitch,
      aging: { enabled: o.aging.enabled, every: o.aging.every, by: o.aging.by },
    };
  }

  /* ==========================================================================
   * 6. REBUILD: validate, simulate, and build every view for the new result
   * ======================================================================== */

  let rebuildTimer = 0;

  // While the user types, wait a moment so every keystroke doesn't restart the run.
  function scheduleRebuild() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuild, 320);
  }

  function rebuild() {
    clearTimeout(rebuildTimer);
    const workload = engineWorkload();
    const options = currentOptions();

    state.colors = new Map(state.processes.map((p) => [String(p.pid).trim(), p.color]));
    state.errors = Engine.validate(workload, options);
    state.compare = null;
    player.playing = false;
    player.frame = -1;
    hideTooltip();

    if (state.errors.length > 0) {
      state.result = null;
      showProblems();
      enterErrorState();
      return;
    }

    // The ONLY place the simulation runs. Everything below just draws it.
    state.result = Engine.simulate(workload, options);
    followKeys = new Map(state.result.processes.map((p, i) => [p.pid, `p${i}`]));
    if (!followKeys.has(state.followed)) state.followed = null; // its process was removed or renamed

    showProblems();
    dom.stageError.hidden = true;
    buildStage();
    buildGantt();
    buildLog();
    buildLiveTable();
    setupScrubber();
    buildMarkers();
    seek(0, true);
    applyFollow(); // the new elements pick up the spotlight
    if (state.mode === "compare") buildCompare();
  }

  function showProblems() {
    const items = [];
    if (state.notice) items.push(state.notice);
    items.push(...state.errors);
    state.notice = "";
    dom.errors.replaceChildren(...items.map((text) => el("li", "", text)));
  }

  // Invalid workload: clear the views and say why, instead of showing stale results.
  function enterErrorState() {
    dom.tokens.replaceChildren();
    tokens.clear();
    dom.ganttTrack.replaceChildren();
    gantt.blocks = [];
    gantt.ticks = [];
    dom.log.replaceChildren();
    logItems = [];
    dom.logCount.textContent = "";
    dom.liveBody.replaceChildren();
    liveRows = new Map();
    dom.footTat.textContent = dom.footWait.textContent = dom.footResp.textContent = "-";
    gantt.lanes = [];
    dom.ganttLabels.replaceChildren();
    dom.ganttCounters.replaceChildren();
    markers = [];
    dom.scrubMarkers.replaceChildren();
    dom.decision.replaceChildren();
    dom.readyRule.textContent = "";
    state.followed = null;
    followStyle.textContent = "";
    document.body.classList.remove("following");
    dom.lifeline.classList.remove("is-on");
    dom.lifeline.replaceChildren();

    dom.stageError.hidden = false;
    const more = state.errors.length > 1 ? `…and ${state.errors.length - 1} more (see the Workload panel).` : "";
    dom.stageError.replaceChildren(
      el("strong", "", "The workload needs fixing before it can run"),
      el("span", "", state.errors[0]),
      el("span", "", more)
    );

    dom.cpu.dataset.kind = "idle";
    dom.cpu.style.setProperty("--core", IDLE_CORE);
    dom.cpu.style.setProperty("--prog", "0");
    dom.cpuStatus.textContent = "Offline";
    dom.cpuDetail.textContent = "waiting for a valid workload";
    dom.narrTime.textContent = "t = -";
    dom.narrLines.replaceChildren(el("li", "", "Fix the workload to run the simulation."));
    dom.teleClock.textContent = "T+-- / --";
    dom.stageMeta.textContent = "";
    for (const c of Object.values(counters)) setCounter(c, null);
    updateTransport();
    if (state.mode === "compare") buildCompare();
  }

  /* ==========================================================================
   * 7. PLAYBACK CLOCK
   *
   * One requestAnimationFrame loop drives everything:
   *   playing      -> time moves forward at `speed` ticks per second
   *   step / back  -> time eases toward the next / previous whole tick
   *   scrub/reset  -> time jumps (the tokens still glide to their new places)
   * Whenever floor(time) changes, showFrame() draws the new frame.
   * ======================================================================== */

  function play() {
    if (!state.result) return;
    if (player.time >= makespan()) seek(0, false); // at the end: replay from the start
    player.playing = true;
    updateTransport();
  }

  function pause() {
    player.playing = false;
    player.target = player.time;
    updateTransport();
  }

  function togglePlay() {
    if (player.playing) pause();
    else play();
  }

  function stepForward() {
    if (!state.result) return;
    const from = player.playing ? player.time : player.target;
    pause();
    player.target = Math.min(makespan(), Math.floor(from + 1e-6) + 1);
    if (reducedMotion()) player.time = player.target;
    updateTransport();
  }

  function stepBack() {
    if (!state.result) return;
    const from = player.playing ? player.time : player.target;
    pause();
    player.target = Math.max(0, Math.ceil(from - 1e-6) - 1);
    if (reducedMotion()) player.time = player.target;
    updateTransport();
  }

  function resetPlayback() {
    pause();
    seek(0, false);
  }

  /* ---- Event markers on the scrubber -----------------------------------------
   * A scheduler only acts at events: an arrival, a completion, an expired
   * quantum, a preemption. Each instant with such an event gets a marker, so
   * the timeline shows where the decisions are (dense for RR, sparse for
   * FCFS), and the jump buttons go straight to the next or previous one.
   * ------------------------------------------------------------------------ */

  let markers = []; // [{ t, node }]

  const markerTypeOf = (frame) => MARKER_TYPES.find((m) => frame.events.some((e) =>
    e.type === m.type && !(e.type === "DISPATCH" && e.note.startsWith("Context switch finished"))));

  function buildMarkers() {
    markers = [];
    for (const frame of state.result.frames) {
      const type = markerTypeOf(frame);
      if (!type) continue;
      const node = el("button", `scrub-marker ${type.cls}`, type.glyph);
      node.type = "button";
      node.tabIndex = -1; // keyboard users have the jump buttons and Shift + arrows
      node.dataset.t = String(frame.t);
      node.setAttribute("aria-label", `${type.label} at t = ${frame.t}`);
      markers.push({ t: frame.t, node });
    }
    dom.scrubMarkers.replaceChildren(...markers.map((m) => m.node));
    layoutMarkers();
  }

  // Lines each marker up with the slider position of its time.
  function layoutMarkers() {
    const width = dom.scrub.clientWidth;
    const end = makespan();
    if (!width || !end) return;
    const thumb = 8; // half the slider thumb: where the track really starts and ends
    const perTick = (width - thumb * 2) / end;
    dom.scrubMarkers.classList.toggle("dense", perTick < 11); // too tight for symbols: ticks only
    for (const m of markers) m.node.style.left = `${(thumb + m.t * perTick).toFixed(1)}px`;
  }

  function markerTooltip(t) {
    const frame = state.result.frames[t];
    const parts = [el("div", "tip-title", `t = ${t}`)];
    for (const e of frame.events.filter((ev) => ev.type !== "FIRST_RUN").slice(0, 5)) {
      const row = el("div", "tip-row");
      if (e.pid) row.append(chip(e.pid));
      row.append(document.createTextNode(withoutLeadingPid(prettyNote(e.note), e.pid)));
      parts.push(row);
    }
    return parts;
  }

  // direction +1 = next event, -1 = previous event.
  function jumpToEvent(direction) {
    if (!state.result) return;
    const now = Math.floor((player.playing ? player.time : player.target) + 1e-9);
    const target = direction > 0
      ? markers.find((m) => m.t > now)
      : [...markers].reverse().find((m) => m.t < now);
    if (!target) return;
    pause();
    seek(target.t, false);
  }

  // Jumps to time t. With instant = true the tokens are placed without
  // gliding (used when a brand-new result is shown).
  function seek(t, instant) {
    if (!state.result) return;
    player.time = player.target = clamp(t, 0, makespan());
    if (instant) dom.tokens.classList.add("no-anim");
    showFrame(Math.floor(player.time + 1e-9), false);
    drawContinuous(player.time);
    if (instant) {
      dom.tokens.getBoundingClientRect();
      dom.tokens.classList.remove("no-anim");
    }
    updateTransport();
  }

  function setupScrubber() {
    dom.scrub.max = String(makespan());
    dom.scrubMax.textContent = String(makespan());
  }

  // Slider 0..100 -> 0.25..10 ticks per second, on a log scale.
  function onSpeedInput() {
    const v = Number(dom.speed.value) / 100;
    player.speed = SPEED_MIN * Math.pow(SPEED_MAX / SPEED_MIN, v);
    dom.speedOut.textContent = `${player.speed < 1 ? player.speed.toFixed(2) : player.speed.toFixed(1)} ticks/s`;
    setRangeFill(dom.speed);
  }

  function setRangeFill(input) {
    const min = Number(input.min);
    const max = Number(input.max);
    const share = max > min ? (Number(input.value) - min) / (max - min) : 0;
    input.style.setProperty("--fill", `${(share * 100).toFixed(2)}%`);
  }

  function updateTransport() {
    const ok = Boolean(state.result);
    const end = makespan();
    dom.btnPlay.classList.toggle("is-playing", player.playing);
    dom.btnPlay.setAttribute("aria-label", player.playing ? "Pause" : "Play");
    dom.btnPlay.disabled = !ok;
    dom.btnReset.disabled = !ok;
    dom.btnBack.disabled = !ok || (player.target <= 0 && player.time <= 0);
    dom.btnStep.disabled = !ok || (!player.playing && player.target >= end);
    dom.scrub.disabled = !ok;
    const now = Math.floor((player.playing ? player.time : player.target) + 1e-9);
    dom.btnNextEvent.disabled = !ok || !markers.some((m) => m.t > now);
    dom.btnPrevEvent.disabled = !ok || !markers.some((m) => m.t < now);

    let status = "paused";
    let label = "Paused";
    if (!ok) { status = "error"; label = "Input error"; }
    else if (player.playing) { status = "playing"; label = "Playing"; }
    else if (player.time >= end) { status = "done"; label = "Complete"; }
    dom.teleStatus.dataset.status = status;
    dom.teleStatusText.textContent = label;
  }

  function loop(ts) {
    const dt = player.lastTs === null ? 0 : Math.min(0.1, (ts - player.lastTs) / 1000);
    player.lastTs = ts;

    if (state.result) {
      const end = makespan();
      if (player.playing) {
        player.time = Math.min(end, player.time + dt * player.speed);
        player.target = player.time;
        if (player.time >= end) {
          player.playing = false;
          updateTransport();
        }
      } else if (player.time !== player.target) {
        // ease toward the target tick (exponential ease-out)
        const diff = player.target - player.time;
        player.time = Math.abs(diff) < 0.004 || reducedMotion()
          ? player.target
          : player.time + diff * Math.min(1, dt * EASE_RATE);
      }

      const frame = Math.min(end, Math.floor(player.time + 1e-9));
      if (frame !== player.frame) showFrame(frame, frame === player.frame + 1);
      if (state.mode === "simulate") drawContinuous(player.time);
    }

    updateCounters(ts);
    stepParticles(dt);
    updateCharts(ts);
    requestAnimationFrame(loop);
  }

  function onKeyDown(e) {
    if (e.key === "Escape" && state.followed) { setFollow(null); return; } // works from anywhere
    if (state.mode !== "simulate" || e.altKey || e.ctrlKey || e.metaKey) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON") return;
    if (e.key === " ") { e.preventDefault(); togglePlay(); }
    else if (e.key === "ArrowRight" && e.shiftKey) { e.preventDefault(); jumpToEvent(1); }
    else if (e.key === "ArrowLeft" && e.shiftKey) { e.preventDefault(); jumpToEvent(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); stepForward(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); stepBack(); }
    else if (e.key === "Home") { e.preventDefault(); resetPlayback(); }
  }

  /* ==========================================================================
   * 8. FRAME RENDERER: everything that changes once per tick
   * ======================================================================== */

  function showFrame(f, forward) {
    const r = state.result;
    const frame = r.frames[f];
    const previous = player.frame >= 0 ? r.frames[player.frame] : null;
    player.frame = f;

    placeTokens(frame);
    renderCpu(frame);
    renderNarration(frame);
    renderDecision(frame);
    renderLaneCounters(frame);
    renderLifeline(frame);
    renderLog(frame, forward);
    renderLiveTable(frame, forward);
    renderCounters(frame);
    renderClock(frame);
    updateTransport();
    if (forward && !reducedMotion()) playEffects(frame, previous);
  }

  /* ---- Tokens: one per process, gliding between the zones ---------------- */

  const tokens = new Map(); // pid -> { node, badge, sub }
  let lastLayout = new Map(); // pid -> the spot used in the last frame

  function buildStage() {
    dom.tokens.replaceChildren();
    tokens.clear();
    for (const p of state.result.processes) {
      const node = el("div", "token");
      node.style.setProperty("--c", colorOf(p.pid));
      node.dataset.pids = keysOf(p.pid);
      node.dataset.follow = p.pid;
      node.title = `Click to follow ${p.pid}`;
      const sub = el("span", "token-sub"); // the value the algorithm compares
      node.append(el("span", "token-pid", p.pid), sub);
      dom.tokens.append(node);
      tokens.set(p.pid, { node, sub });
    }
    // name the rule the ready queue is ordered by
    dom.readyRule.textContent = PICK_RULE[state.result.algorithm].lane;
    resizeFx();
    drawFlow();
  }

  // Where every token should be for this frame: { x, y, scale } in stage pixels.
  //   NEW         grid in the NEW zone, next to arrive first
  //   READY       a horizontal lane; the HEAD of the queue sits nearest the CPU
  //   switching   at the CPU's "door", while a context switch loads it
  //   RUNNING     docked in the CPU core
  //   TERMINATED  grid in the TERMINATED zone, in completion order
  function computeLayout(frame) {
    const info = processInfo();
    const zNew = relRect(dom.zoneNew, dom.stage);
    const zReady = relRect(dom.zoneReady, dom.stage);
    const zDone = relRect(dom.zoneDone, dom.stage);
    const cpu = relRect(dom.cpu, dom.stage);
    const spots = new Map();

    const notArrived = frame.procs
      .filter((p) => p.state === "NEW")
      .sort((a, b) => info.get(a.pid).arrival - info.get(b.pid).arrival || byPid(a.pid, b.pid));
    packGrid(zNew, notArrived.map((p) => p.pid), spots);

    laneLayout(zReady, frame.readyQueue, spots);

    const finished = frame.procs
      .filter((p) => p.state === "TERMINATED")
      .sort((a, b) => a.completion - b.completion || byPid(a.pid, b.pid));
    packGrid(zDone, finished.map((p) => p.pid), spots);

    for (const p of frame.procs) {
      if (p.state === "RUNNING") spots.set(p.pid, { x: cpu.cx, y: cpu.cy, scale: 1.3 });
      else if (p.switchingIn) spots.set(p.pid, Object.assign(doorPoint(zReady, cpu), { scale: 0.95 }));
    }
    return spots;
  }

  // Below this size a token drops its caption (it would be too small to read).
  const COMPACT_BELOW = 0.8;

  // Tokens in rows and columns inside a zone. Every column count is tried and
  // the one that lets the tokens be biggest wins. If they must shrink a lot,
  // the captions are dropped so the tokens themselves can stay larger.
  function packGrid(box, pids, spots) {
    const n = pids.length;
    if (n === 0) return;
    const padTop = 32;
    const padBottom = 10;
    const availW = box.w - 20;
    const availH = box.h - padTop - padBottom;
    const cellW = TOKEN + 16;

    const bestFit = (cellH) => {
      let best = { cols: 1, scale: 0, cellH };
      for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        const scale = Math.min(1, availW / (cols * cellW), availH / (rows * cellH));
        if (scale > best.scale + 1e-9) best = { cols, scale, cellH };
      }
      return best;
    };
    let fit = bestFit(TOKEN + 26); // with room for a caption under each token
    let compact = false;
    if (fit.scale < COMPACT_BELOW) {
      const tight = bestFit(TOKEN + 10);
      if (tight.scale > fit.scale) { fit = tight; compact = true; }
    }

    const { cols, scale, cellH } = fit;
    const perRow = Math.min(cols, n);
    const startX = box.x + (box.w - perRow * cellW * scale) / 2;
    pids.forEach((pid, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      spots.set(pid, {
        x: startX + (col + 0.5) * cellW * scale,
        y: box.y + padTop + row * cellH * scale + (TOKEN / 2 + 4) * scale,
        scale,
        compact,
      });
    });
  }

  // The ready queue, right to left: index 0 (the head) is next to the CPU.
  function laneLayout(box, pids, spots) {
    if (pids.length === 0) return;
    const pad = 14;
    const ideal = TOKEN + 18;
    const slot = Math.min(ideal, (box.w - pad * 2) / pids.length);
    const scale = Math.min(1, (slot - 6) / TOKEN); // as big as the slot allows, 6px apart
    pids.forEach((pid, i) => {
      spots.set(pid, { x: box.right - pad - (i + 0.5) * slot, y: box.y + box.h / 2 + 6, scale, compact: scale < COMPACT_BELOW });
    });
  }

  // The gap between the ready lane and the CPU (side by side, or stacked).
  function doorPoint(lane, cpu) {
    if (cpu.x >= lane.right - 1) return { x: (lane.right + cpu.x) / 2, y: cpu.cy };
    return { x: cpu.cx, y: (lane.bottom + cpu.y) / 2 };
  }

  function placeTokens(frame) {
    if (dom.stage.clientWidth === 0) return; // the view is hidden
    const spots = computeLayout(frame);
    lastLayout = spots;
    const info = processInfo();
    const pick = PICK_RULE[state.result.algorithm];

    for (const p of frame.procs) {
      const token = tokens.get(p.pid);
      const spot = spots.get(p.pid);
      if (!token || !spot) continue;
      const node = token.node;
      node.style.setProperty("--x", `${spot.x.toFixed(1)}px`);
      node.style.setProperty("--y", `${spot.y.toFixed(1)}px`);
      node.style.setProperty("--s", spot.scale.toFixed(3));
      node.dataset.state = p.state;
      node.classList.toggle("is-running", p.state === "RUNNING");
      node.classList.toggle("is-loading", p.switchingIn);
      node.classList.toggle("is-compact", Boolean(spot.compact));
      node.classList.toggle("is-next", frame.readyQueue[0] === p.pid); // the algorithm's next pick
      // progress ring (the running token's ring is updated smoothly in section 9)
      if (p.state !== "RUNNING") node.style.setProperty("--p", (p.executed / info.get(p.pid).burst).toFixed(4));
      token.sub.textContent = tokenCaption(p, info.get(p.pid), pick);
      // an aged (boosted) priority glows, so aging is visible on the stage
      const base = info.get(p.pid).priority;
      const boosted = Boolean(pick.priority) && p.state === "READY" && (LOWER_IS_HIGHER ? p.priority < base : p.priority > base);
      token.sub.classList.toggle("boosted", boosted);
    }
  }

  // Under a token: the value its algorithm compares (burst, time left,
  // priority...), or its arrival / completion time outside the race.
  function tokenCaption(p, info, pick) {
    if (p.state === "NEW") return `at t=${info.arrival}`;
    if (p.state === "TERMINATED") return `done @${p.completion}`;
    if (p.switchingIn) return "loading…";
    return pick.caption(p, info);
  }

  /* ---- The CPU core -------------------------------------------------------- */

  function renderCpu(frame) {
    const cpu = frame.cpu;
    const info = processInfo();
    dom.cpu.dataset.kind = cpu.kind;

    if (cpu.kind === "run") {
      const p = frame.procs.find((q) => q.pid === cpu.pid);
      dom.cpu.style.setProperty("--core", colorOf(cpu.pid));
      dom.cpuStatus.textContent = `Executing ${cpu.pid}`;
      dom.cpuDetail.textContent = cpu.quantum
        ? `quantum ${cpu.quantumTick}/${cpu.quantum} · ${p.remaining} left`
        : `${p.remaining} of ${info.get(cpu.pid).burst} left`;
    } else if (cpu.kind === "cs") {
      dom.cpu.style.setProperty("--core", colorOf(cpu.to));
      dom.cpuStatus.textContent = "Context switch";
      dom.cpuDetail.textContent = `${cpu.from} → ${cpu.to} · ${cpu.step}/${cpu.total}`;
    } else if (cpu.kind === "idle") {
      dom.cpu.style.setProperty("--core", IDLE_CORE);
      dom.cpuStatus.textContent = "Idle";
      dom.cpuDetail.textContent = "no process is ready";
    } else {
      dom.cpu.style.setProperty("--core", DONE_CORE);
      dom.cpuStatus.textContent = "All done";
      dom.cpuDetail.textContent = `finished at t = ${frame.t}`;
    }
  }

  /* ---- Narration: what happened at this instant, in words ----------------- */

  function renderNarration(frame) {
    dom.narrTime.textContent = `t = ${frame.t}`;
    const items = frame.events.map((e) => ({ pid: e.pid, text: prettyNote(e.note), keys: keysOf(e.pid, e.by, e.from, e.to) }));
    if (items.length === 0) items.push(describeTick(frame));
    const shown = items.slice(0, 5);
    if (items.length > 5) shown.push({ pid: null, text: `…and ${items.length - 5} more in the event log` });

    dom.narrLines.replaceChildren(...shown.map(({ pid, text, keys }) => {
      const li = el("li");
      li.dataset.pids = keys !== undefined ? keys : keysOf(pid);
      if (pid) li.append(chip(pid));
      li.append(document.createTextNode(withoutLeadingPid(text, pid)));
      return li;
    }));
    restartAnimation(dom.narration, "fresh");
  }

  // When nothing new happens at an instant, say what the CPU keeps doing.
  function describeTick(frame) {
    const cpu = frame.cpu;
    if (cpu.kind === "run") {
      const p = frame.procs.find((q) => q.pid === cpu.pid);
      return { pid: cpu.pid, text: `${cpu.pid} keeps executing (${p.remaining} left)` };
    }
    if (cpu.kind === "cs") return { pid: null, text: `Context switch ${cpu.from} → ${cpu.to} continues (${cpu.step}/${cpu.total})` };
    if (cpu.kind === "idle") return { pid: null, text: "The CPU stays idle: no process is ready" };
    return { pid: null, text: "Simulation complete" };
  }

  /* ---- Decision card: WHY the scheduler did what it did at this instant ----
   * Built from the engine's events for this frame, plus the values in the
   * frame. It shows the comparison behind each decision: for example
   * "P2 4 left < P1 7 left" for a preemption, or every candidate in pick
   * order for a dispatch, with "=" where a tie was broken by arrival / PID.
   * ------------------------------------------------------------------------ */

  function renderDecision(frame) {
    const r = state.result;
    const pick = PICK_RULE[r.algorithm];
    const rule = Engine.ALGORITHMS[r.algorithm];
    const info = processInfo();
    const procOf = new Map(frame.procs.map((p) => [p.pid, p]));
    const find = (type, test) => frame.events.find((e) => e.type === type && (!test || test(e)));

    // A process's values as the scheduler compared them. An aging boost ends
    // when a process starts running, so for a process dispatched at this
    // instant the priority BEFORE that reset is the one that won.
    const atDecision = (pid) => {
      const reset = find("PRIORITY_RESET", (e) => e.pid === pid);
      return reset ? Object.assign({}, procOf.get(pid), { priority: reset.before }) : procOf.get(pid);
    };
    const keyLabel = (pid, now) => pick.caption(now ? procOf.get(pid) : atDecision(pid), info.get(pid));
    const keyValue = (pid, now) => pick.value(now ? procOf.get(pid) : atDecision(pid), info.get(pid));

    const preempt = find("PREEMPT");
    const expired = find("QUANTUM_EXPIRE");
    const renewed = find("QUANTUM_RENEW");
    const switchStart = find("CS_START");
    const dispatch = find("DISPATCH", (e) => !e.note.startsWith("Context switch finished"));
    const chosen = switchStart || dispatch; // the process picked at this instant, if any
    const completed = find("COMPLETE");
    const arrivals = frame.events.filter((e) => e.type === "ARRIVE").map((e) => e.pid);
    const cpu = frame.cpu;
    const ticks = (n) => `${n} tick${n === 1 ? "" : "s"}`;
    let card;

    if (preempt) {
      card = decisionCard("preempt", "Preemption", pick.priority ? "lower number = higher priority" : "a strictly better process takes the CPU");
      card.body.append(candidate(preempt.by, keyLabel(preempt.by), true), operator("<"), candidate(preempt.pid, keyLabel(preempt.pid), false));
      card.foot.textContent = `${preempt.pid} goes back to the ready queue` +
        (switchStart ? ` · context switch ${switchStart.from} → ${switchStart.to}: ${ticks(r.options.contextSwitch)}` : "");
    } else if (expired) {
      card = decisionCard("quantum", "Quantum expired", `${expired.pid} used all ${ticks(r.options.quantum)}`);
      card.body.append(candidate(expired.pid, "to the back", false));
      if (chosen) card.body.append(operator("→"), candidate(chosen.pid, "head of the queue", true));
      card.foot.textContent = arrivals.length
        ? `${arrivals.join(", ")} arrived at this same instant, so ${arrivals.length > 1 ? "they queue" : "it queues"} ahead of ${expired.pid}`
        : "";
    } else if (chosen) {
      card = decisionCard("pick", `Scheduler picks ${chosen.pid}`, pick.lane);
      // every candidate, in the order the algorithm ranks them
      const all = [chosen.pid, ...frame.readyQueue];
      const shown = all.slice(0, 5);
      let tie = false;
      shown.forEach((pid, i) => {
        if (i > 0) {
          if (pick.fifo) card.body.append(operator("→"));
          else {
            const equal = keyValue(shown[i - 1]) === keyValue(pid);
            tie = tie || equal;
            card.body.append(operator(equal ? "=" : "<", equal));
          }
        }
        card.body.append(candidate(pid, keyLabel(pid), i === 0));
      });
      if (all.length > shown.length) card.body.append(operator(`+${all.length - shown.length}`));
      const notes = [];
      if (all.length === 1) notes.push("the only process ready");
      if (tie) notes.push("tie → earlier arrival, then lower PID");
      if (switchStart) notes.push(`context switch ${switchStart.from} → ${switchStart.to}: ${ticks(r.options.contextSwitch)}`);
      card.foot.textContent = notes.join(" · ");
    } else if (renewed) {
      card = decisionCard("quantum", "Quantum renewed", "nobody else is ready");
      card.body.append(candidate(renewed.pid, "keeps the CPU", true));
      card.foot.textContent = "same process, so no context switch";
    } else if (completed) {
      const p = procOf.get(completed.pid);
      card = decisionCard("done", `${completed.pid} finished`, `at t = ${frame.t}`);
      card.body.append(candidate(completed.pid, `turnaround ${p.turnaround} · waiting ${p.waiting}`, true));
      card.foot.textContent = cpu.kind === "idle" ? "nothing else is ready, so the CPU idles" : "";
    } else if (cpu.kind === "run") {
      card = decisionCard("run", `Executing ${cpu.pid}`,
        cpu.quantum ? `quantum tick ${cpu.quantumTick} of ${cpu.quantum}` : "no new decision at this instant");
      card.body.append(candidate(cpu.pid, keyLabel(cpu.pid, true), true));
      const head = frame.readyQueue[0];
      if (rule.preemptive && head) {
        // why nobody preempts it right now
        const better = keyValue(head, true) < keyValue(cpu.pid, true);
        card.body.append(operator(better ? ">" : "≤"), candidate(head, keyLabel(head, true), false));
        card.foot.textContent = better
          ? `${cpu.pid} was just switched in, so it runs one tick before it can be preempted`
          : `no ready process is strictly better, so ${cpu.pid} keeps the CPU`;
      } else if (!rule.preemptive && !rule.usesQuantum) {
        card.foot.textContent = "non-preemptive: it keeps the CPU until it finishes";
      }
    } else if (cpu.kind === "cs") {
      card = decisionCard("switch", "Context switch", `tick ${cpu.step} of ${cpu.total}`);
      card.body.append(candidate(cpu.from, "out", false), operator("→"), candidate(cpu.to, "in", true));
      card.foot.textContent = "pure overhead: no process executes";
    } else if (cpu.kind === "idle") {
      card = decisionCard("idle", "CPU idle", "no process is ready");
      const next = frame.procs.filter((p) => p.state === "NEW")
        .sort((a, b) => info.get(a.pid).arrival - info.get(b.pid).arrival)[0];
      if (next) card.body.append(candidate(next.pid, `arrives at t=${info.get(next.pid).arrival}`, false));
    } else {
      card = decisionCard("done", "All processes finished", `makespan ${frame.t}`);
    }
    dom.decision.replaceChildren(card.root);
  }

  function decisionCard(kind, title, subtitle) {
    const root = el("div", `decision-card kind-${kind}`);
    const head = el("div", "decision-head");
    head.append(el("span", "decision-title", title));
    if (subtitle) head.append(el("span", "decision-sub", subtitle));
    const body = el("div", "decision-body");
    const foot = el("div", "decision-foot");
    root.append(head, body, foot);
    return { root, body, foot };
  }

  // One process in a decision card: its chip and the value that was compared.
  function candidate(pid, label, chosen) {
    const node = el("span", `cand${chosen ? " is-chosen" : ""}`);
    node.style.setProperty("--c", colorOf(pid));
    node.dataset.pids = keysOf(pid);
    node.append(chip(pid), el("span", "cand-value", label));
    return node;
  }

  function operator(symbol, highlight) {
    return el("span", `op${highlight ? " is-tie" : ""}`, symbol);
  }

  /* ---- Event log: every engine event up to the current time --------------- */

  let logItems = []; // [{ node, t, visible }]

  function buildLog() {
    logItems = state.result.events.map((e) => {
      const li = el("li", "future");
      li.dataset.pids = keysOf(e.pid, e.by, e.from, e.to); // every process the event mentions
      const message = el("span", "log-msg");
      if (e.pid) message.append(chip(e.pid));
      message.append(document.createTextNode(withoutLeadingPid(prettyNote(e.note), e.pid)));
      li.append(el("span", "log-t", `t=${e.t}`), el("span", "log-icon", EVENT_ICON[e.type] || "·"), message);
      li.title = e.type;
      return { node: li, t: e.t, visible: false };
    });
    dom.log.replaceChildren(...logItems.map((item) => item.node));
  }

  function renderLog(frame, forward) {
    let count = 0;
    for (const item of logItems) {
      const visible = item.t <= frame.t;
      if (visible !== item.visible) {
        item.node.classList.toggle("future", !visible);
        if (visible && forward) restartAnimation(item.node, "enter");
        item.visible = visible;
      }
      item.node.classList.toggle("now", item.t === frame.t);
      if (visible) count++;
    }
    dom.logCount.textContent = `${count} / ${logItems.length} events`;
    dom.log.scrollTop = dom.log.scrollHeight;
  }

  /* ---- Process table ------------------------------------------------------- */

  let liveRows = new Map(); // pid -> { tr, stateChip, cells, last }

  function buildLiveTable() {
    liveRows = new Map();
    const rows = state.result.processes.map((p) => {
      const tr = el("tr");
      tr.style.setProperty("--c", colorOf(p.pid));
      tr.dataset.pids = keysOf(p.pid);
      const pidCell = el("td");
      // a real button, so following also works from the keyboard
      const followBtn = el("button", "follow-btn");
      followBtn.type = "button";
      followBtn.dataset.follow = p.pid;
      followBtn.title = `Follow ${p.pid}`;
      followBtn.setAttribute("aria-label", `Follow ${p.pid}`);
      followBtn.setAttribute("aria-pressed", "false");
      followBtn.append(chip(p.pid));
      pidCell.append(followBtn);
      const stateCell = el("td");
      const stateChip = el("span", "state-chip");
      stateCell.append(stateChip);
      tr.append(pidCell, stateCell);
      const cells = {};
      for (const key of ["arrival", "burst", "left", "priority", "completion", "turnaround", "waiting", "response"]) {
        cells[key] = el("td");
        tr.append(cells[key]);
      }
      cells.arrival.textContent = String(p.arrival);
      cells.burst.textContent = String(p.burst);
      liveRows.set(p.pid, { tr, stateChip, cells, followBtn, last: {} });
      return tr;
    });
    dom.liveBody.replaceChildren(...rows);
  }

  function renderLiveTable(frame, forward) {
    const info = processInfo();
    for (const p of frame.procs) {
      const row = liveRows.get(p.pid);
      if (!row) continue;
      row.tr.classList.toggle("is-running", p.state === "RUNNING");
      row.stateChip.dataset.state = p.state;
      row.stateChip.textContent = p.switchingIn ? "LOADING" : p.state;
      const base = info.get(p.pid).priority;
      setCell(row, "left", String(p.remaining), false);
      setCell(row, "priority", p.priority === base ? String(base) : `${p.priority} (base ${base})`, false);
      setCell(row, "completion", fmt(p.completion), forward);
      setCell(row, "turnaround", fmt(p.turnaround), forward);
      setCell(row, "waiting", fmt(p.waiting), forward);
      setCell(row, "response", fmt(p.response), forward);
    }
    const a = liveAverages(frame);
    dom.footTat.textContent = fmt(a.turnaround);
    dom.footWait.textContent = fmt(a.waiting);
    dom.footResp.textContent = fmt(a.response);
  }

  // Updates a cell only when its text changes; new metric values flash once.
  function setCell(row, key, text, flash) {
    if (row.last[key] === text) return;
    row.last[key] = text;
    row.cells[key].textContent = text;
    if (flash && text !== "-") restartAnimation(row.cells[key], "fresh");
  }

  /* ---- Counters ------------------------------------------------------------
   * Averages so far: waiting and turnaround over the processes that have
   * finished, response over the processes that have started. At the final
   * frame these are exactly the engine's own averages.
   * ------------------------------------------------------------------------ */

  function liveAverages(frame) {
    const finished = frame.procs.filter((p) => p.completion !== null);
    const started = frame.procs.filter((p) => p.response !== null);
    const mean = (list, key) => (list.length ? list.reduce((sum, p) => sum + p[key], 0) / list.length : null);
    return {
      finished: finished.length,
      started: started.length,
      waiting: mean(finished, "waiting"),
      turnaround: mean(finished, "turnaround"),
      response: mean(started, "response"),
    };
  }

  function renderCounters(frame) {
    const r = state.result;
    const n = r.processes.length;
    const atEnd = frame.t === r.summary.makespan;
    const a = liveAverages(frame);

    setCounter(counters.waiting, atEnd ? r.averages.waiting : a.waiting);
    setCounter(counters.turnaround, atEnd ? r.averages.turnaround : a.turnaround);
    setCounter(counters.response, atEnd ? r.averages.response : a.response);
    // utilization is measured from the first arrival, the same way the engine does it
    const activeSoFar = frame.t - r.summary.firstArrival;
    setCounter(counters.utilization, atEnd ? r.summary.cpuUtilization : activeSoFar > 0 ? frame.stats.busy / activeSoFar : null);
    setCounter(counters.finished, a.finished);
    setCounter(counters.switches, frame.stats.switches);

    dom.mWaitSub.textContent = a.finished ? `over ${a.finished} of ${n} finished` : "no process finished yet";
    dom.mTatSub.textContent = dom.mWaitSub.textContent;
    dom.mRespSub.textContent = a.started ? `over ${a.started} of ${n} started` : "no process started yet";
    dom.mDoneSub.textContent = `of ${n} processes`;
  }

  function renderClock(frame) {
    const end = makespan();
    dom.teleClock.textContent = `T+${pad2(frame.t)} / ${pad2(end)}`;
    dom.stageMeta.textContent = `frame ${frame.t} of ${end}`;
    dom.scrub.value = String(frame.t);
    dom.scrubNow.textContent = `t = ${frame.t}`;
    setRangeFill(dom.scrub);
    for (const m of markers) {
      m.node.classList.toggle("passed", m.t < frame.t);
      m.node.classList.toggle("current", m.t === frame.t);
    }
  }

  /* ==========================================================================
   * 8b. FOLLOW A PROCESS
   *
   * Clicking any process (its token, a Gantt block, a lane, a PID chip, its
   * table row) dims every other process in every view, and the life-cycle
   * strip traces its states: NEW -> READY -> RUNNING -> ... -> TERMINATED,
   * read from the engine's state-change events. Click again or press Esc to
   * stop following.
   * ======================================================================== */

  // One <style> rule does all the dimming: anything tagged with data-pids
  // that does not include the followed process's key fades out.
  const followStyle = document.head.appendChild(document.createElement("style"));

  function setFollow(pid) {
    state.followed = pid && followKeys.has(pid) ? pid : null;
    applyFollow();
  }

  function applyFollow() {
    const key = state.followed ? followKeys.get(state.followed) : null;
    document.body.classList.toggle("following", Boolean(key));
    followStyle.textContent = key
      ? `body.following [data-pids]:not([data-pids~="${key}"]) { opacity: 0.16; filter: saturate(0.3); }`
      : "";
    for (const [pid, token] of tokens) token.node.classList.toggle("is-followed", pid === state.followed);
    for (const [pid, row] of liveRows) row.followBtn.setAttribute("aria-pressed", String(pid === state.followed));
    if (state.result && player.frame >= 0) renderLifeline(state.result.frames[player.frame]);
  }

  // The engine events that move a process from one state to the next.
  const LIFE_STEP = {
    ARRIVE: { to: "READY", verb: "arrives" },
    CS_START: { to: "LOADING", verb: "switch-in" },
    DISPATCH: { to: "RUNNING", verb: "gets the CPU" },
    PREEMPT: { to: "READY", verb: "preempted" },
    QUANTUM_EXPIRE: { to: "READY", verb: "quantum over" },
    COMPLETE: { to: "TERMINATED", verb: "finishes" },
  };

  function renderLifeline(frame) {
    const pid = state.followed;
    const box = dom.lifeline;
    if (!pid) {
      box.classList.remove("is-on");
      box.replaceChildren(el("span", "life-hint",
        "Tip: click any process (a token, a Gantt bar, a chip) to follow its life cycle. Esc stops following."));
      return;
    }
    box.classList.add("is-on");
    box.style.setProperty("--c", colorOf(pid));

    const head = el("div", "life-head");
    const close = el("button", "life-close", "×");
    close.type = "button";
    close.title = "Stop following (Esc)";
    close.setAttribute("aria-label", `Stop following ${pid}`);
    close.addEventListener("click", () => setFollow(null));
    head.append(el("span", "", "Following"), chip(pid), close);

    // NEW, then one arrow + state per state change up to this instant
    const steps = state.result.events.filter((e) => e.pid === pid && e.t <= frame.t && LIFE_STEP[e.type]);
    const flow = el("div", "life-flow");
    const shown = steps.slice(-8); // a long Round Robin life: keep the most recent steps
    let current = shown.length < steps.length ? LIFE_STEP[steps[steps.length - shown.length - 1].type].to : "NEW";
    if (shown.length < steps.length) flow.append(el("span", "life-more", "…"));
    flow.append(lifeState(current, shown.length === 0));
    shown.forEach((e, i) => {
      const step = LIFE_STEP[e.type];
      const arrow = el("span", "life-arrow");
      arrow.title = prettyNote(e.note); // the full reason, on hover
      arrow.append(el("b", "", `t=${e.t}`), el("span", "", step.verb));
      current = step.to;
      flow.append(arrow, lifeState(current, i === shown.length - 1));
    });

    // its numbers so far
    const p = frame.procs.find((q) => q.pid === pid);
    const info = processInfo().get(pid);
    let summary;
    if (p.state === "NEW") summary = `arrives at t=${info.arrival}`;
    else if (p.state === "TERMINATED") summary = `turnaround ${p.turnaround} · waiting ${p.waiting} · response ${p.response}`;
    else {
      summary = `waited ${p.waitedSoFar} so far`;
      if (p.response !== null) summary += ` · response ${p.response}`;
      if (p.dispatchLatency > 0) summary += ` · switch-in ${p.dispatchLatency}`;
      summary += ` · ${p.remaining} of ${info.burst} left`;
    }
    box.replaceChildren(head, flow, el("span", "life-summary", summary));
  }

  function lifeState(name, isNow) {
    return el("span", `life-state is-${name}${isNow ? " is-now" : ""}`, name === "LOADING" ? "SWITCHING IN" : name);
  }

  /* ==========================================================================
   * 9. CONTINUOUS RENDERER: what moves smoothly inside a tick
   * ======================================================================== */

  function drawContinuous(time) {
    if (!state.result || player.frame < 0) return;
    drawGanttAt(time);

    const frame = state.result.frames[player.frame];
    const phase = clamp(time - frame.t, 0, 1); // how far through this tick we are
    const cpu = frame.cpu;
    let progress = 0;
    if (cpu.kind === "run") {
      const p = frame.procs.find((q) => q.pid === cpu.pid);
      const burst = processInfo().get(cpu.pid).burst;
      // RR: the ring shows the quantum; otherwise it shows the whole burst
      progress = cpu.quantum ? (cpu.quantumTick - 1 + phase) / cpu.quantum : (p.executed + phase) / burst;
      const token = tokens.get(cpu.pid);
      if (token) token.node.style.setProperty("--p", ((p.executed + phase) / burst).toFixed(4));
    } else if (cpu.kind === "cs") {
      progress = (cpu.step - 1 + phase) / cpu.total;
    } else if (cpu.kind === "done") {
      progress = 1;
    }
    dom.cpu.style.setProperty("--prog", clamp(progress, 0, 1).toFixed(4));
  }

  /* ==========================================================================
   * 10. GANTT CHART
   *
   * One block per engine timeline entry. A block's width is how much of it
   * the current time has revealed, so the chart is drawn live, block by
   * block, behind the glowing cursor. Adjacent blocks keep a 2px gap.
   * ======================================================================== */

  const gantt = { unit: 20, origin: 14, blocks: [], ticks: [], lanes: [], cursor: null, lane: null, sideLabels: [] };

  function buildGantt() {
    const r = state.result;
    dom.ganttTrack.replaceChildren();
    gantt.lane = el("div", "g-lane");
    dom.ganttTrack.append(gantt.lane);

    gantt.blocks = r.timeline.map((b, i) => {
      const kind = b.pid === "CS" ? "is-cs" : b.pid === "IDLE" ? "is-idle" : "is-run";
      const node = el("div", `g-block ${kind} unrevealed`);
      if (kind === "is-run") node.style.setProperty("--c", colorOf(b.pid));
      // a switch belongs to both processes it connects; idle belongs to none
      node.dataset.pids = kind === "is-run" ? keysOf(b.pid) : kind === "is-cs" ? keysOf(b.from, b.to) : "";
      if (kind === "is-run") node.dataset.follow = b.pid;
      node.tabIndex = 0; // keyboard focus shows the same tooltip as hover
      node.dataset.index = String(i);
      node.setAttribute("aria-label", `${b.pid === "CS" ? `Context switch ${b.from} to ${b.to}` : b.pid} from ${b.start} to ${b.end}`);
      const label = el("span", "g-label", b.pid === "IDLE" ? "idle" : b.pid);
      node.append(label);
      dom.ganttTrack.append(node);
      return { b, node, label, info: blockReason(i), width: -1, revealed: false, live: false, full: 0 };
    });

    // Time labels at every block boundary (like a textbook Gantt chart).
    const bounds = [...new Set([0, ...r.timeline.map((b) => b.end)])];
    gantt.ticks = bounds.map((t) => {
      const node = el("span", "g-tick", String(t));
      dom.ganttTrack.append(node);
      return { t, node, x: 0, keep: true, shown: null };
    });

    buildLanes();
    gantt.cursor = el("div", "g-cursor"); // added last, so it sweeps over the lanes too
    dom.ganttTrack.append(gantt.cursor);
    layoutGantt();
  }

  /* ---- Process lanes --------------------------------------------------------
   * One row per process under the CPU row: solid where the process runs,
   * faint where it waits in the ready queue, grey while it is being switched
   * in. The faint bars ARE the waiting time: their total length is exactly
   * the number the W counter at the end of the row shows.
   * ------------------------------------------------------------------------ */

  // A process's timeline, read from the frames: [{ kind, start, end }].
  //   run  = RUNNING (it executes during that tick)
  //   wait = READY and in the ready queue
  //   load = being loaded by a context switch
  function laneSegments(index) {
    const segments = [];
    for (const frame of state.result.frames) {
      if (frame.cpu.kind === "done") break;
      const p = frame.procs[index];
      const kind = p.state === "RUNNING" ? "run" : p.switchingIn ? "load" : p.state === "READY" ? "wait" : null;
      if (!kind) continue;
      const last = segments[segments.length - 1];
      if (last && last.kind === kind && last.end === frame.t) last.end = frame.t + 1;
      else segments.push({ kind, start: frame.t, end: frame.t + 1 });
    }
    return segments;
  }

  function buildLanes() {
    const r = state.result;
    gantt.lanes = r.processes.map((p, i) => {
      const color = colorOf(p.pid);
      const key = keysOf(p.pid);
      const row = el("div", "l-row");
      row.dataset.pids = key;
      dom.ganttTrack.append(row);
      const segs = laneSegments(i).map((s, k) => {
        const node = el("div", `l-seg is-${s.kind} unrevealed`);
        node.style.setProperty("--c", color);
        node.dataset.pids = key;
        node.dataset.follow = p.pid;
        node.dataset.lane = String(i);
        node.dataset.seg = String(k);
        dom.ganttTrack.append(node);
        return Object.assign(s, { node, width: -1, revealed: false });
      });
      const arrive = el("div", "l-arrive"); // a small mark where the process arrives
      const done = el("div", "l-done");     // and where it finishes
      arrive.style.setProperty("--c", color);
      done.style.setProperty("--c", color);
      dom.ganttTrack.append(arrive, done);

      const label = el("div", "g-side-label");
      label.dataset.pids = key;
      label.append(chip(p.pid));
      const counter = el("div", "g-side-label g-count");
      counter.dataset.pids = key;
      counter.title = "Ticks in the ready queue so far (= its waiting time once it finishes)";
      return {
        pid: p.pid, arrival: p.arrival, completion: r.metrics[i].completion,
        row, segs, arrive, done, label, counter, shown: {}, counterText: "",
      };
    });

    const cpuLabel = el("div", "g-side-label g-side-title", "CPU");
    const waitTitle = el("div", "g-side-label g-side-title", "Waited");
    gantt.sideLabels = [cpuLabel, waitTitle];
    dom.ganttLabels.replaceChildren(cpuLabel, ...gantt.lanes.map((l) => l.label));
    dom.ganttCounters.replaceChildren(waitTitle, ...gantt.lanes.map((l) => l.counter));
  }

  function layoutLanes(width) {
    const { cpuTop, cpuHeight, laneTop, laneHeight, laneGap } = GANTT_ROWS;
    const u = gantt.unit;
    gantt.lanes.forEach((lane, i) => {
      const y = laneTop + i * (laneHeight + laneGap);
      Object.assign(lane.row.style, { left: `${gantt.origin}px`, width: `${width}px`, top: `${y}px` });
      for (const s of lane.segs) {
        s.node.style.left = `${gantt.origin + s.start * u + 1}px`;
        s.node.style.top = `${y}px`;
        s.width = -1; // force a redraw
      }
      lane.arrive.style.left = `${gantt.origin + lane.arrival * u}px`;
      lane.arrive.style.top = `${y - 7}px`;
      lane.done.style.left = `${gantt.origin + lane.completion * u}px`;
      lane.done.style.top = `${y - 3}px`;
      lane.label.style.top = lane.counter.style.top = `${y + laneHeight / 2}px`;
      lane.shown = {};
    });
    gantt.sideLabels[0].style.top = `${cpuTop + cpuHeight / 2}px`;
    gantt.sideLabels[1].style.top = `${laneTop - 12}px`;

    const height = laneTop + gantt.lanes.length * (laneHeight + laneGap) + 4;
    dom.ganttTrack.style.height = `${height}px`;
    dom.ganttLabels.style.height = dom.ganttCounters.style.height = `${height}px`;
    gantt.cursor.style.height = `${height - 4}px`;
  }

  function drawLanesAt(time) {
    const u = gantt.unit;
    for (const lane of gantt.lanes) {
      for (const s of lane.segs) {
        const shown = clamp(time - s.start, 0, s.end - s.start);
        const width = shown > 0 ? Math.max(0, shown * u - 2) : 0;
        if (Math.abs(width - s.width) < 0.25) continue;
        s.node.style.width = `${width.toFixed(1)}px`;
        s.width = width;
        const revealed = width > 0;
        if (revealed !== s.revealed) {
          s.node.classList.toggle("unrevealed", !revealed);
          s.revealed = revealed;
        }
      }
      const arrived = time >= lane.arrival - 1e-6;
      const finished = time >= lane.completion - 1e-6;
      if (lane.shown.arrived !== arrived) { lane.arrive.classList.toggle("shown", arrived); lane.shown.arrived = arrived; }
      if (lane.shown.finished !== finished) { lane.done.classList.toggle("shown", finished); lane.shown.finished = finished; }
    }
  }

  // The W counters: ticks spent in the ready queue up to this instant.
  function renderLaneCounters(frame) {
    gantt.lanes.forEach((lane, i) => {
      const p = frame.procs[i];
      const text = `W ${p.waitedSoFar}`;
      if (text !== lane.counterText) {
        lane.counter.textContent = text;
        lane.counterText = text;
      }
      lane.counter.classList.toggle("done", p.state === "TERMINATED");
    });
  }

  function laneTooltip(lane, s) {
    const done = player.time >= s.end - 1e-6;
    const length = s.end - s.start;
    const what = { run: "running on the CPU", wait: "waiting in the ready queue", load: "being switched in" }[s.kind];
    const title = el("div", "tip-title");
    title.append(chip(lane.pid), document.createTextNode(what));
    const parts = [title, tipRow("Time", done
      ? `${s.start} → ${s.end} (${length} tick${length === 1 ? "" : "s"})`
      : `${s.start} → now`)];
    if (s.kind === "wait") parts.push(tipRow("Counts as", "waiting time"));
    if (s.kind === "load") parts.push(tipRow("Counts as", "dispatch latency (context-switch overhead)"));
    return parts;
  }

  // Sizes the chart to the panel (wider than the panel only for long runs).
  function layoutGantt() {
    const r = state.result;
    if (!r || dom.ganttScroll.clientWidth === 0) return;
    const span = r.summary.makespan;
    const avail = dom.ganttScroll.clientWidth - gantt.origin * 2;
    gantt.unit = Math.max(18, avail / span);
    const width = span * gantt.unit;

    dom.ganttTrack.style.width = `${width + gantt.origin * 2}px`;
    gantt.lane.style.left = `${gantt.origin}px`;
    gantt.lane.style.width = `${width}px`;
    gantt.lane.style.setProperty("--unit", `${gantt.unit}px`);

    for (const g of gantt.blocks) {
      g.node.style.left = `${gantt.origin + g.b.start * gantt.unit + 1}px`;
      g.width = -1; // force a redraw
    }

    // Keep tick labels at least 22px apart; the last one always stays.
    const kept = [];
    for (const tick of gantt.ticks) {
      tick.x = gantt.origin + tick.t * gantt.unit;
      tick.node.style.left = `${tick.x}px`;
      tick.shown = null;
      if (kept.length === 0 || tick.x - kept[kept.length - 1].x >= 22) kept.push(tick);
      else if (tick.t === span) { kept.pop(); kept.push(tick); }
    }
    for (const tick of gantt.ticks) tick.keep = kept.includes(tick);

    layoutLanes(width);
    drawGanttAt(player.time);
  }

  function drawGanttAt(time) {
    const u = gantt.unit;
    for (const g of gantt.blocks) {
      const length = g.b.end - g.b.start;
      const shown = clamp(time - g.b.start, 0, length);
      const width = shown > 0 ? Math.max(0, shown * u - 2) : 0;
      if (Math.abs(width - g.width) > 0.25) {
        g.node.style.width = `${width.toFixed(1)}px`;
        g.width = width;
        const revealed = width > 0;
        if (revealed !== g.revealed) {
          g.node.classList.toggle("unrevealed", !revealed);
          g.revealed = revealed;
        }
        // a label only when it fits inside the block
        g.label.classList.toggle("hide", width < g.label.textContent.length * 8 + 8);
      }
      const live = shown > 0 && shown < length;
      if (live !== g.live) {
        g.node.classList.toggle("is-live", live);
        g.live = live;
      }
    }
    for (const tick of gantt.ticks) {
      const shown = tick.keep && time >= tick.t - 1e-6;
      if (shown !== tick.shown) {
        tick.node.classList.toggle("shown", shown);
        tick.shown = shown;
      }
    }
    drawLanesAt(time);
    const x = gantt.origin + time * u;
    if (gantt.cursor) gantt.cursor.style.transform = `translateX(${x.toFixed(1)}px)`;
    if (player.playing) followCursor(x);
  }

  // Keeps the cursor in view when the chart is wider than the panel.
  function followCursor(x) {
    const view = dom.ganttScroll;
    if (x > view.scrollLeft + view.clientWidth * 0.85 || x < view.scrollLeft) {
      view.scrollLeft = x - view.clientWidth * 0.3;
    }
  }

  // Why a block happened, read from the engine's events at its start and end.
  function blockReason(i) {
    const r = state.result;
    const b = r.timeline[i];
    const eventsAt = (t) => (r.frames[t] ? r.frames[t].events : []);
    const reasonIn = (note) => {
      const m = note.match(/\(([^)]*)\)/); // the reason is in the first (...)
      return m ? m[1] : prettyNote(note);
    };

    if (b.pid === "IDLE") return { why: "no process was in the ready queue", ended: "" };
    if (b.pid === "CS") {
      const start = eventsAt(b.start).find((e) => e.type === "CS_START" && e.pid === b.to);
      return { why: start ? `${b.to} was chosen: ${reasonIn(start.note)}` : "", ended: "" };
    }

    let why = "";
    const dispatch = eventsAt(b.start).find((e) => e.type === "DISPATCH" && e.pid === b.pid);
    if (dispatch && dispatch.note.startsWith("Context switch finished")) {
      // the real reason was given when the switch started
      const prev = r.timeline[i - 1];
      const start = prev && prev.pid === "CS"
        ? eventsAt(prev.start).find((e) => e.type === "CS_START" && e.pid === b.pid)
        : null;
      why = start ? reasonIn(start.note) : "its context switch finished";
    } else if (dispatch) {
      why = reasonIn(dispatch.note);
    }
    const end = eventsAt(b.end).find((e) =>
      e.pid === b.pid && (e.type === "PREEMPT" || e.type === "QUANTUM_EXPIRE" || e.type === "COMPLETE"));
    return { why, ended: end ? prettyNote(end.note) : "" };
  }

  function blockTooltip(g) {
    const b = g.b;
    const done = player.time >= b.end - 1e-6;
    const length = b.end - b.start;
    const title = el("div", "tip-title");
    if (b.pid === "CS") title.textContent = `Context switch ${b.from} → ${b.to}`;
    else if (b.pid === "IDLE") title.textContent = "CPU idle";
    else title.append(chip(b.pid), document.createTextNode("on the CPU"));

    const parts = [title];
    parts.push(tipRow("Time", done
      ? `${b.start} → ${b.end} (${length} tick${length === 1 ? "" : "s"})`
      : `${b.start} → now (still running)`));
    if (g.info.why) parts.push(tipRow("Why", g.info.why));
    if (done && g.info.ended) parts.push(tipRow("Then", g.info.ended));
    return parts;
  }

  /* ---- Tooltip (shared by the Gantt chart and the Compare charts) --------- */

  function tipRow(label, text) {
    const row = el("div", "tip-row");
    row.append(el("b", "", `${label}: `), document.createTextNode(text));
    return row;
  }

  function showTooltip(parts, x, y) {
    const tip = dom.tooltip;
    tip.replaceChildren(...parts);
    tip.hidden = false;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    tip.style.left = `${clamp(x + 14, 8, window.innerWidth - w - 8)}px`;
    tip.style.top = `${y + 18 + h > window.innerHeight ? y - h - 12 : y + 18}px`;
  }

  function hideTooltip() {
    dom.tooltip.hidden = true;
  }

  /* ==========================================================================
   * 11. EFFECTS: flow arrows, CPU swap flash, particles
   *
   * Effects are triggered by the engine's events for the frame just reached,
   * and only when moving forward one tick (never while scrubbing or stepping
   * back), so they always mark something the algorithm really did.
   * ======================================================================== */

  function playEffects(frame, previous) {
    const cpu = relRect(dom.cpu, dom.stage);
    for (const e of frame.events) {
      switch (e.type) {
        case "ARRIVE":
          pulseFlow("admit");
          break;
        case "CS_START":
          pulseFlow("dispatch");
          swapFlash();
          pulseToken(e.pid, "picked");
          break;
        case "DISPATCH":
          pulseFlow("dispatch");
          // a switch with zero cost has no CS_START: flash when the CPU changes process
          if (previous && previous.cpu.kind === "run" && previous.cpu.pid !== e.pid) swapFlash();
          if (!e.note.startsWith("Context switch finished")) pulseToken(e.pid, "picked");
          break;
        case "PREEMPT":
        case "QUANTUM_EXPIRE":
          pulseFlow("preempt");
          pulseToken(e.pid, "bumped");
          break;
        case "COMPLETE": {
          pulseFlow("exit");
          const color = colorOf(e.pid);
          burst(cpu.cx, cpu.cy, color, 46);
          const landing = lastLayout.get(e.pid);
          const result = state.result;
          if (landing) {
            setTimeout(() => { if (state.result === result) burst(landing.x, landing.y, color, 16); }, 720);
          }
          break;
        }
        case "AGE": {
          const token = tokens.get(e.pid);
          if (token) restartAnimation(token.sub, "bump");
          break;
        }
        default:
          break;
      }
    }
  }

  // A short highlight on one token: "picked" (a ring) or "bumped" (a flash).
  function pulseToken(pid, className) {
    const token = tokens.get(pid);
    if (!token) return;
    restartAnimation(token.node, className);
    // remove the class afterwards, so lasting animations (the follow ring) resume
    token.node.addEventListener("animationend", () => token.node.classList.remove(className), { once: true });
  }

  function swapFlash() {
    restartAnimation(dom.cpu, "swap");
  }

  /* ---- Flow arrows of the state diagram ------------------------------------ */

  const flowPaths = new Map(); // name -> <path>

  function drawFlow() {
    const stageBox = dom.stage.getBoundingClientRect();
    if (stageBox.width === 0) return;
    dom.flow.setAttribute("viewBox", `0 0 ${stageBox.width} ${stageBox.height}`);
    const a = relRect(dom.zoneNew, dom.stage);
    const b = relRect(dom.zoneReady, dom.stage);
    const c = relRect(dom.cpu, dom.stage);
    const cell = relRect(dom.cpuCell, dom.stage);
    const d = relRect(dom.zoneDone, dom.stage);
    const gap = 6;
    const sideBySide = c.x >= b.right - 1;
    let paths;

    if (sideBySide) {
      const laneY = b.cy;
      const runY = clamp(c.cy, b.y + 12, b.bottom - 12);
      const ps = { x: c.x + 6, y: c.cy + c.h * 0.28 };       // preempt: from the CPU's lower left...
      const pe = { x: b.right - 40, y: b.bottom + gap };     // ...back to the tail end of the lane
      paths = {
        admit: { d: `M${a.right + gap},${laneY} L${b.x - gap},${laneY}`, x: (a.right + b.x) / 2, y: laneY - 9, label: "admit" },
        dispatch: { d: `M${b.right + gap},${runY} L${c.x - gap},${c.cy}`, x: (b.right + c.x) / 2, y: Math.min(runY, c.cy) - 30, label: "dispatch" },
        exit: { d: `M${c.right + gap},${c.cy} L${d.x - gap},${c.cy}`, x: (c.right + d.x) / 2, y: c.cy - 9, label: "exit" },
        preempt: {
          d: `M${ps.x},${ps.y} C${ps.x - 16},${ps.y + 64} ${pe.x + 30},${pe.y + 52} ${pe.x},${pe.y}`,
          x: (ps.x + pe.x) / 2,
          y: Math.max(ps.y, pe.y) + 40,
          label: "preempt / quantum",
        },
      };
    } else {
      const ps = { x: c.x - gap, y: c.cy };
      const pe = { x: b.x + 40, y: b.bottom + gap };
      paths = {
        admit: { d: `M${a.cx},${a.bottom + gap} L${b.cx},${b.y - gap}`, x: a.cx + 34, y: (a.bottom + b.y) / 2 + 4, label: "admit" },
        dispatch: { d: `M${b.cx},${b.bottom + gap} L${c.cx},${c.y - gap}`, x: b.cx + 44, y: (b.bottom + c.y) / 2 + 4, label: "dispatch" },
        exit: { d: `M${cell.cx},${cell.bottom + gap} L${d.cx},${d.y - gap}`, x: d.cx + 30, y: (cell.bottom + d.y) / 2 + 4, label: "exit" },
        preempt: {
          d: `M${ps.x},${ps.y} C${ps.x - 70},${ps.y} ${pe.x},${pe.y + 50} ${pe.x},${pe.y}`,
          x: Math.max(52, pe.x - 4),
          y: (ps.y + pe.y) / 2 + 10,
          label: "preempt",
        },
      };
    }

    flowPaths.clear();
    dom.flowPaths.replaceChildren(...Object.entries(paths).map(([name, p]) => {
      const group = svgEl("g", {});
      const path = svgEl("path", { d: p.d, class: "flow-path", "marker-end": "url(#arrowHead)" });
      path.addEventListener("animationend", () => path.classList.remove("pulse"));
      const label = svgEl("text", { x: p.x.toFixed(1), y: p.y.toFixed(1), class: "flow-label" });
      label.textContent = p.label;
      group.append(path, label);
      flowPaths.set(name, path);
      return group;
    }));
  }

  function pulseFlow(name) {
    const path = flowPaths.get(name);
    if (path) restartAnimation(path, "pulse");
  }

  /* ---- Particles on <canvas> ----------------------------------------------- */

  const fx = { ctx: dom.fx.getContext("2d"), parts: [], w: 0, h: 0, dirty: false };

  function resizeFx() {
    const box = dom.stage.getBoundingClientRect();
    if (box.width === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    fx.w = box.width;
    fx.h = box.height;
    dom.fx.width = Math.round(box.width * dpr);
    dom.fx.height = Math.round(box.height * dpr);
    fx.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // A burst of sparks plus one expanding ring, in the process's color.
  function burst(x, y, color, count) {
    if (reducedMotion()) return;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 50 + Math.random() * 190;
      fx.parts.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        decay: 0.7 + Math.random() * 0.9,
        size: 1.2 + Math.random() * 2.6,
        color,
      });
    }
    fx.parts.push({ ring: true, x, y, radius: 10, life: 1, decay: 1.5, color });
  }

  function stepParticles(dt) {
    const ctx = fx.ctx;
    if (fx.parts.length === 0) {
      if (fx.dirty) {
        ctx.clearRect(0, 0, fx.w, fx.h);
        fx.dirty = false;
      }
      return;
    }
    ctx.clearRect(0, 0, fx.w, fx.h);
    ctx.globalCompositeOperation = "lighter";
    for (const p of fx.parts) {
      p.life -= p.decay * dt;
      if (p.life <= 0) continue;
      ctx.globalAlpha = p.life;
      if (p.ring) {
        p.radius += 190 * dt;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const drag = 1 - 1.8 * dt;
        p.vx *= drag;
        p.vy = p.vy * drag + 40 * dt; // a little gravity
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.4 + 0.6 * p.life), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    fx.parts = fx.parts.filter((p) => p.life > 0);
    fx.dirty = true;
  }

  /* ==========================================================================
   * 12. COMPARE MODE
   *
   * Engine.compareAll() runs all six algorithms on the same workload with the
   * same options. Each chart has one series, so every bar is the same muted
   * color and the winner (lowest value) glows; the table below lists every
   * exact value.
   * ======================================================================== */

  function openMode(mode) {
    state.mode = mode;
    const simulate = mode === "simulate";
    dom.tabSimulate.setAttribute("aria-selected", String(simulate));
    dom.tabCompare.setAttribute("aria-selected", String(!simulate));
    dom.viewSimulate.hidden = !simulate;
    dom.viewCompare.hidden = simulate;
    hideTooltip();
    if (simulate) {
      // the layout may have changed while the view was hidden
      requestAnimationFrame(() => {
        if (!state.result) return;
        resizeFx();
        drawFlow();
        layoutGantt();
        layoutMarkers();
        if (player.frame >= 0) placeTokens(state.result.frames[player.frame]);
      });
    } else {
      pause();
      buildCompare();
    }
  }

  function buildCompare() {
    const clear = (message) => {
      state.compare = null;
      dom.compareMeta.textContent = message;
      dom.compareBody.replaceChildren();
      dom.schedules.replaceChildren();
      for (const ch of charts) { ch.values = []; drawChart(ch); }
    };
    if (!state.result) return clear("Fix the workload first (see the Workload panel).");
    try {
      state.compare = Engine.compareAll(engineWorkload(), currentOptions());
    } catch (err) {
      return clear(err.message.replace(/^Invalid input:\s*-?\s*/, "").replace(/\n- /g, " "));
    }
    const o = currentOptions();
    dom.compareMeta.textContent =
      `${state.result.processes.length} processes · quantum ${o.quantum} · switch cost ${o.contextSwitch} · ` +
      `aging ${o.aging.enabled ? `every ${o.aging.every}, by ${o.aging.by}` : "off"}`;
    renderCompareTable();
    renderSchedules();
    startCharts();
  }

  // The winners of a list of values: the indexes holding the best value.
  // If every value is the same there is no winner.
  function winnersOf(values, better) {
    const best = better === "high" ? Math.max(...values) : Math.min(...values);
    if (values.every((v) => Math.abs(v - best) < 1e-9)) return new Set();
    return new Set(values.map((v, i) => (Math.abs(v - best) < 1e-9 ? i : -1)).filter((i) => i >= 0));
  }

  /* ---- Bar charts on <canvas> ---------------------------------------------- */

  const charts = [...document.querySelectorAll(".chart-card canvas")].map((canvas) => ({
    canvas,
    ctx: canvas.getContext("2d"),
    metric: COMPARE_METRICS[canvas.dataset.metric],
    values: [],
    labels: [],
    names: [],
    winners: new Set(),
    progress: 1,
    startedAt: 0,
    hover: -1,
    bands: [],
  }));

  function startCharts() {
    const results = state.compare;
    for (const ch of charts) {
      ch.values = results.map(ch.metric.get);
      ch.labels = results.map((r) => Engine.ALGORITHMS[r.algorithm].short);
      ch.names = results.map((r) => r.algorithmName);
      ch.winners = winnersOf(ch.values, "low");
      ch.startedAt = performance.now();
      ch.progress = reducedMotion() ? 1 : 0;
      ch.hover = -1;
      drawChart(ch);
    }
  }

  function updateCharts(now) {
    if (state.mode !== "compare") return;
    for (const ch of charts) {
      if (ch.progress >= 1 || ch.values.length === 0) continue;
      ch.progress = clamp((now - ch.startedAt) / 1300, 0, 1);
      drawChart(ch);
    }
  }

  // A "nice" axis: 0 to max in at most four round steps.
  function niceScale(maxValue, integer) {
    if (!(maxValue > 0)) return { max: integer ? 4 : 1, step: integer ? 1 : 0.25 };
    const raw = maxValue / 4;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const factors = integer ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
    let step = factors.map((f) => f * pow).find((s) => s >= raw - 1e-12);
    if (integer) step = Math.max(1, Math.round(step));
    return { max: step * Math.ceil(maxValue / step - 1e-9), step };
  }

  // A bar with rounded top corners, anchored flat on the baseline.
  function roundedTopRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h);
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
  }

  function drawChart(ch) {
    const { canvas, ctx } = ch;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (!cssW || !cssH) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.round(cssW * dpr);
    const ph = Math.round(cssH * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (ch.values.length === 0) return;

    const m = { left: 40, right: 8, top: 30, bottom: 42 };
    const plotW = cssW - m.left - m.right;
    const plotH = cssH - m.top - m.bottom;
    const { max, step } = niceScale(Math.max(...ch.values), ch.metric.integer);

    // horizontal gridlines: solid hairlines, one shade off the surface
    ctx.font = `11px ${MONO}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let v = 0; v <= max + 1e-9; v += step) {
      const y = Math.round(m.top + plotH - (v / max) * plotH) + 0.5;
      ctx.strokeStyle = v === 0 ? "rgba(130, 190, 255, 0.35)" : "rgba(130, 190, 255, 0.1)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(m.left, y);
      ctx.lineTo(cssW - m.right, y);
      ctx.stroke();
      ctx.fillStyle = INK.muted;
      ctx.fillText(String(Number(v.toFixed(2))), m.left - 6, y);
    }

    const n = ch.values.length;
    const band = plotW / n;
    const barW = Math.min(44, band * 0.56);
    ch.bands = [];

    ch.values.forEach((value, i) => {
      // bars grow one after another (a small stagger), easing out
      const local = clamp(ch.progress * 1.6 - i * 0.12, 0, 1);
      const h = (value / max) * plotH * easeOutCubic(local);
      const x = m.left + band * i + (band - barW) / 2;
      const y = m.top + plotH - h;
      const winner = ch.winners.has(i);
      const hovered = ch.hover === i;
      ch.bands.push({ x: m.left + band * i, w: band });

      if (h > 0.5) {
        ctx.save();
        if (winner) {
          const grad = ctx.createLinearGradient(0, y, 0, y + h);
          grad.addColorStop(0, "#8ff7ff");
          grad.addColorStop(1, "rgba(0, 229, 255, 0.35)");
          ctx.fillStyle = grad;
          ctx.shadowColor = "rgba(0, 229, 255, 0.85)";
          ctx.shadowBlur = hovered ? 26 : 18;
        } else {
          ctx.fillStyle = hovered ? "rgba(169, 186, 219, 0.6)" : "rgba(125, 143, 176, 0.38)";
        }
        roundedTopRect(ctx, x, y, barW, h, 4);
        ctx.fill();
        ctx.restore();
      }

      // category label under the bar (two lines for "Priority NP" etc.)
      ctx.fillStyle = winner ? INK.text : INK.text2;
      ctx.font = `${winner ? 600 : 400} 11px ${MONO}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ch.labels[i].split(" ").forEach((line, k) => ctx.fillText(line, x + barW / 2, m.top + plotH + 8 + k * 13));

      // a value label only on the winner(s) and the hovered bar
      if ((winner || hovered) && local > 0.5) {
        ctx.globalAlpha = clamp((local - 0.5) * 2, 0, 1);
        ctx.fillStyle = INK.text;
        ctx.font = `600 12px ${MONO}`;
        ctx.textBaseline = "bottom";
        ctx.fillText(fmt(value) + (winner ? " ★" : ""), x + barW / 2, y - 6);
        ctx.globalAlpha = 1;
      }
    });
  }

  function onChartPointer(ch, e) {
    if (ch.values.length === 0) return;
    const box = ch.canvas.getBoundingClientRect();
    const x = e.clientX - box.left;
    const i = ch.bands.findIndex((b) => x >= b.x && x < b.x + b.w); // the whole band is the hit area
    if (i !== ch.hover) {
      ch.hover = i;
      drawChart(ch);
    }
    if (i < 0) return hideTooltip();
    const parts = [el("div", "tip-title", ch.names[i]), tipRow(ch.metric.label, fmt(ch.values[i]))];
    if (ch.winners.has(i)) parts.push(el("div", "tip-row", "★ best of the six for this metric"));
    showTooltip(parts, e.clientX, e.clientY);
  }

  /* ---- Results table ------------------------------------------------------- */

  function renderCompareTable() {
    const results = state.compare;
    const columns = [
      { get: (r) => r.averages.waiting, better: "low", format: fmt },
      { get: (r) => r.averages.turnaround, better: "low", format: fmt },
      { get: (r) => r.averages.response, better: "low", format: fmt },
      { get: (r) => r.summary.switches, better: "low", format: fmt },
      { get: (r) => r.summary.cpuUtilization, better: "high", format: pct },
      { get: (r) => r.summary.makespan, better: "low", format: fmt },
    ];
    const winners = columns.map((c) => winnersOf(results.map(c.get), c.better));

    dom.compareBody.replaceChildren(...results.map((r, i) => {
      const tr = el("tr");
      tr.append(el("td", "", r.algorithmName));
      columns.forEach((c, k) => tr.append(el("td", winners[k].has(i) ? "best" : "", c.format(c.get(r)))));
      const cell = el("td");
      const open = el("button", "btn btn-ghost", "Simulate ▸");
      open.type = "button";
      open.setAttribute("aria-label", `Simulate ${r.algorithmName}`);
      open.addEventListener("click", () => {
        selectAlgorithm(r.algorithm);
        openMode("simulate");
      });
      cell.append(open);
      tr.append(cell);
      return tr;
    }));
  }

  /* ---- Schedules side by side (one mini Gantt chart per algorithm) -------- */

  function renderSchedules() {
    const results = state.compare;
    const span = Math.max(...results.map((r) => r.summary.makespan));
    const tracks = [];

    dom.schedules.replaceChildren(...results.map((r) => {
      const row = el("div", "sched-row");
      const track = el("div", "sched-track");
      for (const b of r.timeline) {
        const kind = b.pid === "CS" ? "is-cs" : b.pid === "IDLE" ? "is-idle" : "";
        const block = el("div", `sched-block ${kind}`);
        if (!kind) block.style.setProperty("--c", colorOf(b.pid));
        block.dataset.pids = !kind ? keysOf(b.pid) : kind === "is-cs" ? keysOf(b.from, b.to) : "";
        if (!kind) block.dataset.follow = b.pid;
        block.style.left = `calc(${(b.start / span) * 100}% + 1px)`;
        block.style.width = `calc(${((b.end - b.start) / span) * 100}% - 2px)`;
        block.title = b.pid === "CS" ? `Context switch ${b.from} → ${b.to}: ${b.start}-${b.end}` : `${b.pid}: ${b.start}-${b.end}`;
        block.dataset.label = kind === "is-idle" ? "" : b.pid;
        block.dataset.length = String(b.end - b.start);
        track.append(block);
      }
      tracks.push(track);
      row.append(el("span", "sched-name", Engine.ALGORITHMS[r.algorithm].short), track, el("span", "sched-end", `t=${r.summary.makespan}`));
      return row;
    }));

    // After layout: put labels only where they fit, then sweep each row in.
    requestAnimationFrame(() => {
      for (const track of tracks) {
        const unit = track.clientWidth / span;
        for (const block of track.children) {
          const width = Number(block.dataset.length) * unit - 2;
          const label = block.dataset.label;
          block.textContent = label && width >= label.length * 7 + 8 ? label : "";
        }
      }
      tracks.forEach((track, i) => setTimeout(() => track.classList.add("revealed"), reducedMotion() ? 0 : 90 * i));
    });
  }

  /* ==========================================================================
   * 13. START-UP: wire up the controls, load the first workload, start the loop
   * ======================================================================== */

  function init() {
    // Workload editor
    for (const p of PRESETS) {
      const option = el("option", "", p.label);
      option.value = p.id;
      dom.presetSelect.append(option);
    }
    dom.presetSelect.addEventListener("change", () => {
      loadPreset(dom.presetSelect.value);
      dom.presetSelect.value = "";
    });
    dom.procBody.addEventListener("input", (e) => {
      const input = e.target;
      if (!input.dataset.field) return;
      state.processes[Number(input.dataset.index)][input.dataset.field] = input.value;
      scheduleRebuild();
    });
    dom.procBody.addEventListener("click", (e) => {
      const button = e.target.closest("[data-remove]");
      if (!button) return;
      state.processes.splice(Number(button.dataset.remove), 1);
      renderWorkloadTable();
      rebuild();
    });
    dom.btnAdd.addEventListener("click", addProcess);
    dom.btnGenerate.addEventListener("click", () => generate());
    dom.btnDice.addEventListener("click", () => generate(Math.floor(Math.random() * 100000)));
    dom.btnExport.addEventListener("click", exportJson);
    dom.btnImport.addEventListener("click", () => dom.fileImport.click());
    dom.fileImport.addEventListener("change", () => {
      const file = dom.fileImport.files[0];
      dom.fileImport.value = "";
      if (file) importJson(file);
    });

    // Scheduler settings
    buildAlgoButtons();
    dom.algoGrid.addEventListener("click", (e) => {
      const button = e.target.closest("[data-algo]");
      if (button) selectAlgorithm(button.dataset.algo);
    });
    dom.algoGrid.addEventListener("keydown", (e) => {
      const order = Engine.ALGORITHM_ORDER;
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const next = order[(order.indexOf(state.options.algorithm) + step + order.length) % order.length];
      selectAlgorithm(next);
      dom.algoGrid.querySelector(`[data-algo="${next}"]`).focus();
    });
    for (const input of [dom.optQuantum, dom.optSwitch, dom.optAgingEvery, dom.optAgingBy]) {
      input.addEventListener("input", () => {
        readSchedulerInputs();
        scheduleRebuild();
      });
    }
    dom.optAging.addEventListener("change", () => {
      readSchedulerInputs();
      rebuild();
    });

    // Transport
    dom.btnPlay.addEventListener("click", togglePlay);
    dom.btnStep.addEventListener("click", stepForward);
    dom.btnBack.addEventListener("click", stepBack);
    dom.btnReset.addEventListener("click", resetPlayback);
    // Follow a process: one handler for every clickable process element
    document.addEventListener("click", (e) => {
      const target = e.target.closest("[data-follow]");
      if (!target || !state.result) return;
      const pid = target.dataset.follow;
      setFollow(state.followed === pid ? null : pid); // clicking the followed one again stops
    });
    dom.btnNextEvent.addEventListener("click", () => jumpToEvent(1));
    dom.btnPrevEvent.addEventListener("click", () => jumpToEvent(-1));
    dom.scrubMarkers.addEventListener("click", (e) => {
      const marker = e.target.closest(".scrub-marker");
      if (!marker) return;
      pause();
      seek(Number(marker.dataset.t), false);
    });
    dom.scrubMarkers.addEventListener("pointerover", (e) => {
      const marker = e.target.closest(".scrub-marker");
      if (!marker) return;
      const box = marker.getBoundingClientRect();
      showTooltip(markerTooltip(Number(marker.dataset.t)), box.left + box.width / 2, box.bottom);
    });
    dom.scrubMarkers.addEventListener("pointerleave", hideTooltip);
    dom.scrub.addEventListener("input", () => seek(Number(dom.scrub.value), false));
    dom.speed.addEventListener("input", onSpeedInput);
    document.addEventListener("keydown", onKeyDown);
    onSpeedInput();

    // Mode tabs
    dom.tabSimulate.addEventListener("click", () => openMode("simulate"));
    dom.tabCompare.addEventListener("click", () => openMode("compare"));

    // Gantt tooltips (hover and keyboard focus show the same thing)
    dom.ganttTrack.addEventListener("pointermove", (e) => {
      const block = e.target.closest(".g-block");
      const seg = e.target.closest(".l-seg");
      if (block) showTooltip(blockTooltip(gantt.blocks[Number(block.dataset.index)]), e.clientX, e.clientY);
      else if (seg) {
        const lane = gantt.lanes[Number(seg.dataset.lane)];
        showTooltip(laneTooltip(lane, lane.segs[Number(seg.dataset.seg)]), e.clientX, e.clientY);
      } else hideTooltip();
    });
    dom.ganttTrack.addEventListener("pointerleave", hideTooltip);
    dom.ganttTrack.addEventListener("focusin", (e) => {
      const node = e.target.closest(".g-block");
      if (!node) return;
      const box = node.getBoundingClientRect();
      showTooltip(blockTooltip(gantt.blocks[Number(node.dataset.index)]), box.left + box.width / 2, box.bottom);
    });
    dom.ganttTrack.addEventListener("focusout", hideTooltip);

    // Compare chart tooltips
    for (const ch of charts) {
      ch.canvas.addEventListener("pointermove", (e) => onChartPointer(ch, e));
      ch.canvas.addEventListener("pointerleave", () => {
        ch.hover = -1;
        drawChart(ch);
        hideTooltip();
      });
    }

    // Keep the drawings right when the window changes size
    new ResizeObserver(() => {
      if (state.mode !== "simulate" || !state.result) return;
      resizeFx();
      drawFlow();
      if (player.frame >= 0) placeTokens(state.result.frames[player.frame]);
    }).observe(dom.stage);
    new ResizeObserver(() => {
      if (state.mode === "simulate" && state.result) layoutGantt();
    }).observe(dom.ganttScroll);
    new ResizeObserver(() => {
      if (state.mode === "compare") charts.forEach(drawChart);
    }).observe(dom.charts);
    new ResizeObserver(() => {
      if (state.mode === "simulate" && state.result) layoutMarkers();
    }).observe(dom.scrub);

    // First workload: the textbook example, with SRTF
    applyOptions(state.options);
    loadPreset("textbook");
    requestAnimationFrame(loop);
  }

  init();

  // A read-only handle for debugging in the browser console.
  window.SchedulerUI = { state, player };
})();
