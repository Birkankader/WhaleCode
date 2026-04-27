# Visual obs 02 — reasoning / thinking panel (Step 3)

## What to watch

- Toggle "Show thinking" on a Claude running worker, then on a
  Codex and a Gemini worker (capability gating).
- Verify the panel's italicized + muted styling above the log
  tail, the default-collapsed-at-3-chunks affordance, the
  500-chunk cap, the empty-state placeholder, and per-worker
  toggle independence.

## Observations

- **Claude worker (capable).** Brain icon button enables. Click
  → `ThinkingPanel` slides in above log tail. Italic, muted
  foreground (the `text-fg-muted` token from
  `docs/design-system.md`), one chunk per `<thinking>` block as
  it streams in. Visually distinct from log lines without
  competing with them — easy eye-skip when not interested.
- **Default collapsed.** First 3 chunks render, then a "Show all
  N thinking chunks" affordance appears below. Click expands
  through to the 500-cap. Pattern mirrors Phase 4 Step 3's log
  expand affordance — same component shape, same animation.
- **Empty state.** Toggling on before any thinking has streamed
  shows "Waiting for reasoning…" placeholder in the same
  italic-muted style. Reads as quiet, not as broken — important
  because Claude can take 5-10s before the first thinking block
  on heavy tasks.
- **Codex worker (incapable).** Brain icon button greyed out,
  cursor `not-allowed`, tooltip "Reasoning surface not available
  for Codex workers" on hover. Click is no-op (verified store
  action also no-ops via `supportsThinking` capability gate, not
  just UI guard).
- **Gemini worker (incapable).** Same greyed treatment as Codex.
  Tooltip wording is adapter-specific.
- **Per-worker independence.** Two Claude workers in the same
  run, toggle on for worker A only — worker B's panel stays
  hidden, worker B's store still accumulates chunks (verified
  via dev tools), so toggling B on later shows the full backlog
  not just from-toggle-time.
- **Persistence scope.** Toggle state survives within session
  (re-entering Running state on hint restart preserves it,
  per Step 4 cross-step verification). Does not survive app
  restart. Matches spec.

Regressions: none. WorkerNode card layout below the panel
(activity chips, log tail, footer) renders unchanged.
