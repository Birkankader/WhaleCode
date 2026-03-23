# S03: Frontend State & Approval Flow — Research

**Date:** 2026-03-23
**Depth:** Targeted

## Summary

S03 is a frontend-only slice — all backend wiring was completed in S01 and S02. The remaining work is ensuring the frontend correctly consumes the events and data structures those slices established. The codebase is already closer to done than the roadmap suggests: `activePlan` is set from `phase_changed` events (S01 wired this), task completion matching uses `dag_id` via `dagToFrontendId` (not FIFO), worker output is attributed by `dag_id`, and manual approval is already the default with auto-approve opt-in.

The main gaps: (1) `useShallow` is not used anywhere despite Zustand v5 being installed — 20+ components select `tasks: Map` and re-render on every mutation, (2) the `subTaskQueue` array in `handleOrchEvent` is residual dead weight from the old FIFO approach, (3) one existing test is stale (expects `'running'` but handler correctly sets `'waiting'`), and (4) the promise-resolution `setActivePlan` in `useOrchestratedDispatch.ts:193` is redundant with the event-based path and should be guarded or removed.

## Recommendation

Work in three stages: (1) Fix the stale test and clean up the residual FIFO queue references, establishing correct test baselines. (2) Add `useShallow` to all components that select Maps or objects from Zustand stores. (3) Verify the full approval→execution→completion flow with the existing test suite. R024 (manual approval default) is already satisfied and just needs verification.

## Implementation Landscape

### Key Files

- `src/hooks/orchestration/handleOrchEvent.ts` — Central event handler. Already uses `dagToFrontendId` for completion matching. `subTaskQueue` is residual — only used for cleanup splicing, never for matching. The `worker_output` handler correctly routes by `dag_id`.
- `src/hooks/orchestration/useOrchestratedDispatch.ts` — Owns `subTaskQueue` and `dagToFrontendId` as local variables. Line 193 redundantly calls `setActivePlan` after promise resolution (the event-based path at `handleOrchEvent.ts:52` already sets it during decomposing). The `dagCounter` increment at line 59 is the only thing that still needs the queue-adjacent code.
- `src/stores/taskStore.ts` — Zustand store. All setters create new Map references (`new Map(state.tasks)`), which means `(s) => s.tasks` triggers re-renders on every task update. `useShallow` wrapping needed for any component selecting multiple properties.
- `src/components/views/TaskApprovalView.tsx` — Approval flow. Already has manual-by-default behavior (`autoApprove` defaults to `false` in uiStore). Countdown only fires when opt-in. Two inline DOM manipulation handlers (lines 466-467) are S05 scope, not S03.
- `src/components/views/WorkingView.tsx` — Displays `lastOutputLine` per task. Already uses individual `ElapsedTimer` components to avoid parent re-renders. Benefits from `useShallow` on its `tasks` selector.
- `src/components/views/KanbanView.tsx` — Heaviest consumer of `tasks` Map. Rebuilds `MappedTask[]` via `useMemo` on every `tasks` change. Primary `useShallow` beneficiary.
- `src/tests/handleOrchEvent.test.ts` — 22 tests, 1 failing. Line 88 expects `'running'` but handler correctly sets `'waiting'` (workers wait for `worker_started` event to transition to `'running'`).

### Consumers Needing `useShallow`

Components that select Maps or multiple store properties (from grep analysis):

| Component | Selectors | Priority |
|-----------|-----------|----------|
| `KanbanView.tsx` | `tasks`, `orchestrationPhase`, `orchestrationLogs` | High — re-renders most |
| `WorkingView.tsx` | `tasks`, `orchestrationPhase` | High |
| `TaskApprovalView.tsx` | `tasks`, `activePlan`, `orchestrationPhase` | Medium |
| `CodeReviewView.tsx` | `activePlan`, `orchestrationPlan`, `tasks`, `orchestrationLogs`, `setOrchestrationPhase`, `worktreeEntries` | High — 6 selectors |
| `TerminalView.tsx` | `tasks`, `orchestrationLogs`, `addOrchestrationLog`, `orchestrationPhase`, `activePlan` | Medium |
| `Sidebar.tsx` | `orchestrationPhase`, `tasks` | Low |
| `ContentHeader.tsx` | `tasks`, `orchestrationPhase`, `activePlan` | Low |
| `DecompositionErrorCard.tsx` | `orchestrationPhase`, `tasks`, `orchestrationLogs`, `orchestrationPlan` | Low |
| `StatusPanel.tsx` | `tasks` | Low |

