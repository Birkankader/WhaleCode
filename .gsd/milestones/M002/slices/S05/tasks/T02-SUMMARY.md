---
id: T02
parent: S05
milestone: M002
provides:
  - All inline-style hover handlers replaced with Tailwind hover: classes across 8 component files
  - Conditional hovers use cn() with state-dependent class inclusion
  - CommandPalette and Sidebar state-based mouse handlers preserved
key_files:
  - src/components/views/task-detail/TaskActions.tsx
  - src/components/views/CodeReviewView.tsx
  - src/components/views/CodeView.tsx
  - src/components/views/task-detail/TaskHeader.tsx
  - src/components/orchestration/DecompositionErrorCard.tsx
  - src/components/orchestration/StagePipeline.tsx
  - src/components/terminal/TerminalBottomPanel.tsx
  - src/components/layout/SetupPanel.tsx
key_decisions:
  - none
patterns_established:
  - When hover changes a property also set inline (background, border), move the base value to Tailwind classes so hover: can override it — inline styles always beat CSS classes
observability_surfaces:
  - none — pure CSS refactor with no runtime behavior changes
duration: 8m
verification_result: passed
completed_at: 2026-03-23
blocker_discovered: false
---

# T02: Replace inline-style hover handlers with Tailwind classes

**Replaced 16 onMouseEnter/onMouseLeave style-manipulation handler pairs across 8 components with Tailwind hover: classes, using cn() for conditional hovers**

## What Happened

Migrated all `onMouseEnter`/`onMouseLeave` handlers that manipulated `e.currentTarget.style.*` to declarative Tailwind `hover:` utility classes. Key patterns:

- **Brightness hovers** (Cancel, Retry, Merge, Merge All buttons): `hover:brightness-110` or `hover:brightness-[1.15]`, conditional via `cn()` when gated by loading states like `!cancelling`, `!retrying`, `!merging`, `!mergeAllInProgress`.
- **Background hovers** (dropdown options, tree items, worktree headers): `hover:bg-wc-surface-hover`. When the base `background` was inline, moved it to className (`bg-wc-surface`, `bg-transparent`) so hover classes can override.
- **Border hovers** (View Changes, Reassign, TaskHeader close): `hover:border-wc-accent` or `hover:border-wc-border-strong`. Required moving base `border` from inline style to className (`border border-wc-border`).
- **Multi-property hovers** (Edit & Retry, Switch Agent, Dismiss): Combined `hover:bg-wc-surface-hover hover:border-wc-accent hover:text-wc-text-primary` in className.

Added `cn` import to TaskActions, CodeReviewView, CodeView, DecompositionErrorCard, and SetupPanel.

## Verification

- `npx tsc --noEmit` — 0 errors
- `npx vitest run` — 94/94 pass
- `rg "onMouseEnter.*style\.|onMouseLeave.*style\." src/components/ --glob '*.tsx'` — 0 matches
- `rg "onMouseEnter" src/components/shared/CommandPalette.tsx` — preserved (state logic)
- `rg "onMouseEnter" src/components/layout/Sidebar.tsx` — preserved (timer logic)
- `rg "onMouseEnter|onMouseLeave" src/components/ --glob '*.tsx' -l` — only CommandPalette.tsx and Sidebar.tsx
- `rg "useShallow" src/components/ | wc -l` — 22 (unchanged)

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx tsc --noEmit` | 0 | ✅ pass | 3.9s |
| 2 | `npx vitest run` | 0 | ✅ pass | 3.9s |
| 3 | `rg "onMouseEnter.*style\.\|onMouseLeave.*style\." src/components/ --glob '*.tsx'` | 1 | ✅ pass (0 matches) | <1s |
| 4 | `rg "onMouseEnter\|onMouseLeave" src/components/ --glob '*.tsx' -l` | 0 | ✅ pass (only CommandPalette, Sidebar) | <1s |
| 5 | `rg "onMouseEnter" src/components/shared/CommandPalette.tsx` | 0 | ✅ pass (preserved) | <1s |
| 6 | `rg "onMouseEnter" src/components/layout/Sidebar.tsx` | 0 | ✅ pass (preserved) | <1s |
| 7 | `rg "useShallow" src/components/ \| wc -l` | 0 | ✅ pass (22) | <1s |

## Diagnostics

No new runtime diagnostics — this is a pure CSS refactor. Hover effects can be inspected via browser DevTools by toggling the `:hover` state on any migrated element and checking computed styles.

## Deviations

- For elements where hover needed to override inline `background` or `border`, moved those base properties from inline `style` to Tailwind className (e.g., `bg-wc-surface`, `border border-wc-border`). This was necessary because inline styles always beat CSS classes. The planner's description didn't call this out explicitly but it was the only correct approach.

## Known Issues

None.

## Files Created/Modified

- `src/components/views/task-detail/TaskActions.tsx` — 6 hover handler pairs replaced with Tailwind classes, cn() added for 4 conditional hovers
- `src/components/views/CodeReviewView.tsx` — 3 hover handler pairs replaced, cn() added for 2 conditional hovers
- `src/components/views/CodeView.tsx` — 1 conditional hover handler replaced, base background moved to className
- `src/components/views/task-detail/TaskHeader.tsx` — 1 hover handler pair replaced, border/background moved to className
- `src/components/orchestration/DecompositionErrorCard.tsx` — 5 hover handler pairs replaced, cn() added for conditional Switch Agent button
- `src/components/orchestration/StagePipeline.tsx` — 1 hover handler pair replaced with Tailwind hover classes
- `src/components/terminal/TerminalBottomPanel.tsx` — 1 hover handler pair replaced with hover:bg-wc-accent
- `src/components/layout/SetupPanel.tsx` — 3 hover handler pairs replaced, cn() added for conditional project directory button
