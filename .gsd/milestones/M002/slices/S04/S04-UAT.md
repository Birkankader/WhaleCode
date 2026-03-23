# S04: Review, Merge & Cleanup — UAT Script

## Preconditions

- WhaleCode desktop app built and running (`npm run tauri dev` or production build)
- A git repository selected as the project directory
- At least one CLI agent configured (Claude Code, Gemini CLI, or Codex CLI) with valid credentials
- No stale `.whalecode-worktrees/` directories from previous runs

---

## Test Case 1: Diffs Ready Event After Worker Completion

**Goal:** Verify the orchestrator auto-commits worktrees, generates diffs, and emits `diffs_ready` after Phase 2.

**Steps:**

1. Submit a task that decomposes into 2+ sub-tasks (e.g., "Add a greeting function and a farewell function in separate files")
2. Approve the decomposition when prompted
3. Wait for all workers to complete (Phase 2 finishes)
4. Observe the orchestration logs panel

**Expected:**
- Log entries appear for each worktree being committed and diffed
- The UI transitions to the review view automatically (not after orchestration completes — during the reviewing phase)
- Per-worktree diff cards appear with file counts, additions, and deletions metadata
- The review agent's output references actual file changes, not just text summaries

---

## Test Case 2: Per-Worktree Diff Cards Display

**Goal:** Verify each worktree gets its own collapsible diff card with file-level changes.

**Steps:**

1. Complete Test Case 1 through to the review view
2. Examine the diff cards displayed

**Expected:**
- Each worktree has a separate card showing its branch name and change stats
- Cards are collapsible — clicking expands/collapses the file diff
- File-level changes show unified diff format (additions in green, deletions in red)
- Each card has individual "Merge" and "Discard" buttons

---

## Test Case 3: Granular Merge — Accept Individual Worktree

**Goal:** Verify merging a single worktree applies only that worktree's changes.

**Steps:**

1. From the review view with 2+ worktree cards, click "Merge" on the first worktree
2. Observe the main branch

**Expected:**
- Only the first worktree's changes are merged into the main branch
- The merged worktree card disappears or shows "Merged" status
- The second worktree card remains available for merge/discard
- The merged worktree directory is cleaned up from `.whalecode-worktrees/`

---

## Test Case 4: Granular Discard — Remove Individual Worktree

**Goal:** Verify discarding a worktree removes it without affecting other worktrees.

**Steps:**

1. From the review view with 2+ worktree cards, click "Discard" on one worktree
2. Check the filesystem for `.whalecode-worktrees/` contents

**Expected:**
- The discarded worktree's card disappears from the review UI
- The discarded worktree's directory is removed from `.whalecode-worktrees/`
- The discarded worktree's branch is removed from the git repository
- Other worktree cards remain unaffected and still functional

---

## Test Case 5: Zero-Changes Worktree

**Goal:** Verify a worker that makes no file changes shows a proper empty state.

**Steps:**

1. Submit a task where one sub-task is likely to make no changes (e.g., "Review the README for typos" paired with "Add a new utility function")
2. Proceed through to the review view

**Expected:**
- The zero-change worktree card shows "This worker made no file changes." message
- No file diff sidebar or diff viewer is shown for this card
- A "Discard Worktree" button is available (no merge button since there's nothing to merge)
- The worktree appears in `diffs_ready` with `file_count: 0`

---

## Test Case 6: Review Agent Receives Real Diffs

**Goal:** Verify the review agent's prompt contains actual unified diff text, not just output summaries.

**Steps:**

1. Complete an orchestration run with 2+ workers making real file changes
2. Read the review agent's output in the terminal view

**Expected:**
- The review agent's response references specific file names and line changes
- The review mentions additions and deletions from the actual diffs
- If total diff exceeds ~20KB, the review agent notes truncated content
- Each worktree's changes are discussed separately in the review

---

## Test Case 7: Startup Worktree Cleanup

**Goal:** Verify stale worktrees from previous sessions are cleaned on app startup.

**Steps:**

1. Run an orchestration that creates worktrees but do not merge/discard them
2. Close the app (quit entirely, not just close window)
3. Manually verify `.whalecode-worktrees/` still has directories
4. Relaunch the app and select the same project directory

**Expected:**
- Stale worktree directories in `.whalecode-worktrees/` are cleaned up automatically
- No error dialogs or blocking behavior during startup
- The app loads normally regardless of cleanup success/failure

---

## Test Case 8: Navigation Timing — Review View on 'reviewing' Phase

**Goal:** Verify the UI auto-navigates to the review view when diffs are ready, not after orchestration completes.

**Steps:**

1. Start an orchestration run
2. Watch the view transitions during the pipeline

**Expected:**
- During Phase 1 (decomposition): task/approval view is shown
- During Phase 2 (workers): worker progress view is shown
- When Phase 3 starts (reviewing): UI auto-navigates to review view with diff cards
- The user does NOT have to wait for the review agent to finish before seeing diffs
- Navigation happens on `orchestrationPhase === 'reviewing'`, not `'completed'`

---

## Edge Cases

### E1: Worker Fails But Others Succeed
- Failed worker's worktree is skipped during auto-commit/diff (listed in `failed_dag_ids`)
- Successful workers' diffs still appear in review UI
- Review agent only sees diffs from successful workers

### E2: All Workers Fail
- No diffs to generate; `diffs_ready` emits with empty or all-zero entries
- Review view shows no mergeable content
- Cleanup still runs normally

### E3: Auto-Commit Fails on One Worktree
- Warning logged with dag_id context
- A zero-diff placeholder is used for that worktree
- Other worktrees proceed normally
- The failed worktree appears in review UI with zero changes and discard option

### E4: Large Diffs Exceed 20KB Budget
- Diffs are proportionally truncated across worktrees
- Each worktree gets an equal share of the budget
- Truncated diffs include a note indicating content was cut
- Review agent is told context is incomplete