Pattern: Replace multiple individual `useTaskStore((s) => s.X)` calls with a single `useTaskStore(useShallow((s) => ({ x: s.x, y: s.y })))` call. For components that select only a single primitive (like `Sidebar` selecting `orchestrationPhase`), `useShallow` is unnecessary — primitives are compared by value.

### Build Order

1. **Fix stale test + clean subTaskQueue** — Establishes green baseline. Update the test at line 88 to expect `'waiting'`. Audit `subTaskQueue` usage — it's still used for cleanup splicing in `task_completed`, `task_skipped`, `task_retrying` handlers but serves no functional purpose since matching is by `dag_id`. Remove or simplify.
2. **Guard/remove redundant setActivePlan** — The promise-resolution path at `useOrchestratedDispatch.ts:193` is harmless but misleading. Either guard it with `if (!taskState.activePlan)` or remove it, since the event-based path fires first and is the authoritative source.
3. **Add useShallow to high-priority components** — KanbanView, WorkingView, CodeReviewView first. Then medium/low priority. Each is independent — can be done per-component.
4. **Verify R024** — Run approval flow test confirming `autoApprove: false` default and no countdown.

### Verification Approach

- `npx vitest run src/tests/handleOrchEvent.test.ts` — all 22 tests green (currently 21 pass, 1 fail)
- `npx tsc --noEmit` — zero errors after useShallow additions
- `npx vitest run` — full test suite green
- `rg "useShallow" src/` — confirms adoption across target components
- `rg "subTaskQueue" src/` — confirms cleanup (fewer references or documented purpose)
- Contract check: `rg "useTaskStore.*=> s\.tasks" src/` shows no bare Map selectors without `useShallow` wrapping

## Constraints

- Zustand v5 `useShallow` import path is `zustand/react/shallow` (not `zustand/shallow`)
- Components that select a single primitive value (e.g., `orchestrationPhase` alone) do NOT need `useShallow` — Zustand already uses `===` comparison for primitives
- `useShallow` performs shallow comparison on the returned object — it works for `{ tasks, phase }` but NOT for derived values like `Array.from(tasks.values())` inside the selector (that creates a new array each time). Derived arrays should stay in `useMemo` outside the selector.
- The `tasks` Map itself is always a new reference on mutation (the `updateTask` helper creates `new Map(state.tasks)`). This is correct Zustand immutability — `useShallow` won't help for a single Map selector. The benefit comes when selecting multiple properties: without `useShallow`, changing `orchestrationLogs` re-renders a component that also selected `tasks` because the selector returns a new object reference.

## Common Pitfalls

- **useShallow on function selectors** — Don't wrap setters (e.g., `setOrchestrationPhase`) in `useShallow`. Functions are stable references in Zustand stores. Select them individually: `const setPhase = useTaskStore((s) => s.setOrchestrationPhase)`.
- **subTaskQueue removal breaking event handlers** — The queue is passed by reference from `useOrchestratedDispatch` into `handleOrchEvent`. Several handlers splice from it. Before removing, verify each handler — `task_completed`, `task_skipped`, `task_retrying` all touch it. The splicing is cleanup (removing completed tasks from the queue) but since the queue isn't used for matching anymore, the cleanup is pointless. Safe to remove if all handlers are updated simultaneously.
- **Stale test masking real regressions** — The existing test failure at line 88 must be fixed first. Running the full test suite with a known failure makes it easy to miss new failures.
