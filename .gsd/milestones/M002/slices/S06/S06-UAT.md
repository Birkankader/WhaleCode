# S06: End-to-End Pipeline UAT Runbook

**Last updated:** 2026-03-23
**Milestone:** M002 — Multi-Agent Orchestration
**Purpose:** Step-by-step procedure for verifying the full WhaleCode orchestration pipeline works end-to-end through the GUI with real CLI agents.

---

## Prerequisites

### Environment

- macOS with Xcode Command Line Tools installed
- Git repository (the project being tested must be a valid git repo)
- Node.js ≥ 18 and Rust toolchain installed
- WhaleCode built and runnable via `cargo tauri dev` or as a release binary

### Agent Authentication

At least one CLI agent must be installed and authenticated:

| Agent | Install check | Auth requirement |
|-------|--------------|------------------|
| Claude | `which claude` | Anthropic API key stored in macOS Keychain (WhaleCode manages this via Settings → API Keys) |
| Gemini | `which gemini` | Google AI API key stored in macOS Keychain |
| Codex | `which codex` | OpenAI API key stored in macOS Keychain |

**Current availability (2026-03-23):**
- ✅ `claude` — `/Users/birkankader/.local/bin/claude`
- ✅ `gemini` — `/opt/homebrew/bin/gemini`
- ✅ `codex` — `/opt/homebrew/bin/codex`

### Clean State

- No stale worktrees: `ls .whalecode-worktrees/ 2>/dev/null` should return empty or "No such file or directory"
- No zombie agent processes: `ps aux | grep -E '(claude|gemini|codex)' | grep -v grep` should show no lingering processes from previous runs
- WhaleCode app not already running (to avoid port/state conflicts)

---

## Pre-flight Checks

Run all automated test suites before attempting a manual pipeline test. All must pass.

### 1. Router Tests (Rust)

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib -- "router::"
```

**Expected:** 50+ tests pass, 0 failures.
**Last run result:** 54 passed ✅

### 2. Orchestrator Tests (Rust)

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib orchestrator_test
```

**Expected:** 29+ tests pass, 0 failures.
**Last run result:** 29 passed ✅

