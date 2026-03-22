# S01: Decomposition & Error Pipeline — UAT

**Milestone:** M001
**Written:** 2026-03-20

## UAT Type

- UAT mode: mixed (artifact-driven + live-runtime)
- Why this mode is sufficient: Contract-level changes (struct fields, event types, error paths) are fully verified by unit tests and grep checks. Runtime visual confirmation requires launching the GUI to verify the DecompositionErrorCard displays actual error text.

## Preconditions

- WhaleCode built and running (`cargo tauri dev` or production build)
- At least one CLI agent configured (Claude Code, Gemini CLI, or Codex CLI)
- A git repository open as the project directory

## Smoke Test

Submit any complex task through the orchestration UI (e.g., "Add a login page and a settings page"). If the master agent decomposes it and sub-tasks appear in the orchestration panel with IDs visible in the logs, the slice basically works.

## Test Cases

### 1. Successful decomposition preserves LLM-provided task IDs

1. Open WhaleCode, select a project
2. Submit a complex multi-step task that should decompose (e.g., "Create a user authentication module with login, registration, and password reset pages")
3. Wait for the master agent to return a decomposition
4. Open the Orchestration Logs panel (collapsible details in the task view)
5. **Expected:** Sub-task cards appear with IDs from the LLM's output (e.g., "login", "registration", "password_reset") rather than generic "t1", "t2", "t3". If the LLM didn't provide IDs, positional fallbacks like "t1", "t2" appear — this is also correct.

### 2. Decomposition failure shows specific backend error

1. Configure an agent with an invalid API key (or disconnect network to simulate auth failure)
2. Submit a task that triggers orchestrated decomposition
3. Wait for the decomposition to fail
4. **Expected:** The DecompositionErrorCard appears and displays the specific error message from the backend (e.g., "API key invalid", "connection refused", or the actual CLI error output) — NOT the generic "The master agent failed to decompose the task into sub-tasks" text
5. **Expected:** The Orchestration Logs panel shows an error-level log entry with the same error text

### 3. Decomposition failure with malformed JSON falls back gracefully

1. Submit a task through the GUI
2. If the master agent returns malformed/non-JSON output (may require prompt manipulation or a particularly difficult task)
3. **Expected:** The `@@orch::decomposition_failed` event fires (visible in orchestration logs as an error entry), then the system falls back to running the original prompt as a single task
4. **Expected:** The `@@orch::info` "Fallback: running original prompt as single task" message also appears in logs

### 4. Error during result.status === 'error' path

1. Trigger a scenario where the backend IPC command returns `{ status: 'error', error: '...' }` (e.g., spawn failure due to missing agent binary)
2. **Expected:** The error card shows the specific error from `result.error`, not generic fallback text
3. **Expected:** `masterTask.resultSummary` is populated (inspectable via React DevTools on the taskStore)

### 5. Error during catch block path

1. Trigger a scenario that throws an exception in `useOrchestratedDispatch` (e.g., unexpected IPC disconnect, invalid event data)
2. **Expected:** The error card shows the exception message
3. **Expected:** All running tasks are marked as failed

## Edge Cases

### Decomposition returns tasks without id field

1. If the LLM returns a JSON array of sub-tasks where some or all lack an `id` field
2. **Expected:** Tasks without IDs get positional IDs (`t1`, `t2`, etc.). Tasks with IDs keep their LLM-provided IDs. No crash, no deserialization error.

### Decomposition returns duplicate IDs

1. If the LLM returns two sub-tasks with the same `id` value
2. **Expected:** DAG construction should handle this without crashing. Behavior may be undefined for dependency resolution but should not panic.

### Rapid successive decomposition failures

1. Submit and cancel or let fail multiple orchestrations in quick succession
2. **Expected:** Each failure shows its own error in the error card. No stale errors from previous orchestrations leak through.

## Failure Signals

- DecompositionErrorCard displays "The master agent failed to decompose the task into sub-tasks" (generic text) — means resultSummary is not being set on the error path
- Orchestration Logs panel shows no error-level entries after a failed decomposition — means the `decomposition_failed` handler isn't firing
- Sub-tasks all show IDs like "t1", "t2" even though the LLM returned named IDs — means `SubTaskDef.id` isn't being preserved
- TypeScript compilation errors after build — means Specta bindings or OrchEvent types are mismatched

## Not Proven By This UAT

- dag_id-based task completion **matching** (S03 scope — this UAT only confirms the field exists on event types)
- Worktree isolation (S02 scope)
- activePlan timing during approval phase (S03 scope)
- Per-worker streaming output attribution (S03 scope)
- Review agent receiving worktree diffs (S04 scope)
- Selective merge through UI (S04 scope)

## Notes for Tester

- The full `cargo test` suite may take >10 minutes to compile from clean. Use `cargo test --lib commands::orchestrator` for the 48 orchestrator-specific tests (~1s after warm build).
- TypeScript types for `OrchEvent` are manually maintained. After any backend event changes, check `handleOrchEvent.ts` matches.
- The easiest way to trigger a decomposition failure for test case 2 is to set an invalid API key in WhaleCode's agent settings, then submit a task. The CLI agent will fail with an auth error that should propagate all the way to the error card.
- React DevTools can inspect `taskStore` state to verify `masterTask.resultSummary` is populated on error paths.
