# Visual obs 02 — worker log expand / collapse

**Recorded:** 2026-04-23 after content-fit fix (`56f5925`).

## Behaviour after three iteration rounds

Height ceiling shipped at 560 (spec) → 420 (post-Step-6) → 340 (post-verification screenshots) → content-fit `[200, 340]` (post-user-feedback).

## What to watch

- Collapsed: worker card on logs-state tier (180px). Click body → expands.
- Expanded empty: card lands on the floor (200px), "Waiting for output…" italic placeholder with blinking cursor in running state. No dead log area below.
- Expanded growing: card grows linearly as lines arrive (15px/line). User can watch the bottom edge push down in sympathy.
- Expanded capped: once the log passes ~14 lines, the card pins at 340 and the inner scroll takes over. Pinned-to-bottom scroll keeps the tail visible unless the user scrolls up; a 4px slop threshold un-pins on manual scroll.
- Collapse: second click returns to the state-tier height. Row-mates shrink with it via row-max.

## Observations

1. **Content-fit was the right outcome.** Fixed-340 felt too empty for "Waiting for output…" cards; content-fit makes the surface feel earned.
2. **Row-max still carries mixed-row state correctly.** Two expanded cards on the same row share the max of their two content-fit heights. A non-expanded neighbour rides up to match. No visual desync.
3. **Final/merge node visibility** — at max ceiling (340) on the default one-worker row, total stack is 712px. On a 14" laptop at ~800px usable height the merge card stays visible without panning. Verified against the user's earlier complaint.
4. **React Flow's initial-fit-once pattern matters.** Subsequent expands don't re-center — the card grows downward in place. If a user expands *after* zooming into the master, the bottom may clip; mitigated by the 340 ceiling, not by re-fitting.

## Regressions: none after iteration. Three rounds of user feedback (Bug cluster #1 in retro) caught what unit tests couldn't.
