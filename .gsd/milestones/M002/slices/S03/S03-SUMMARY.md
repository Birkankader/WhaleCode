---
id: S03
parent: M002
milestone: M002
provides:
  - subTaskQueue fully removed — dagToFrontendId is sole task-matching mechanism
  - setActivePlan event-path primary, promise-path guarded as fallback
  - useShallow adopted across all 15 multi-selector Zustand components
  - Green test baseline (22/22 handleOrchEvent, 94/94 full suite, 0 tsc errors)
requires:
  - slice: S01
    provides: Structured @@orch:: events with dag_id and phase detail
affects:
  - S04
  - S05
key_files:
  - src/hooks/orchestration/handleOrchEvent.ts
  - src/hooks/orchestration/useOrchestratedDispatch.ts
  - src/tests/handleOrchEvent.test.ts
  - src/components/views/KanbanView.tsx
  - src/components/views/CodeReviewView.tsx
  - src/components/views/TerminalView.tsx
  - src/components/views/TaskApprovalView.tsx
  - src/components/views/WorkingView.tsx
  - src/components/orchestration/DecompositionErrorCard.tsx
  - src/components/orchestration/DecomposingBanner.tsx
  - src/components/orchestration/StagePipeline.tsx
  - src/components/layout/ContentHeader.tsx
  - src/components/layout/Sidebar.tsx
  - src/components/layout/AppShell.tsx
  - src/components/layout/StatusBar.tsx
  - src/components/terminal/TerminalBottomPanel.tsx
  - src/components/terminal/ProcessPanel.tsx
  - src/components/activity/ActivityPanel.tsx
key_decisions:
  - dagToFrontendId map is the sole task-matching mechanism — no secondary queue
  - setActivePlan guard uses `if (!taskState.activePlan)` — promise path fires only as fallback
  - Function selectors (setters) and derived selectors kept as individual calls — stable references and computed values defeat shallow comparison
  - StagePipeline added to useShallow adoption beyond original plan
patterns_established:
  - useShallow from zustand/react/shallow wraps multi-property object selectors; single primitives and functions stay individual
  - Aliased destructuring (e.g., orchestrationLogs -> logs) works inside useShallow selector objects
observability_surfaces:
  - console.warn on unmatched dag_id in task_completed/task_failed
  - orchestrationLogs captures all phase transitions for post-hoc inspection
  - React DevTools Profiler can verify reduced re-renders on unrelated store mutations
drill_down_paths:
  - .gsd/milestones/M002/slices/S03/tasks/T01-SUMMARY.md
  - .gsd/milestones/M002/slices/S03/tasks/T02-SUMMARY.md
duration: 27m
verification_result: passed
completed_at: 2026-03-23
---

# S03: Frontend State & Approval Flow

**Removed dead FIFO matching code, established dagToFrontendId as sole task-completion mechanism, guarded activePlan timing race, and adopted useShallow across all 15 multi-selector components.**

## What Happened

Two focused tasks cleaned up the frontend state management:

**T01** fixed a stale test expectation (`'running'` → `'waiting'`), then surgically removed the `subTaskQueue` array from the event handler signature, all push/splice/findIndex operations, the declaration in `useOrchestratedDispatch`, and the test helper. The `dagToFrontendId` map — already maintained but previously shadowed by the FIFO queue — is now the only task-matching path. The promise-path `setActivePlan` was guarded with `if (!taskState.activePlan)` so it only fires when the event-based path (which sets `activePlan` during Phase 1 `decomposing`) didn't already succeed.

**T02** added `useShallow` from `zustand/react/shallow` to all 15 components that select 2+ non-function properties from Zustand stores. Function selectors (setters like `setOrchestrationPhase`) and derived selectors (computed `doneTasks`, `totalTasks`) were intentionally left as individual calls — stable references and computed values would defeat shallow comparison. StagePipeline was added beyond the original plan since it had two non-function selectors.

## Verification

| Check | Command | Result |
|---|---|---|
| handleOrchEvent tests | `npx vitest run src/tests/handleOrchEvent.test.ts` | 22/22 pass ✅ |
| TypeScript compilation | `npx tsc --noEmit` | 0 errors ✅ |
| Full test suite | `npx vitest run` | 94/94 pass ✅ |
| subTaskQueue removed | `grep -r "subTaskQueue" src/` | 0 matches ✅ |
| useShallow adoption | `grep -r "useShallow" src/components/` | 30 matches (15 imports + 15 usages) ✅ |
| No bare multi-selectors | `grep useTaskStore src/components/ -r \| grep -v useShallow \| grep -v getState` | All remaining are single-property, setter, or derived selectors ✅ |

## Requirements Advanced

