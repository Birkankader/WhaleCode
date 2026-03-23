# S05 UAT: End-to-End Integration & Polish

**Preconditions:**
- WhaleCode built and launchable via `cargo tauri dev`
- At least one CLI agent installed and authenticated (Claude Code recommended)
- A git repository open as the project directory
- No stale `.whalecode-worktrees/` directory from previous sessions (or one present to test cleanup)

---

## Test Case 1: Startup Worktree Cleanup

**What it tests:** R012 — stale worktrees from crashed sessions are cleaned on app launch.

**Setup:** Create a fake stale worktree directory:
```bash
mkdir -p .whalecode-worktrees/stale-test-worktree
```

**Steps:**
1. Launch WhaleCode via `cargo tauri dev`
2. Open a project directory (the one containing the stale worktree)
3. Open browser DevTools console

**Expected:**
- No `Startup worktree cleanup failed:` warning in console
- `.whalecode-worktrees/stale-test-worktree` is removed (or cleanup attempted)
- App loads normally without delay

---

## Test Case 2: Task Decomposition (R001)

**Steps:**
1. In the task input, submit a multi-step request: "Create a utility module with string helpers and add unit tests for each helper"
2. Wait for the master agent to process

**Expected:**
- Master agent decomposes the request into 2+ sub-tasks
- Sub-tasks appear as cards in the task view
- Each card shows: task ID, agent assignment, description
- No generic "Error" text — either success or specific error detail

---

## Test Case 3: Decomposition Error Handling (R002)

**Steps:**
1. Configure the master agent to an unavailable/invalid agent (or disconnect network)
2. Submit a task to trigger decomposition failure

**Expected:**
- `DecompositionErrorCard` renders (not a blank card)
- Card displays the actual error message from the backend (e.g., "agent not found", "connection refused")
- Error text is specific and actionable, NOT generic "Error"

---

## Test Case 4: Approval Flow (R006)

**Steps:**
1. Submit a multi-step task (same as Test Case 2)
2. Wait for decomposition to complete
3. Observe the `TaskApprovalView`

**Expected:**
- `TaskApprovalView` renders with sub-task cards to approve
- `activePlan` is non-null (check via React DevTools: `useTaskStore.getState().activePlan`)
- Approve all tasks → execution begins
- If auto-approve is enabled, execution starts without manual approval

---

## Test Case 5: Parallel Worker Execution with Output Attribution (R004, R010)

**Precondition:** Decomposition produced 2+ sub-tasks assigned to the same agent type.

**Steps:**
1. Approve sub-tasks (from Test Case 4)
2. Observe the Kanban board during execution

**Expected:**
- 2+ workers run simultaneously (check `.whalecode-worktrees/` for multiple directories)
- Each task card shows streaming output from its specific worker
- Output lines are NOT interleaved across cards — each card shows only its worker's output
- Workers execute in separate worktree directories (not the main project dir)

---

## Test Case 6: DAG-Based Task Completion Matching (R005, R007)

**Steps:**
1. During parallel execution (Test Case 5), observe task cards as workers complete
2. If possible, arrange tasks where the second-dispatched worker completes first

**Expected:**
- When a worker completes, the CORRECT task card updates to "completed" status
- Out-of-order completions update the right card (not the first pending one)
- No console warnings about "Unmatched dag_id" (check browser DevTools)
- `dagToFrontendId` map is populated (check via React DevTools)

---

## Test Case 7: Review Phase with Worktree Diffs (R008, R009)

**Steps:**
1. After all workers complete, observe the review phase
2. Wait for the `CodeReviewView` to render

**Expected:**
- Review agent runs and produces an integration summary
- `CodeReviewView` shows per-worktree collapsible cards
- Each card renders `DiffReview` with file-level changes (additions/deletions/modifications)
- `worktreeEntries` in taskStore is a populated Map (not empty)
- "Merge All" button is visible at the top

---

## Test Case 8: Merge and Cleanup (R009, R012)

**Steps:**
1. In `CodeReviewView`, click "Merge All" (or merge individual worktrees)
2. Observe the merge process

**Expected:**
- Each worktree status transitions to "merged" or "discarded"
- After all worktrees are handled, `cleanupWorktrees` fires
- `.whalecode-worktrees/` directory is cleaned (no stale entries remain)
- Merged changes appear in the main branch

---

## Test Case 9: Zero-Changes Worktree (Edge Case)

**Steps:**
1. Submit a task where at least one worker makes no file changes (e.g., "review this code" as a sub-task)
2. Complete the full pipeline to review phase

**Expected:**
- Worktree with zero changes shows "No file changes to review" (or similar)
- Discard button is still available for the zero-changes worktree
- Pipeline does not hang waiting for a diff that doesn't exist

---

## Test Case 10: Full Pipeline Single Flow

**Steps:**
1. Submit a complex multi-step task from scratch
2. Do NOT intervene — let the pipeline run through all phases:
   - Decompose → Approve → Parallel Execute → Review → Merge
3. Observe each phase transition

**Expected:**
- All phases complete without manual intervention (with auto-approve on)
- Each phase transition is visible in the UI
- Final state: changes merged to main, worktrees cleaned, no zombie processes
- Check `ps aux | grep -i claude` (or agent name) — no orphaned processes
