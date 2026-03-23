---
estimated_steps: 4
estimated_files: 14
skills_used:
  - react-best-practices
---

# T02: Add useShallow to all multi-selector Zustand components

**Slice:** S03 — Frontend State & Approval Flow
**Milestone:** M002

## Description

Zustand v5 is installed (`^5.0.11`) but `useShallow` is not used anywhere in the codebase. Components that call `useTaskStore` multiple times to select different properties (e.g., `tasks`, `orchestrationPhase`, `orchestrationLogs`) re-render on every store mutation because each individual selector call returns a new object reference when unrelated state changes. `useShallow` from `zustand/react/shallow` performs shallow comparison on the returned object, preventing re-renders when the selected properties haven't actually changed. This is R021.

**Key constraints:**
- Import from `zustand/react/shallow` (NOT `zustand/shallow` — that's the v4 path)
- Don't wrap function selectors (setters like `setOrchestrationPhase`) — they're stable references in Zustand stores. Select them individually.
- Don't wrap single-primitive selectors (e.g., just `orchestrationPhase` alone) — Zustand already uses `===` for primitives
- Don't put derived values like `Array.from(tasks.values())` inside the useShallow selector — those create new arrays each time, defeating shallow comparison. Keep them in `useMemo` outside the selector.

## Steps

1. **High-priority components** (3+ selectors, heavy render cost) — Add `useShallow` to:
   - `KanbanView.tsx` — consolidate `tasks`, `orchestrationPhase`, `orchestrationLogs` into one `useShallow` selector
   - `CodeReviewView.tsx` — consolidate `activePlan`, `orchestrationPlan`, `tasks`, `orchestrationLogs`, `worktreeEntries` into one `useShallow` selector. Keep `setOrchestrationPhase` as a separate individual call.
   - `TerminalView.tsx` — consolidate `tasks`, `orchestrationLogs` (aliased as `logs`), `orchestrationPhase`, `activePlan` into one `useShallow` selector. Keep `addOrchestrationLog` as separate. Note there's a second `useTaskStore` call for `orchestrationPlan` at line 144 — if it's in a sub-component, handle it there; if same component, include it.
   - `TaskApprovalView.tsx` — consolidate `tasks`, `activePlan`, `orchestrationPhase`
   - `WorkingView.tsx` — consolidate `tasks`, `orchestrationPhase`

2. **Medium-priority components** (2-3 selectors):
   - `DecompositionErrorCard.tsx` — consolidate `orchestrationPhase`, `tasks`, `orchestrationLogs`, `orchestrationPlan`
   - `DecomposingBanner.tsx` — consolidate `phase` (orchestrationPhase), `orchestrationPlan`, `activePlan`
   - `ContentHeader.tsx` — consolidate `tasks`, `orchestrationPhase`, `activePlan`
   - `Sidebar.tsx` — consolidate `orchestrationPhase`, `tasks`
   - `AppShell.tsx` — consolidate `orchestrationPhase`, `pendingQuestion`, `activePlan` (keep computed `doneTasks` and `totalTasks` as separate — they use derived values)
   - `StatusBar.tsx` — consolidate `orchestrationPhase`, `activePlan` (keep computed `doneTasks` and `totalTasks` as separate)
   - `TerminalBottomPanel.tsx` — consolidate `orchestrationLogs`, `orchestrationPhase`
   - `ProcessPanel.tsx` — consolidate `activePlan`, `agentContexts`
   - `ActivityPanel.tsx` — consolidate `activePlan`, `pendingQuestion`. Keep `setPendingQuestion` separate.

3. **Run TypeScript compiler** — `npx tsc --noEmit`. Fix any type errors from destructuring patterns. Common issue: if a component was using a renamed variable (e.g., `const logs = useTaskStore(s => s.orchestrationLogs)`), the destructured name must match or be aliased in the selector object.

4. **Run full test suite** — `npx vitest run`. Confirm all tests pass. Check `rg "useShallow" src/components/` shows 10+ matches confirming adoption.

## Must-Haves

- [ ] `useShallow` imported from `zustand/react/shallow` in each modified component
- [ ] All components with 2+ non-function `useTaskStore` selectors consolidated into a single `useShallow` call
- [ ] Function selectors (setters) remain as individual `useTaskStore` calls
- [ ] No derived values inside `useShallow` selectors
- [ ] `npx tsc --noEmit` — zero errors
- [ ] `npx vitest run` — full suite green

## Verification

- `npx tsc --noEmit` — zero errors
- `npx vitest run` — full suite green
- `rg "useShallow" src/components/` — 10+ matches confirming wide adoption
- No bare multi-property selectors remain: `rg 'useTaskStore\(' src/components/ | grep -v useShallow | grep -v '=> s\.' ` should show only function-selector lines and single-primitive selectors

## Inputs

- `src/components/views/KanbanView.tsx` — 3 separate useTaskStore calls
- `src/components/views/WorkingView.tsx` — 2 separate useTaskStore calls
- `src/components/views/CodeReviewView.tsx` — 6 separate useTaskStore calls
- `src/components/views/TaskApprovalView.tsx` — 3 separate useTaskStore calls
- `src/components/views/TerminalView.tsx` — 6 separate useTaskStore calls
- `src/components/orchestration/DecompositionErrorCard.tsx` — 4 separate useTaskStore calls
- `src/components/orchestration/DecomposingBanner.tsx` — 3 separate useTaskStore calls
- `src/components/layout/ContentHeader.tsx` — 3 separate useTaskStore calls
- `src/components/layout/Sidebar.tsx` — 2 separate useTaskStore calls
- `src/components/layout/AppShell.tsx` — 5 separate useTaskStore calls
- `src/components/layout/StatusBar.tsx` — 4 separate useTaskStore calls
- `src/components/terminal/TerminalBottomPanel.tsx` — 2 separate useTaskStore calls
- `src/components/terminal/ProcessPanel.tsx` — 2 separate useTaskStore calls
- `src/components/activity/ActivityPanel.tsx` — 3 separate useTaskStore calls

## Expected Output

- `src/components/views/KanbanView.tsx` — useShallow applied
- `src/components/views/WorkingView.tsx` — useShallow applied
- `src/components/views/CodeReviewView.tsx` — useShallow applied
- `src/components/views/TaskApprovalView.tsx` — useShallow applied
- `src/components/views/TerminalView.tsx` — useShallow applied
- `src/components/orchestration/DecompositionErrorCard.tsx` — useShallow applied
- `src/components/orchestration/DecomposingBanner.tsx` — useShallow applied
- `src/components/layout/ContentHeader.tsx` — useShallow applied
- `src/components/layout/Sidebar.tsx` — useShallow applied
- `src/components/layout/AppShell.tsx` — useShallow applied
- `src/components/layout/StatusBar.tsx` — useShallow applied
- `src/components/terminal/TerminalBottomPanel.tsx` — useShallow applied
- `src/components/terminal/ProcessPanel.tsx` — useShallow applied
- `src/components/activity/ActivityPanel.tsx` — useShallow applied