### 3. Worktree Tests (Rust)

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib -- "worktree::"
```

**Expected:** 22+ tests pass, 0 failures.
**Last run result:** 22 passed ✅

### 4. Frontend Tests (Vitest)

```bash
npx vitest run
```

**Expected:** 94+ tests pass across 8 test files, 0 failures.
**Last run result:** 94 passed ✅

### 5. TypeScript Compilation

```bash
npx tsc --noEmit
```

**Expected:** 0 errors (no output = success).
**Last run result:** 0 errors ✅

---

## Pipeline Test Procedure

### Phase 0: Launch & Configure

1. **Start WhaleCode** — either `cargo tauri dev` (dev mode) or launch the release binary.
2. **Set project directory** — click the folder selector or use the onboarding wizard to point at a test git repository. Use a disposable test repo or a branch you don't mind modifying.
3. **Configure agents** — in the setup/onboarding panel:
   - Select a **master agent** (e.g., `claude`). This agent performs decomposition and review.
   - Add **worker agents** (e.g., `gemini`, `codex`). These execute individual sub-tasks.
   - Verify API keys are configured in Settings → API Keys (the keychain icon in the sidebar). Keys are stored in macOS Keychain.

### Phase 1: Decomposition

4. **Submit a multi-step task** — enter a prompt that requires decomposition into sub-tasks. Example:

   > "Create a simple Python CLI calculator with add, subtract, multiply, divide functions in separate modules, plus a main.py entry point with argument parsing"

5. **Observe decomposition** — verify the following in the UI:
   - The **terminal panel** auto-opens at the bottom and shows streaming master agent output.
   - The **orchestration phase indicator** shows "Decomposing" (visible in the task card header or orchestration log).
   - The orchestration log panel shows structured events: `Phase 1: Decomposing...`
   - The master agent's token usage updates in real-time (input/output tokens, cost if available).

6. **Verify sub-task cards appear** — after decomposition completes:
   - Multiple task cards should appear in the working view with status `pending`.
   - Each card shows: assigned agent name, description, and agent icon.
   - The phase transitions to `awaiting_approval`.

### Phase 2: Approval

7. **Review the approval overlay** — the `TaskApprovalView` modal should appear automatically:
   - Lists all proposed sub-tasks with their assigned agents.
   - Each task shows the agent name, description, and file pills (extracted file paths from the prompt).
   - An "Auto-approve" toggle is visible.

8. **Edit tasks (optional)** — verify you can:
   - Reorder tasks using the up/down chevron buttons.
   - Reassign a task to a different agent via the agent dropdown.
   - Remove a task (mark for exclusion).
   - Add a new task using the "+" button.

9. **Approve** — click the "Approve & Execute" button. Verify:
   - All pending worker tasks transition to `waiting` status.
   - The phase transitions to `executing`.
   - The terminal panel shows `Phase 2: Executing N sub-tasks in M wave(s)`.

### Phase 3: Parallel Execution in Worktrees

10. **Observe parallel execution** — verify the following:
    - Worker task cards transition from `waiting` → `running` as their `worker_started` events arrive.
    - Each running task shows a streaming output preview line (updated every 500ms via `worker_output` events).
    - The terminal panel shows interleaved worker output prefixed with agent identifiers.

11. **Verify worktree isolation** — while tasks are running:
    ```bash
    ls .whalecode-worktrees/
    ```
    - Each active worker task should have its own worktree directory (named with the task's DAG ID).
    - Workers operate in isolated git branches — changes are not visible in the main working tree.

12. **Monitor wave progress** — if the DAG has dependencies:
    - Wave progress events appear in the orchestration log: `◍ Wave 1/2`, `◍ Wave 2/2`.
    - Tasks in later waves wait until their dependencies complete.

13. **Task completion** — as each worker finishes:
    - Task card transitions to `completed` (green) or `failed` (red).
    - A toast notification appears: "Task Completed" or "Task Failed" with a summary.
    - The orchestration log shows completion/failure details including exit code.

### Phase 4: Review

14. **Automatic transition to review** — after all workers complete:
    - The phase transitions to `reviewing`.
    - The UI auto-navigates to the **Code Review View** (`CodeReviewView`).

15. **Verify diff display** — the review screen should show:
    - Stat cards: total tasks completed, warnings (failed tasks), total files changed.
    - A list of worktree entries, each showing: DAG ID, branch name, file count, additions (+), deletions (−).
    - The `diffs_ready` event provides this data.

16. **Inspect individual diffs** — click on a worktree entry to expand:
    - The `DiffReview` component shows file-by-file diffs.
    - Each file shows additions (green) and deletions (red) in a unified diff format.
    - File acceptance checkboxes are available for selective merge.

### Phase 5: Merge or Discard

17. **Merge accepted changes** — click "Merge" on individual worktree entries or "Merge All":
    - The merge operation applies accepted file changes from the worktree branch to the main branch.
    - Status badge transitions from `Pending` → `Merged`.
    - The worktree directory is cleaned up after successful merge.

18. **Discard unwanted changes** — click "Discard" on entries you don't want:
    - Status badge transitions to `Discarded`.
    - The worktree branch and directory are removed without applying changes.

19. **Complete review** — after all entries are merged or discarded:
    - Click "Done" to transition to the Done view.
    - The orchestration phase transitions to `completed`.
    - The orchestration log shows "Orchestration completed".

---

## Expected Observations Summary

| Phase | What to verify | Frontend signal |
|-------|---------------|-----------------|
| Decomposition | Master agent streams output, sub-tasks parsed | `phase_changed: decomposing`, `task_assigned` events |
| Approval | Task list with agents, edit controls, approve button | `phase_changed: awaiting_approval`, `TaskApprovalView` visible |
| Execution | Parallel workers running in worktrees, live output | `worker_started`, `worker_output`, `task_completed`/`task_failed` |
| Review | Diff cards with file counts, unified diffs | `diffs_ready`, `phase_changed: reviewing`, `CodeReviewView` active |
| Merge | Changes applied to main branch, worktrees cleaned | Merge/discard status badges, worktree directory removal |
| Completion | All phases done, no zombie processes | `phase_changed: completed`, clean process table |

---

## Error Scenario Testing

### Scenario 1: Invalid Project Directory

1. Set the project directory to a path that doesn't exist or isn't a git repo (e.g., `/tmp/not-a-repo`).
2. Submit a task.
3. **Expected:** The orchestration fails with an error. The error message should appear in:
   - The orchestration log as an `error`-level entry.
   - The master task card transitions to `failed` status.
   - A toast notification with the error summary.
4. **Verify:** The UI remains responsive — no hanging spinners, no blank screens.

### Scenario 2: Invalid Agent Name

1. If possible, configure an agent that doesn't exist (this may require modifying the config before it reaches the backend).
2. Submit a task.
3. **Expected:** The backend returns `"Unknown agent: <name>"` from `get_adapter()`. The `dispatch_error` event surfaces in the orchestration log. The affected task card shows `failed`.

### Scenario 3: Agent Process Timeout

1. Submit a task to an agent and wait for the configured timeout (default: 5 minutes for workers, 10 minutes for master).
2. **Expected:** A `worker_timeout` or `master_timeout` event appears in the orchestration log. The timed-out task transitions to `failed`. Other tasks in the same wave are not affected.

### Scenario 4: Decomposition Failure (LLM returns invalid JSON)

1. This is difficult to trigger intentionally but can occur naturally. If it happens:
2. **Expected:** The `decomposition_failed` event fires. The frontend shows the error on the master task card. The orchestration either continues in single-task fallback mode or terminates (depending on the failure path — see Knowledge K005 about dual semantics).

### Scenario 5: Network / Auth Error

1. Temporarily revoke an agent's API key (Settings → API Keys → remove key).
2. Submit a task using that agent.
3. **Expected:** The process fails with an auth error. The error surfaces via `task_failed` with a descriptive `failure_reason`. The `humanizeError` utility produces a user-friendly message.

---

## Post-run Checks

After completing a full pipeline test (or after any error scenario), verify cleanup:

### 1. No Zombie Agent Processes

```bash
ps aux | grep -E '(claude|gemini|codex)' | grep -v grep
```

**Expected:** No lingering agent processes from the test run. WhaleCode kills child processes on task completion/failure.

### 2. Worktree Cleanup

```bash
ls .whalecode-worktrees/ 2>/dev/null
```

**Expected:** Empty or directory doesn't exist. All worktrees should be cleaned up after merge/discard.

If stale worktrees remain:
```bash
# Manual cleanup
rm -rf .whalecode-worktrees/
git worktree prune
```

### 3. Startup Cleanup Verification

WhaleCode automatically cleans up stale worktrees on app startup (see `src/routes/index.tsx` — the `cleanupWorktrees` call in the startup `useEffect`). To verify:

1. If you left stale worktrees intentionally, restart WhaleCode.
2. After the app loads and a project directory is set, check `.whalecode-worktrees/` — it should be pruned.

### 4. Backend Process Table

In developer mode (toggle in sidebar), check the terminal panel:
- The heartbeat interval (every 5 seconds) reconciles frontend task state with the backend's `getRunningProcesses()`.
- Tasks that are `running` in the frontend but not in the backend are marked `failed`.

### 5. Git State

```bash
git status
git branch --list 'whalecode/*'
```

**Expected:** No orphaned `whalecode/*` branches remain after merge/discard. The working tree is clean (no uncommitted changes from worktree operations).

---

## Requirement Checklist

This runbook exercises the following requirements:

| Requirement | What validates it | Evidence |
|-------------|-------------------|----------|
| **R025** — Full pipeline end-to-end | Completing all 5 phases (decompose → approve → execute → review → merge) through the GUI | Pre-flight test baseline (405+ tests pass) + successful pipeline run |
| **R002** — Error handling | Error scenario tests (invalid dir, bad agent, timeout) surface user-friendly errors | Error cards and humanized messages in UI |
| **R005** — Task ID preservation | Sub-task IDs assigned during decomposition persist through execution and review | DAG ID → frontend ID mapping in task cards |
| **R011** — Rate limit retry | Rate limit events surface in the orchestration log with retry/fallback options | `rate_limited` and `rate_limit_action_needed` events (if triggered) |
| **R012** — Worktree cleanup | Post-run check shows no stale worktrees; startup cleanup prunes leftovers | `ls .whalecode-worktrees/` empty after run; startup cleanup in `index.tsx` |
| **R023** — humanizeError coverage | Error scenarios produce user-friendly messages (not raw stack traces) | Error toast and log messages during error scenario testing |

---

## Quick Reference: Key Source Files

| Component | File | Purpose |
|-----------|------|---------|
| Orchestrator backend | `src-tauri/src/commands/orchestrator.rs` | Rust: decompose, dispatch, review, merge pipeline |
| Frontend dispatch hook | `src/hooks/orchestration/useOrchestratedDispatch.ts` | Creates channel, parses events, drives state |
| Event handler | `src/hooks/orchestration/handleOrchEvent.ts` | Maps `@@orch::` events to Zustand store updates |
| Task approval | `src/components/views/TaskApprovalView.tsx` | Approval overlay with edit/reorder/add controls |
| Code review | `src/components/views/CodeReviewView.tsx` | Diff display, merge/discard, review summary |
| App routing | `src/routes/index.tsx` | View switching, startup cleanup, heartbeat |
| Worktree manager | `src-tauri/src/worktree/manager.rs` | Git worktree create/list/cleanup |
| Error humanizer | `src/lib/humanizeError.ts` | Converts raw errors to user-friendly messages |
