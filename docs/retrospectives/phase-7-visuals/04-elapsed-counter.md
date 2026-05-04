# Visual obs 04 — ElapsedCounter formatting + per-surface sync (Step 4)

## What to watch

- Submit task; watch master node elapsed during planning.
- Watch worker card footers tick during running.
- Watch checklist row secondary lines tick.
- Cross-check: do all three surfaces show the same value at the
  same moment for the same subtask?
- Verify formatting at the <60s, <60min, ≥60min boundaries.
- Verify terminal-state freeze.

## Observations

- **Per-second tick.** Backend emits `RunEvent::ElapsedTick` every
  1000 ms while a subtask is running and while master is
  planning. Frontend renders the formatted value on each tick.
  CPU overhead at 6 concurrent workers + master: < 1% on an
  8-core M1 (verified via Activity Monitor sampling). The
  store's per-id Map updates are stable — no re-render storms.
- **Three surfaces synced from one slice.**
  `subtaskElapsed.get('a')` drives the WorkerNode footer counter,
  the PlanChecklist row's secondary line, and any future surface.
  Clicking through Activity Monitor while a worker ticks: all
  three show the same `0:34` value at the same paint frame. No
  drift.
- **Format thresholds.**
  - 0–59s: `0:42` (M:SS-style without leading 0 on minutes)
  - 1–59m: `12:34` (MM:SS, M can be 1-59)
  - ≥60m: `1:23:45` (H:MM:SS)
  Boundary transitions read cleanly — at 0:59 → 1:00 the layout
  doesn't shift width perceptibly (monospaced JetBrains Mono).
  At 59:59 → 1:00:00 the format adds a third segment but the
  counter's parent layout already reserved width for `0:00:00`,
  so no jump.
- **Master ElapsedCounter during planning.** The Phase 3.5
  `MasterLog` heartbeat ("still planning… (Ns elapsed)") is gone
  in Step 6 — folded into the per-second tick. The master node
  chip now shows `0:01`, `0:02`, … in real time without any log-
  line clutter. Plain Cursor parity.
- **Terminal freeze.** When a worker transitions to
  `done` / `failed` / `cancelled`, the backend emits one final
  ElapsedTick post-transition with the resolved value. The
  worker card freezes at e.g. `0:48` and never moves again. Same
  for master: planning resolves, master shows `0:14` permanently.
  The frozen value persists across reset events on the same run
  (reset only fires on new run / follow-up).

Regressions: none. Phase 4 Step 3 worker-card height tier still
applies; ElapsedCounter sits in the footer slot without disturbing
the LogBlock or chip stack vertical budget.
