# S03: Frontend State & Approval Flow

**Goal:** Frontend correctly consumes S01/S02 backend events — activePlan set from events, task completion matched by dag_id, per-worker streaming attributed by task ID, manual approval default verified, residual FIFO code removed, and Zustand selectors use useShallow to prevent unnecessary re-renders.
**Demo:** All 22 handleOrchEvent tests pass (stale test fixed). `subTaskQueue` removed. `useShallow` adopted across all multi-selector components. TypeScript compiles cleanly.

## Must-Haves

- Stale test at handleOrchEvent.test.ts line 88 fixed (expect `'waiting'` not `'running'`)
- `subTaskQueue` array removed from `useOrchestratedDispatch.ts` and `handleOrchEvent.ts` (replaced by `dagToFrontendId`-based matching which already works)
- Redundant promise-path `setActivePlan` in `useOrchestratedDispatch.ts:193` guarded or removed
- `useShallow` from `zustand/react/shallow` used in all components that select 2+ non-function properties from Zustand stores
- All existing tests pass, TypeScript compiles with zero errors
- R006, R007, R010, R021, R024 satisfied (most already implemented — this slice verifies and cleans up)

## Verification

- `npx vitest run src/tests/handleOrchEvent.test.ts` — 22/22 pass (0 failures)
- `npx tsc --noEmit` — 0 errors
- `npx vitest run` — full suite green
- `rg "subTaskQueue" src/` — zero matches
- `rg "useShallow" src/components/` — 10+ matches across components
- `rg 'useTaskStore\(.*=> s\.' src/components/ | grep -v useShallow | grep -v '=> s\.\w\+)' --count` — no bare multi-property selectors remain without useShallow wrapping

## Tasks

- [x] **T01: Fix stale test, remove subTaskQueue, guard redundant setActivePlan** `est:45m`
  - Why: The stale test masks real regressions. `subTaskQueue` is residual dead weight from the old FIFO approach — matching already uses `dagToFrontendId`. The promise-path `setActivePlan` at line 193 is redundant with the event-based path. Cleaning these up establishes a green test baseline and proves R006/R007/R010/R024.
  - Files: `src/tests/handleOrchEvent.test.ts`, `src/hooks/orchestration/handleOrchEvent.ts`, `src/hooks/orchestration/useOrchestratedDispatch.ts`
  - Do: (1) Fix test line 88 to expect `'waiting'` instead of `'running'`. (2) Remove `subTaskQueue` parameter from `handleOrchEvent` function signature and all splice/push/findIndex operations on it. Update all callers. (3) Remove `subTaskQueue` declaration and passing in `useOrchestratedDispatch.ts`. (4) Guard the promise-path `setActivePlan` with `if (!taskState.activePlan)` so it only fires if the event-path didn't already set it. (5) Update test helper `freshContext` to remove `subTaskQueue`. (6) Run all tests.
  - Verify: `npx vitest run src/tests/handleOrchEvent.test.ts` — 22/22 pass. `rg "subTaskQueue" src/` — zero matches. `npx tsc --noEmit` — 0 errors.
  - Done when: All handleOrchEvent tests green, subTaskQueue fully removed, TypeScript clean.

- [x] **T02: Add useShallow to all multi-selector Zustand components** `est:1h`
  - Why: Zustand v5 is installed but `useShallow` is unused. Components selecting 2+ properties (especially Maps + primitives) re-render on every store mutation because the selector returns a new object reference. This is R021.
  - Files: `src/components/views/KanbanView.tsx`, `src/components/views/WorkingView.tsx`, `src/components/views/CodeReviewView.tsx`, `src/components/views/TaskApprovalView.tsx`, `src/components/views/TerminalView.tsx`, `src/components/orchestration/DecompositionErrorCard.tsx`, `src/components/orchestration/DecomposingBanner.tsx`, `src/components/layout/ContentHeader.tsx`, `src/components/layout/Sidebar.tsx`, `src/components/layout/AppShell.tsx`, `src/components/layout/StatusBar.tsx`, `src/components/terminal/TerminalBottomPanel.tsx`, `src/components/terminal/ProcessPanel.tsx`, `src/components/activity/ActivityPanel.tsx`
  - Do: For each component with 2+ non-function `useTaskStore` calls selecting different properties: (1) Import `useShallow` from `zustand/react/shallow`. (2) Consolidate into a single `useTaskStore(useShallow((s) => ({ prop1: s.prop1, prop2: s.prop2 })))` call. (3) Keep function selectors (setters) as separate individual calls — they're stable references. (4) Keep single-primitive selectors as-is — `useShallow` adds no value there. (5) Do NOT put derived values (like `Array.from(tasks.values())`) inside the useShallow selector — keep those in `useMemo`. Run full test suite and tsc after all changes.
  - Verify: `npx tsc --noEmit` — 0 errors. `npx vitest run` — full suite green. `rg "useShallow" src/components/` — 10+ matches.
  - Done when: All multi-selector components use useShallow, TypeScript clean, tests green.

## Files Likely Touched

- `src/tests/handleOrchEvent.test.ts`
- `src/hooks/orchestration/handleOrchEvent.ts`
- `src/hooks/orchestration/useOrchestratedDispatch.ts`
- `src/components/views/KanbanView.tsx`
- `src/components/views/WorkingView.tsx`
- `src/components/views/CodeReviewView.tsx`
- `src/components/views/TaskApprovalView.tsx`
- `src/components/views/TerminalView.tsx`
- `src/components/orchestration/DecompositionErrorCard.tsx`
- `src/components/orchestration/DecomposingBanner.tsx`
- `src/components/layout/ContentHeader.tsx`
- `src/components/layout/Sidebar.tsx`
- `src/components/layout/AppShell.tsx`
- `src/components/layout/StatusBar.tsx`
- `src/components/terminal/TerminalBottomPanel.tsx`
- `src/components/terminal/ProcessPanel.tsx`
- `src/components/activity/ActivityPanel.tsx`

## Observability / Diagnostics

- **Runtime signals:** `orchestrationLogs` in Zustand store captures all phase transitions, task assignments, completions, and failures — inspectable via devtools or the Activity panel.
- **Inspection surfaces:** `npx vitest run src/tests/handleOrchEvent.test.ts` (22 tests) covers all event types. `npx tsc --noEmit` catches stale callers after signature changes.
- **Failure visibility:** `console.warn` on unmatched `dag_id` in task_completed/task_failed. Promise-path `setActivePlan` only fires as fallback when event path didn't set it — if `activePlan` is unexpectedly null, check `orchestrationPhase` transitions in logs.
- **Redaction:** No secrets or credentials flow through the event handler or Zustand store.