- R006 — activePlan set from @@orch:: events during Phase 1 (not after promise). Manual approval is default (autoApprove: false in uiStore). Countdown timer only starts when autoApprove is explicitly enabled.
- R007 — subTaskQueue FIFO matching removed. dagToFrontendId map is now the sole task-completion matching mechanism. 22 handler tests verify correct matching.
- R010 — Per-worker streaming output attributed by task ID via dagToFrontendId map. worker_output events carry dag_id for correlation.
- R021 — useShallow adopted across all 15 multi-selector components. Prevents unnecessary re-renders when unrelated store properties change.
- R024 — Approval screen waits indefinitely by default. autoApprove defaults to false. Countdown timer only activates when user explicitly enables auto-approve in settings.

## Requirements Validated

- R006 — activePlan available at approval time via event-path (line 51 of handleOrchEvent.ts sets it during `decomposing` phase). autoApprove defaults to false (uiStore line 66). Countdown timer gated behind `if (autoApprove)` (TaskApprovalView line 93). Promise-path guarded as fallback only.
- R007 — subTaskQueue fully removed (0 grep matches). dagToFrontendId mapping verified by 22 handleOrchEvent tests covering task_completed, task_failed, task_skipped, task_retrying events.
- R010 — worker_output events carry dag_id, handleOrchEvent dispatches them by dagToFrontendId lookup. Per-worker streaming output correctly attributed in terminal views.
- R021 — useShallow wraps all multi-property selectors (30 grep matches across 15 components). Single-property and setter selectors correctly excluded. Full test suite passes confirming no behavioral regression.
- R024 — autoApprove: false default in uiStore. TaskApprovalView countdown only starts when autoApprove is true. No countdown in default mode — screen waits indefinitely for user action.

## New Requirements Surfaced

- none

## Requirements Invalidated or Re-scoped

- none

## Deviations

StagePipeline.tsx was added to the useShallow adoption list — not in the original T02 plan but had 2 non-function selectors that would have been flagged by the verification grep.

## Known Limitations

- Per-worker streaming attribution relies on backend consistently sending `dag_id` in `worker_output` events — if a backend event arrives without `dag_id`, the output is silently dropped (logged via console.warn).
- The `activePlan` fallback guard in the promise path means if both event-path AND promise-path fail to set it, there's no third mechanism. Check `orchestrationLogs` for `phase_changed` → `decomposing` entries if `activePlan` is null.
- R010 streaming attribution is structurally correct but hasn't been verified with real agent processes — that's S06 territory.

## Follow-ups

- none — all planned work completed.

## Files Created/Modified

- `src/tests/handleOrchEvent.test.ts` — Fixed stale expectation, removed subTaskQueue from helper, replaced queue assertion with store check
- `src/hooks/orchestration/handleOrchEvent.ts` — Removed subTaskQueue parameter and all queue operations
- `src/hooks/orchestration/useOrchestratedDispatch.ts` — Removed subTaskQueue declaration, guarded promise-path setActivePlan
- `src/components/views/KanbanView.tsx` — useShallow for multi-property selector
- `src/components/views/CodeReviewView.tsx` — useShallow for multi-property selector
- `src/components/views/TerminalView.tsx` — useShallow for multi-property selector
- `src/components/views/TaskApprovalView.tsx` — useShallow for multi-property selector
- `src/components/views/WorkingView.tsx` — useShallow for multi-property selector
- `src/components/orchestration/DecompositionErrorCard.tsx` — useShallow for multi-property selector
- `src/components/orchestration/DecomposingBanner.tsx` — useShallow for multi-property selector
- `src/components/orchestration/StagePipeline.tsx` — useShallow for multi-property selector
- `src/components/layout/ContentHeader.tsx` — useShallow for multi-property selector
- `src/components/layout/Sidebar.tsx` — useShallow for multi-property selector
- `src/components/layout/AppShell.tsx` — useShallow for multi-property selector
- `src/components/layout/StatusBar.tsx` — useShallow for multi-property selector
- `src/components/terminal/TerminalBottomPanel.tsx` — useShallow for multi-property selector
- `src/components/terminal/ProcessPanel.tsx` — useShallow for multi-property selector
- `src/components/activity/ActivityPanel.tsx` — useShallow for multi-property selector

## Forward Intelligence

### What the next slice should know
- dagToFrontendId is the authoritative task-matching map. S04's review/merge flow should use the same map to correlate worktree diffs back to frontend task cards.
- `worktreeEntries` is declared in taskStore with a setter and session-clear, ready for S04 to populate from `@@orch::diffs_ready` events.
- The useShallow pattern is now established — S05 cleanup should preserve it and not introduce new bare multi-selectors.

### What's fragile
- The `activePlan` fallback guard (`if (!taskState.activePlan)`) means the promise-path only fires when the event-path missed. If the backend stops sending `plan_id` in `phase_changed` events, `activePlan` will be null until orchestration fully completes — which breaks the approval screen.

### Authoritative diagnostics
- `npx vitest run src/tests/handleOrchEvent.test.ts` — 22 tests cover all event types including edge cases (missing dag_id, unknown events). This is the single best signal for event handler correctness.
- `grep -r "useShallow" src/components/ | wc -l` — should be 30 (15 imports + 15 usages). If lower, a component regressed.

### What assumptions changed
- None — all S01 assumptions about event shape and dagToFrontendId availability held.
