# Visual obs 01 — running → done transition per worker state

**Recorded:** 2026-04-23, `pnpm tauri dev` on reference repo, real Claude worker.

## What to watch

- RUNNING: cyan ring pulsing, LogBlock streaming new lines at ~2-4 lines/second, agent chip visible.
- RETRYING: amber tick indicator appears overlaying the agent chip; LogBlock scrolls a `[retry N]` marker; ring re-pulses cyan.
- DONE: ring fades to neutral green, LogBlock frozen at last line, "N files" chip appears right of the agent chip, folder icon appears in the footer.
- FAILED: ring goes red, ErrorBanner copy keys on `errorCategory`, folder icon also appears (inspectable state).
- CANCELLED: ring fades to grey, LogBlock shows the tombstone line, folder icon still available.
- HUMAN_ESCALATION: card grows to 280px, EscalationActions surface in.

## Observations

1. RUNNING → DONE flip is crisp (~120ms). No content reflow jank — row-max alignment already reserved the 180px height tier during running so done doesn't push row-mates.
2. The new Step 5 error-category variant was tested via the `orchestrator-panic` and `timeout` fixtures — banner copy renders correctly on the first frame after the failure event. No flash-of-generic-copy artefact.
3. DONE's files-chip appears ~40ms after the state flip (waits for `run:subtask_diff`). Acceptable; users don't notice.
4. CANCELLED preserves the last log line — confirmed visually that `ExpandedLogBlock` and the tail `LogBlock` both show identical tails on a cancelled worker.

## Regressions: none.
