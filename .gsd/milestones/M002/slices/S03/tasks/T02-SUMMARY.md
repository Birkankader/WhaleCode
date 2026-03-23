---
id: T02
parent: S03
milestone: M002
provides:
  - useShallow adopted across all 15 multi-selector Zustand components
  - Re-render prevention for unrelated store mutations
key_files:
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
  - Function selectors (setters) left as individual calls — stable Zustand references don't benefit from useShallow
  - Derived selectors (doneTasks, totalTasks) left as individual calls — computed values would defeat shallow comparison
  - StagePipeline added to useShallow adoption even though not in original plan — it had 2 non-function selectors that would have been flagged by verification
patterns_established:
  - useShallow from zustand/react/shallow wraps multi-property object selectors; single primitives and functions stay individual
  - Aliased destructuring (e.g., orchestrationLogs -> logs) works inside the useShallow selector object
observability_surfaces:
  - No runtime signal changes — this is a render optimization only
  - React DevTools Profiler can verify reduced re-renders on unrelated store mutations
duration: 12m
verification_result: passed
completed_at: 2026-03-23
blocker_discovered: false
---

# T02: Add useShallow to all multi-selector Zustand components

**Applied useShallow from zustand/react/shallow to 15 components, consolidating 40+ individual useTaskStore selectors into shallow-compared object selectors to prevent unnecessary re-renders.**

## What Happened

1. Added `import { useShallow } from 'zustand/react/shallow'` to each component with 2+ non-function `useTaskStore` selectors.
2. Consolidated individual selector calls into single `useTaskStore(useShallow((s) => ({ ... })))` calls with destructured returns.
3. Kept function selectors (setOrchestrationPhase, addOrchestrationLog, setPendingQuestion, etc.) as separate individual calls — they're stable references in Zustand stores and don't benefit from shallow comparison.
4. Kept derived-value selectors (doneTasks count, totalTasks size) as separate individual calls — they compute new values each time, which would defeat useShallow.
5. Handled the TerminalView alias pattern: `orchestrationLogs` aliased as `logs` directly in the selector object (`orchestrationLogs: s.orchestrationLogs`) with destructured rename at the call site.
6. Folded the standalone `orchestrationPlan` selector at line 144 of TerminalView into the main useShallow call — it was in the same component, not a sub-component.
7. Also added useShallow to StagePipeline.tsx (not in original plan) — it had `orchestrationPlan` and `activePlan` as two adjacent non-function selectors.

## Verification

- `npx tsc --noEmit` — zero errors ✅
- `npx vitest run` — 94/94 pass (8 test files) ✅
- `npx vitest run src/tests/handleOrchEvent.test.ts` — 22/22 pass ✅
- `rg "useShallow" src/components/` — 30 lines (15 imports + 15 usages) ✅
- `rg "subTaskQueue" src/` — zero matches ✅
- Remaining bare `useTaskStore(s => s.*)` calls are all function selectors, single primitives, or derived values — correct by design

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx tsc --noEmit` | 0 | ✅ pass | 4.7s |
| 2 | `npx vitest run` | 0 | ✅ pass | 1.0s |
| 3 | `npx vitest run src/tests/handleOrchEvent.test.ts` | 0 | ✅ pass | 0.3s |
| 4 | `rg "useShallow" src/components/ \| wc -l` | 0 (30 matches) | ✅ pass | 0.1s |
| 5 | `rg "subTaskQueue" src/` | 1 (no matches) | ✅ pass | 0.1s |

## Diagnostics

- `rg "useShallow" src/components/` — confirms which components have shallow selectors
- `rg 'useTaskStore\(.*=> s\.' src/components/ | grep -v useShallow` — should show only function/single-value selectors
- React DevTools Profiler — measure re-render counts before/after to quantify improvement
- No runtime behavior change — this is purely a render optimization

## Deviations

- Added StagePipeline.tsx to useShallow adoption (not in original plan) — it had 2 non-function selectors (`orchestrationPlan`, `activePlan`) that would have been flagged by the bare-selector verification check. 15 total components instead of the planned 14.

## Known Issues

None.

## Files Created/Modified

- `src/components/views/KanbanView.tsx` — Consolidated 3 selectors (tasks, orchestrationPhase, orchestrationLogs) into useShallow
- `src/components/views/CodeReviewView.tsx` — Consolidated 5 data selectors into useShallow, kept setOrchestrationPhase separate
- `src/components/views/TerminalView.tsx` — Consolidated 5 data selectors (including alias logs→orchestrationLogs and orchestrationPlan from line 144) into useShallow, kept addOrchestrationLog separate
- `src/components/views/TaskApprovalView.tsx` — Consolidated 3 selectors into useShallow
- `src/components/views/WorkingView.tsx` — Consolidated 2 selectors into useShallow
- `src/components/orchestration/DecompositionErrorCard.tsx` — Consolidated 4 selectors into useShallow
- `src/components/orchestration/DecomposingBanner.tsx` — Consolidated 3 selectors (with alias phase→orchestrationPhase) into useShallow
- `src/components/orchestration/StagePipeline.tsx` — Consolidated 2 selectors into useShallow (bonus component, not in plan)
- `src/components/layout/ContentHeader.tsx` — Consolidated 3 selectors into useShallow
- `src/components/layout/Sidebar.tsx` — Consolidated 2 selectors into useShallow
- `src/components/layout/AppShell.tsx` — Consolidated 3 selectors into useShallow, kept derived doneTasks/totalTasks separate
- `src/components/layout/StatusBar.tsx` — Consolidated 2 selectors into useShallow, kept derived doneTasks/totalTasks separate
- `src/components/terminal/TerminalBottomPanel.tsx` — Consolidated 2 selectors into useShallow
- `src/components/terminal/ProcessPanel.tsx` — Consolidated 2 selectors into useShallow
- `src/components/activity/ActivityPanel.tsx` — Consolidated 2 selectors into useShallow, kept setPendingQuestion separate
