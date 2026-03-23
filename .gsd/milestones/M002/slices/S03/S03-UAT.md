# S03: Frontend State & Approval Flow — UAT

**Milestone:** M002
**Written:** 2026-03-23

## UAT Type

- UAT mode: artifact-driven
- Why this mode is sufficient: S03 is a state management cleanup slice — all deliverables are verifiable through automated tests, grep checks, and code inspection. No runtime GUI interaction is needed because the changes are structural (dead code removal, selector optimization, timing guard) rather than behavioral.

## Preconditions

- Node.js and npm/npx available
- Project dependencies installed (`npm install` or equivalent)
- Working directory is the WhaleCode project root

## Smoke Test

Run `npx vitest run src/tests/handleOrchEvent.test.ts` — all 22 tests pass, confirming the event handler works correctly with dagToFrontendId matching and without subTaskQueue.

## Test Cases

### 1. subTaskQueue fully removed

1. Run `grep -r "subTaskQueue" src/`
2. **Expected:** Zero matches. The term should not appear anywhere in the `src/` directory — not in handlers, hooks, tests, or type definitions.

### 2. handleOrchEvent test suite green

1. Run `npx vitest run src/tests/handleOrchEvent.test.ts`
2. **Expected:** 22/22 tests pass. Specifically verify:
   - `executing phase` test expects task status `'waiting'` (not `'running'`)
   - `task_completed` tests use dagToFrontendId matching
   - `handles missing dag_id gracefully` emits a console.warn (visible in stderr)

### 3. Full test suite green

1. Run `npx vitest run`
2. **Expected:** 94/94 tests pass across 8 test files. No failures, no skipped tests.

### 4. TypeScript compiles cleanly

1. Run `npx tsc --noEmit`
2. **Expected:** Exit code 0 with no output. No type errors from removed subTaskQueue parameter or useShallow changes.

### 5. useShallow adopted across all multi-selector components

1. Run `grep -r "useShallow" src/components/ | wc -l`
2. **Expected:** 30 matches (15 import lines + 15 usage lines).
3. Run `grep -r "useShallow" src/components/` and verify these 15 components are covered:
   - KanbanView, CodeReviewView, TerminalView, TaskApprovalView, WorkingView
   - DecompositionErrorCard, DecomposingBanner, StagePipeline
   - ContentHeader, Sidebar, AppShell, StatusBar
   - TerminalBottomPanel, ProcessPanel, ActivityPanel
4. **Expected:** All 15 listed above have both an import and a usage of `useShallow`.

### 6. No bare multi-property selectors remain

1. Run `grep -rn 'useTaskStore(' src/components/ | grep -v useShallow | grep -v getState`
2. Inspect each match.
3. **Expected:** Every remaining `useTaskStore` call without `useShallow` falls into one of:
   - Single property selector: `(s) => s.propertyName`
   - Setter selector: `(s) => s.setXxx`
   - Derived/computed selector: `(s) => { ... return computed }`
   - No bare `useTaskStore((s) => ({ a: s.a, b: s.b }))` without `useShallow` wrapping.

### 7. activePlan event-path set during decomposing phase

1. Open `src/hooks/orchestration/handleOrchEvent.ts`
2. Find the `phase_changed` → `decomposing` handler (around line 49-53)
3. **Expected:** `store.setActivePlan(...)` is called with plan details extracted from the event payload. This runs during Phase 1, before the approval screen appears.

### 8. activePlan promise-path guarded as fallback

1. Open `src/hooks/orchestration/useOrchestratedDispatch.ts`
2. Find the `setActivePlan` call (around line 192)
3. **Expected:** Wrapped in `if (!taskState.activePlan)` — only fires when the event-path didn't already set it.

### 9. Manual approval is default (no countdown)

1. Open `src/stores/uiStore.ts` and find `autoApprove` default.
2. **Expected:** `autoApprove: false` in the initial state.
3. Open `src/components/views/TaskApprovalView.tsx` and find the countdown logic.
4. **Expected:** Countdown timer only starts when `autoApprove` is `true` (gated behind `if (autoApprove)`). Default behavior: approval screen waits indefinitely.

## Edge Cases

### Missing dag_id in task_completed event

1. Run `npx vitest run src/tests/handleOrchEvent.test.ts -t "handles missing dag_id"`
2. **Expected:** Test passes. Handler logs a `console.warn` and does not crash or update the wrong task.

### Unknown event type

1. Run `npx vitest run src/tests/handleOrchEvent.test.ts -t "unknown event"`
2. **Expected:** Test passes. Unknown events are silently ignored without errors.

### Multiple same-agent workers completing (interleaved events)

1. Review the `task_completed` handler in `handleOrchEvent.ts` — verify it uses `dagToFrontendId.get(ev.dag_id)` lookup, not array index or FIFO shift.
2. **Expected:** Each completion event matches its specific task via dag_id, regardless of arrival order.

## Failure Signals

- Any `vitest` test failure in `handleOrchEvent.test.ts` — indicates event handler regression
- `tsc --noEmit` producing errors — indicates type signature mismatch after subTaskQueue removal
- `grep "subTaskQueue" src/` finding matches — indicates incomplete removal
- `useShallow` count below 30 — indicates a component was missed or regressed
- `activePlan` being null during approval in a live run — indicates event-path setActivePlan failed

## Requirements Proved By This UAT

- R006 — Test cases 7, 8, 9 prove activePlan availability at approval time and manual approval default
- R007 — Test cases 1, 2 prove FIFO queue removed and dagToFrontendId matching works
- R010 — Test case 2 (worker_output event handling) proves per-worker streaming attribution via dag_id
- R021 — Test cases 5, 6 prove useShallow adoption and no bare multi-selectors
- R024 — Test case 9 proves manual approval default with no countdown

## Not Proven By This UAT

- R010 live streaming with real agent processes — requires running actual CLI agents (S06)
- useShallow render performance improvement — requires React DevTools Profiler measurement, not functional testing
- activePlan timing under real network latency — requires live orchestration run

## Notes for Tester

- The `act(...)` warnings in AppShell tests are pre-existing and unrelated to S03 changes — they come from OnboardingWizard state updates.
- The `--localstorage-file` warnings in test output are Node.js configuration noise, not test failures.
- If running grep checks on a system without `rg`, use `grep -r` as shown in the test cases above.
