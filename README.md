# CPU Scheduling Mission Control

An interactive CPU scheduling simulator for CS3608 (Operating Systems), written in
plain HTML, CSS and JavaScript: no libraries, no build step.

**Live:** https://rolan-lab.github.io/cpu-scheduler/

## Features

- Six algorithms: FCFS, SJF, SRTF, Priority (non-preemptive and preemptive, with
  optional aging) and Round Robin, plus a configurable context-switch cost
- An animated process state machine (NEW → READY → RUNNING → TERMINATED) with a CPU core
- A live Gantt chart with one lane per process, so waiting time is visible
- A "why" card for every scheduling decision, and event markers on the timeline
- Follow-a-process spotlight that traces one process's life cycle
- Compare mode: all six algorithms on the same workload, with charts and a results table
- Per-process waiting, turnaround and response times, following Silberschatz's definitions
- Presets, a seeded random workload generator, and JSON import/export

## Run it locally

Open `index.html` in a browser. Nothing to install.

Keyboard: Space plays or pauses, ←/→ steps one tick, Shift+←/→ jumps to the next
event, Esc stops following a process.

## Files

| File | Role |
|---|---|
| `engine.js` | The scheduling engine: pure functions, no DOM. It computes the whole run up front. |
| `ui.js` | Draws the engine's result. It never schedules anything itself. |
| `style.css` | The theme. |
| `index.html` | The page layout. |
| `tests.html` | Open it to run the engine's test suite. |

## Conventions

- Ties go to the earlier arrival, then the lower PID.
- Lower priority number = higher priority.
- Round Robin: a process that arrives at the instant a quantum expires joins the
  ready queue before the process whose quantum expired.
- A context-switch cost is charged only between two different processes (not at
  t = 0, and not when the CPU goes from idle to a process).
- Waiting time is time spent in the ready queue; time spent being switched in is
  reported separately as dispatch latency.
