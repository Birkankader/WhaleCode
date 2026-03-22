# S02 UAT: Worktree Isolation & Parallel Workers

## Preconditions

- WhaleCode project has a valid git repository (`.git/` exists)
- The `src-tauri/` crate compiles (`cargo check --lib` from `src-tauri/`)
- At least one CLI agent is configured (Claude Code, Gemini CLI, or Codex CLI)
- No stale `.whalecode-worktrees/` directory from a previous run

---

## Test Case 1: Worktree Creation During Orchestration Dispatch

**Goal:** Verify that each orchestrated worker gets its own worktree, not the project directory.

**Steps:**
1. Open WhaleCode and select a project directory.
2. Submit a task that decomposes into 2+ sub-tasks (e.g., "Create a REST API with two endpoints: GET /users and POST /users, each in a separate file").
3. When the decomposition plan appears, approve it.
4. During execution, check the filesystem:
   ```bash
   ls .whalecode-worktrees/
   ```

**Expected:**
- A separate directory exists per worker under `.whalecode-worktrees/`, named with the dag_id prefix.
- Each worktree directory is a valid git worktree (contains `.git` file pointing to main repo).
- Workers' file changes appear in their respective worktree directories, NOT in the main project directory.

**Edge case:** If only 1 sub-task is generated, verify that even a single worker gets a worktree (not the project directory).

---

## Test Case 2: Parallel Same-Type Workers Execute Without Blocking

**Goal:** Verify that two Claude workers (or any same-type) can run simultaneously.

**Steps:**
1. Submit a task that decomposes into 2+ sub-tasks all assigned to the same agent type (e.g., two Claude workers).
2. Approve the decomposition plan.
3. Observe the execution phase — both workers should start without delay.
4. Check process list during execution:
   ```bash
   ps aux | grep -i claude
   ```

**Expected:**
- Both Claude processes appear in the process list simultaneously.
- No "already running a task" error appears in logs or UI.
- Both workers produce streaming output in the UI concurrently.

**Failure indicator:** If the second worker shows `dispatch_error` with text like "already running" or "tool slot", the `skip_tool_slot` bypass isn't working.

---

## Test Case 3: Worktree Entries Tracked in OrchestrationPlan

**Goal:** Verify that `OrchestrationPlan.worktree_entries` is populated and serializable.

**Steps:**
1. During or after an orchestration run, inspect the plan state (via dev tools or backend logs).
2. Verify the `worktree_entries` field exists and contains entries.

**Expected:**
- `worktree_entries` is a JSON object mapping dag_id strings to objects with: `task_id`, `worktree_name`, `branch_name`, `path`, `created_at`.
- Each entry's `path` matches an actual directory under `.whalecode-worktrees/`.
- Each entry's `branch_name` starts with `whalecode/task/`.

**Automated proof (unit test):**
```bash
cd src-tauri && cargo test --lib commands::orchestrator -- test_plan_worktree_entries_serializable
```

---

## Test Case 4: Worktree Cleanup on Successful Completion

**Goal:** Verify worktrees are removed after orchestration completes successfully.

**Steps:**
1. Run a full orchestration (decompose → approve → execute → review completes).
2. After the orchestration phase shows "Completed", check:
   ```bash
   ls .whalecode-worktrees/
   ```
3. Check git branches:
   ```bash
   git branch | grep whalecode
   ```

**Expected:**
- `.whalecode-worktrees/` is empty or contains no directories from this run.
- No `whalecode/task/*` branches remain.
- Logs or events show `@@orch::worktrees_cleaned` with a count matching the number of workers.

---

## Test Case 5: Worktree Cleanup on Failure

**Goal:** Verify worktrees are cleaned up even when orchestration fails.

**Steps:**
1. Trigger an orchestration that will fail (e.g., use an unconfigured agent, or interrupt during execution).
2. Wait for the failure state to appear in the UI.
3. Check:
   ```bash
   ls .whalecode-worktrees/
   ```

**Expected:**
- Worktrees from the failed run are removed.
- Cleanup errors (if any) are logged but don't prevent the failure from being reported.
- The `@@orch::worktrees_cleaned` event fires even on the failure path.

---

## Test Case 6: Observability Events Emitted

**Goal:** Verify the three new `@@orch::` events appear during orchestration.

**Steps:**
1. Run any orchestration while monitoring events (enable verbose logging or inspect `handleOrchEvent.ts` output).
2. Look for these events in order:
   - `@@orch::worktree_created` (one per worker, during dispatch)
   - `@@orch::worktrees_cleaned` (once, at completion)

**Expected:**
- `worktree_created` payload: `{ dag_id: "t1", worktree_path: "/path/to/.whalecode-worktrees/...", branch_name: "whalecode/task/..." }`
- `worktrees_cleaned` payload: `{ count: N }` where N = number of workers

**Edge case:** If a worktree creation fails (e.g., disk full, git lock), verify `@@orch::dispatch_error` appears with a specific git2 error string, not a generic "Error".

---

## Test Case 7: Retry and Fallback Logic (R011)

**Goal:** Verify rate limit retry and agent fallback are exercised.

**Steps (automated — unit tests):**
```bash
cd src-tauri && cargo test --lib commands::orchestrator -- test_should_retry
cd src-tauri && cargo test --lib commands::orchestrator -- test_retry_delay
cd src-tauri && cargo test --lib commands::orchestrator -- test_select_fallback
cd src-tauri && cargo test --lib commands::orchestrator -- test_retry_config_default
```

**Expected:**
- `should_retry(0, max_retries=2)` → true; `should_retry(2, max_retries=2)` → false
- `retry_delay_ms(0, base=5000)` → 5000; `retry_delay_ms(2, base=5000)` → 20000
- `select_fallback_agent("claude", [claude, gemini])` → "gemini"
- All 4 tests pass.

**Manual trigger (if possible):** Temporarily set a very low rate limit on one agent and submit a task. Verify the retry log shows exponential backoff attempts and, if configured, fallback to a different agent.

---

## Test Case 8: Backward Compatibility — Old Plans Deserialize

**Goal:** Verify that plans created before S02 (without `worktree_entries`) still deserialize correctly.

**Steps (automated):**
```bash
cd src-tauri && cargo test --lib commands::orchestrator -- test_plan_worktree_entries_default_empty
```

**Expected:**
- A plan without `worktree_entries` in JSON deserializes with `worktree_entries = {}` (empty HashMap).
- No deserialization errors or panics.

---

## Summary

| TC | Coverage | Method | Status |
|----|----------|--------|--------|
| 1 | R003 (worktree isolation) | Runtime UAT (S05) | Pending |
| 2 | R004 (parallel same-type) | Runtime UAT (S05) | Pending |
| 3 | R003 (plan tracking) | Unit test ✅ | Verified |
| 4 | R012 (cleanup success) | Runtime UAT (S05) | Pending |
| 5 | R012 (cleanup failure) | Runtime UAT (S05) | Pending |
| 6 | Observability | Runtime UAT (S05) | Pending |
| 7 | R011 (retry/fallback) | Unit test ✅ | Verified |
| 8 | Backward compat | Unit test ✅ | Verified |

Unit test cases (3, 7, 8) are verified. Runtime cases (1, 2, 4, 5, 6) require full pipeline execution deferred to S05 UAT.
