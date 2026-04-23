# Visual obs 04 — Apply summary overlay

**Recorded:** 2026-04-23 after a successful Apply on a 3-subtask plan.

## What to watch

- Landing: overlay fades in at `absolute bottom-4 right-4` over the canvas. Graph stays mounted underneath at its final layout.
- Contents: commit SHA (truncated to 7 chars), branch name, total files changed, per-worker row with `N files` chip.
- Per-worker click: React Flow `setCenter(cx, cy, { zoom })` using the current viewport zoom. Animated pan, no zoom change.
- Copy SHA: full 40-char SHA written to clipboard; truncated display keeps the surface compact.
- Dismiss: overlay slides out, store resets to `idle`, App.tsx routes back to `EmptyState`.

## Observations

1. **Graph mount-through worked as designed.** `App.tsx` no longer routes `status === 'applied'` to `EmptyState`; the overlay rides on top of a still-live graph.
2. **Event ordering held across dispatch.** `run:diff_ready → run:status_changed(Applied) → run:apply_summary` was stable across 5 runs. Frontend detach moved to `ApplySummary` to avoid dropping the tail event.
3. **Per-worker pan vs. fit** — using `setCenter` over `fitView` preserves the user's zoom. Verified by pinning zoom at 1.3× and clicking three worker rows in sequence; zoom stayed at 1.3× throughout.
4. **No obstruction** on the master node for plans up to 6 subtasks on a 1440×900 canvas. Manual check only.

## Regressions: none.
