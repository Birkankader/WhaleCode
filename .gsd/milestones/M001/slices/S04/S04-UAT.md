# S04: Review & Merge Pipeline — UAT Script

**Purpose:** Verify that the review & merge pipeline works correctly through the GUI. These test cases validate the contract established in S04 and should be executed during S05 end-to-end integration.

**Preconditions:**
- WhaleCode is built and running (`cargo tauri dev` or production build)
- A git repository is open as the project directory
- At least one CLI agent (Claude, Gemini, or Codex) is configured and authenticated
- No stale `.whalecode-worktrees/` directories exist from previous runs

---

## TC-01: Worktrees Persist After Workers Complete

**Goal:** Verify that worktrees are NOT cleaned up after Phase 2 — they must survive for user review.

1. Submit an orchestration task that decomposes into 2+ sub-tasks
2. Approve the plan when prompted
3. Wait for all workers to complete (Phase 2 finishes)
4. **Expected:** `.whalecode-worktrees/` directory contains one subdirectory per worker
5. **Expected:** No `@@orch::worktrees_cleaned` event appears in orchestration logs
6. **Expected:** The orchestration proceeds to Phase 3 (review) without cleaning up worktrees

## TC-02: Diffs Ready Event Emitted With Correct Metadata

**Goal:** Verify the `@@orch::diffs_ready` event carries per-worktree metadata.

1. Continue from TC-01 or start a new orchestration
2. After workers complete, observe the orchestration logs in the UI
3. **Expected:** "Diffs ready: N worktrees" log entry appears at info level
4. **Expected:** Each worktree entry includes: `dag_id`, `branch_name`, `file_count`, `additions`, `deletions`
5. **Expected:** `file_count` reflects actual number of files changed (may be 0 for no-op workers)

## TC-03: Review Agent Receives Diff-Enriched Prompt

**Goal:** Verify the review agent's prompt includes actual file diffs, not just stdout.

1. Continue from TC-02 or start a new orchestration
2. After diffs are generated, the review agent spawns (Phase 3)
3. Open the review agent's streaming output in the UI
4. **Expected:** The review prompt visible in logs includes per-worktree sections with branch names, file counts, +/- stats, and changed file paths
5. **Expected:** File paths are actual paths changed by the worker, not generic text

## TC-04: CodeReviewView Shows Per-Worktree Cards

**Goal:** Verify the CodeReviewView renders a collapsible card per worktree with DiffReview.

1. Continue from TC-03 (review completes, CodeReviewView becomes visible)
2. **Expected:** Review summary text from the review agent appears at the top
3. **Expected:** Below the summary, one card per worktree is shown
4. **Expected:** Each card header shows: branch name, file count, additions (+N), deletions (-N)
5. Click a card header to expand it
6. **Expected:** DiffReview component renders inside the card showing file-level diffs
7. **Expected:** DiffReview shows actual code changes for each modified file

## TC-05: Per-Worktree Merge

**Goal:** Verify that individual worktree merge works.

1. In the CodeReviewView, expand a worktree card that has changes
2. Use the DiffReview's merge functionality to merge that worktree
3. **Expected:** The card status updates to show "merged" state
4. **Expected:** The branch changes are applied to the main branch
5. **Expected:** Other worktrees remain in pending state — cleanup does NOT fire yet

## TC-06: Per-Worktree Discard

**Goal:** Verify that individual worktree discard works.

1. In the CodeReviewView, find a worktree card you want to reject
2. Click the discard button for that worktree
3. **Expected:** The card status updates to show "discarded" state
4. **Expected:** The worktree changes are NOT applied to the main branch
5. **Expected:** Other worktrees remain in pending state

## TC-07: Merge All Batch Operation

**Goal:** Verify "Merge All" merges all pending worktrees sequentially.

1. Start a new orchestration that produces 2+ worktrees
2. When CodeReviewView appears, click "Merge All" (or equivalent batch button)
3. **Expected:** Each worktree card updates to "merged" status sequentially (visible progress)
4. **Expected:** All worktree branches are applied to the main branch
5. **Expected:** After all are handled, cleanup fires and `.whalecode-worktrees/` is cleaned up
6. **Expected:** Orchestration transitions to 'completed' phase

## TC-08: Cleanup Fires After All Worktrees Handled

**Goal:** Verify cleanup only fires once all worktrees are merged or discarded.

1. Start orchestration with 3+ worktrees
2. Merge the first worktree — **Expected:** No cleanup yet
3. Discard the second worktree — **Expected:** No cleanup yet
4. Merge the third (last) worktree
5. **Expected:** `cleanupWorktrees()` is called automatically
6. **Expected:** `.whalecode-worktrees/` directory is cleaned up
7. **Expected:** Orchestration transitions to 'completed' phase

## TC-09: Zero-Changes Worktree

**Goal:** Verify that a worktree with no file changes shows an explicit empty state.

1. Submit a task where one worker produces no file changes (e.g., a read-only analysis task)
2. When CodeReviewView appears, find the worktree card for that worker
3. **Expected:** Card header shows file_count: 0, additions: 0, deletions: 0
4. **Expected:** Expanded card shows empty state message (not an error)
5. **Expected:** Discard button is available for the empty worktree
6. The empty worktree can be discarded and counts toward the "all handled" check

## TC-10: Failure Path Cleanup Still Works

**Goal:** Verify that when ALL workers fail, cleanup fires immediately (failure path preserved).

1. Submit a task that will cause all workers to fail (e.g., invalid agent config, unreachable CLI)
2. **Expected:** All worker tasks show failed status
3. **Expected:** `@@orch::worktrees_cleaned` event fires immediately (not deferred)
4. **Expected:** `.whalecode-worktrees/` is cleaned up without user merge/discard action
5. **Expected:** Orchestration transitions to 'failed' phase with actionable error

## TC-11: Cleanup Error Is Non-Fatal

**Goal:** Verify that if worktree cleanup fails (e.g., locked files), the orchestration still completes.

1. During a normal orchestration, after merge/discard, manually lock a file in a worktree directory (e.g., open it in an editor)
2. When cleanup fires, it may fail to delete that directory
3. **Expected:** Cleanup error is logged but orchestration transitions to 'completed' (not stuck)
4. **Expected:** User can manually clean up the stale directory

## TC-12: Diff Generation Error Handling

**Goal:** Verify that a diff generation failure for one worktree doesn't abort the entire review flow.

1. If possible, corrupt one worktree's git state (e.g., remove .git/HEAD) before Phase 3 starts
2. **Expected:** Diff generation logs a warning for the corrupted worktree
3. **Expected:** An empty diff report is inserted for that worktree
4. **Expected:** Other worktrees' diffs are generated normally
5. **Expected:** Review prompt still includes all worktrees (empty entry for the failed one)
6. **Expected:** CodeReviewView shows the failed worktree with zero-changes empty state

---

## Edge Cases

- **Single-task decomposition:** If the master agent decomposes into only 1 sub-task, the review flow should still work with a single worktree card.
- **Large diffs:** If a worker modifies many files, the review prompt truncates file lists at 2KB per worktree. The DiffReview component should still render all files.
- **Rapid merge/discard:** Clicking merge/discard on multiple worktrees in quick succession should not race — batch merge iterates sequentially.
- **App close during review:** If the user closes WhaleCode during the CodeReviewView, stale worktrees remain. The next orchestration run or startup should detect and offer cleanup via `cleanup_stale_worktrees`.
