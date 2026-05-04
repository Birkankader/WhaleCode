# Visual obs 06 — Banner primitive across 3 variants (Step 6)

## What to watch

- Trigger an error → ErrorBanner renders.
- Trigger a base-branch dirty stash → StashBanner renders.
- Trigger an auto-approve ceiling exceeded → AutoApproveSuspendedBanner
  renders.
- Visually compare: shared chrome (slide-down enter, accent bg,
  border-bottom, dismiss × top-right) consistent across all three.
- Verify variant-specific copy + actions still work end-to-end.

## Observations

- **Shared outer chrome consistent.** All three banners share:
  - Top-of-viewport absolute layout (z-10 above graph).
  - Framer-motion enter (`y: -100% → 0`, 200ms easeOut) and exit
    (reverse).
  - Accent background (10% alpha of variant fg) + 1px accent
    border-bottom.
  - Dismiss × button top-right (size-6, fg-secondary, hover →
    fg-primary).
  - Optional actions slot between content column and dismiss.
  Visual parity is exact — any of the three could be replaced
  with another at runtime and the chrome would match.
- **Variant accents.**
  - **Error** (`ErrorBanner` + StashBanner conflict variant):
    `--color-status-failed` (red).
  - **Warning** (`AutoApproveSuspendedBanner` + ErrorBanner with
    `variant="warning"` prop): `--color-status-pending` (amber).
  - **Info** (`StashBanner` held variant): `--color-status-running`
    (cyan).
  Color choice reads correctly at a glance — no banner that *is*
  an error renders in info-cyan.
- **ErrorBanner inner content** still works:
  - "Open resolver" button on merge conflict.
  - "Stash & retry apply" button on base-branch dirty.
  - Expandable details `<pre>` block when error has a multi-line
    stderr / stack body.
  - Category-locked headline (`subtaskErrorCategories`) takes
    precedence over free-form `currentError`; free-form text drops
    into the expandable detail.
  All of these now live in the children + actions slots of the
  Banner primitive — no functionality lost.
- **StashBanner inner content** still works:
  - "Pop stash" / "Popping…" disabled state.
  - Copy ref icon button with ✓ feedback.
  - Conflict variant swaps the description copy + hides the Pop
    button.
- **AutoApproveSuspendedBanner** is the simplest wrapper —
  variant=warning, single message line, dismiss. Roughly 30 lines
  of wrapper code now (vs ~70 before unification).
- **Component count delta.** Net 0: 3 wrapper files still exist,
  + 1 new primitive. But each wrapper shrank by 30-50 lines of
  duplicated chrome → primitive owns it. The next time a fourth
  banner is needed (e.g. Phase 8 multi-agent comparison signal),
  it's a thin wrapper, not a fresh chrome implementation.

Regressions: none. Banner-specific testids preserved
(`error-banner`, `stash-banner`, `auto-approve-suspended-banner`,
`error-banner-stash-retry`, `error-banner-open-resolver`,
`stash-banner-pop`, `stash-banner-copy`, `stash-banner-dismiss`).
All wrapper tests still pass.
