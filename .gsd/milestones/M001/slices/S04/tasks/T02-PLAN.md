---
estimated_steps: 4
estimated_files: 3
skills_used: []
---

# T02: Wire frontend review flow with per-worktree diffs and merge controls

**Slice:** S04 — Review & Merge Pipeline
**Milestone:** M001

## Description

The `CodeReviewView` is currently a simple accept/reject summary of the review agent's text output. It has no diff viewer and no merge functionality. This task rewrites it to show per-worktree file diffs using the existing `DiffReview` component, with merge controls that invoke the existing `merge_worktree` and `cleanup_worktrees` IPC commands via the `useWorktree` hook. Completion transition happens only after all worktrees are merged or discarded.

The existing `DiffReview` component (`src/components/review/DiffReview.tsx`) is fully functional — it has a file list sidebar with per-file accept/reject checkboxes, a unified diff viewer, merge/discard buttons, and calls `selectiveMerge` and `cleanupWorktrees` from `useWorktree`. This task's job is to render one `DiffReview` per worktree inside the review flow, fed by real worktree data from the `@@orch::diffs_ready` event.

## Steps

1. **Add `worktreeEntries` state to taskStore** in `src/stores/taskStore.ts`:
   - Add type: `WorktreeReviewEntry = { dagId: string; branchName: string; fileCount: number; additions: number; deletions: number }`
   - Add to `TaskState` interface: `worktreeEntries: Map<string, WorktreeReviewEntry>` (keyed by dagId), `setWorktreeEntries: (entries: Map<string, WorktreeReviewEntry>) => void`
   - Initialize: `worktreeEntries: new Map()`
   - Add setter: `setWorktreeEntries: (entries) => set({ worktreeEntries: entries })`
   - Clear in `clearSession`: add `worktreeEntries: new Map()`

2. **Handle `diffs_ready` event** in `src/hooks/orchestration/handleOrchEvent.ts`:
   - Add `diffs_ready` to the `OrchEvent` union type: `| { type: 'diffs_ready'; diffs: Array<{ dag_id: string; branch_name: string; file_count: number; additions: number; deletions: number }> }`
   - Add case in the switch: parse the `diffs` array, build a `Map<string, WorktreeReviewEntry>` from the entries, and call `store.setWorktreeEntries(map)`. Log `"Diffs ready: N worktrees"` at info level.

3. **Rewrite `CodeReviewView`** in `src/components/views/CodeReviewView.tsx`:
   - Keep the existing header with master agent icon and review text summary (the agent's review is still useful context)
   - Keep the stats cards (completed/total/warnings)
   - Below the review summary, add a **per-worktree review section**:
     - Read `worktreeEntries` from `useTaskStore`
     - Read `projectDir` from `useUIStore`
     - For each worktree entry, show a collapsible card with: agent icon, task description (from `tasks` map via `dagToFrontendId` or dagId), branch name, file count, +additions/-deletions
     - When a worktree card is expanded, render the existing `DiffReview` component with `projectDir={projectDir}`, `branchName={entry.branchName}`, `taskId={entry.dagId}`, and `onClose` that marks the worktree as handled
     - Track per-worktree status locally: `'pending' | 'merged' | 'discarded'`
   - Replace the simple Accept/Reject buttons with:
     - **"Merge All"** button — calls `mergeWorktree` for each pending worktree, then cleanup
     - **"Done"** button (only after all worktrees handled) — calls `cleanupWorktrees()` then transitions to `'completed'`
   - Handle **zero worktreeEntries** case: show the existing review summary with a "No file changes to review" message and a "Complete" button that transitions directly
   - Handle **zero changes in a single worktree** case: the `DiffReview` component already handles empty file lists — it shows "Select a file to view its diff" with no files in the sidebar
   - Import `DiffReview` from `../../components/review/DiffReview`, `useWorktree` from `../../hooks/useWorktree`, `useUIStore` from `../../stores/uiStore`

4. **TypeScript verification**: Copy modified files to the main project directory and run `npx tsc --noEmit`. Fix any type errors. Common issues: `WorktreeReviewEntry` type needs to be exported from taskStore, `OrchEvent` union needs correct field names.

## Must-Haves

- [ ] `worktreeEntries` state added to taskStore with setter and cleared on session reset
- [ ] `diffs_ready` event type added to OrchEvent union and handled in handleOrchEvent
- [ ] CodeReviewView renders DiffReview per worktree with real branch names
- [ ] Merge controls (per-worktree merge/discard via existing DiffReview, plus "Merge All" for batch)
- [ ] Cleanup called only after all worktrees handled
- [ ] Zero-worktrees case shows review summary with direct completion path
- [ ] TypeScript compiles with zero errors

## Verification

- Copy modified files to main project and run: `cd /Users/birkankader/Documents/Projects/WhaleCode && npx tsc --noEmit` — zero errors
- `grep -q 'diffs_ready' src/hooks/orchestration/handleOrchEvent.ts` — event handled
- `grep -q 'DiffReview' src/components/views/CodeReviewView.tsx` — diff component rendered
- `grep -q 'worktreeEntries' src/stores/taskStore.ts` — worktree state stored
- `grep -q 'useWorktree\|mergeWorktree\|selectiveMerge' src/components/views/CodeReviewView.tsx` — merge wired
- `grep -q 'cleanupWorktrees' src/components/views/CodeReviewView.tsx` — cleanup wired

## Inputs

- `src/stores/taskStore.ts` — current store (no worktree state)
- `src/hooks/orchestration/handleOrchEvent.ts` — current event handler (no `diffs_ready` case)
- `src/components/views/CodeReviewView.tsx` — current simple accept/reject summary view
- `src/components/review/DiffReview.tsx` — existing per-worktree diff viewer with merge/discard (do not modify)
- `src/hooks/useWorktree.ts` — existing IPC hook with mergeWorktree, selectiveMerge, cleanupWorktrees (do not modify)
- `src/stores/uiStore.ts` — has `projectDir` state

## Expected Output

- `src/stores/taskStore.ts` — `worktreeEntries` state with setter, cleared on session reset
- `src/hooks/orchestration/handleOrchEvent.ts` — `diffs_ready` OrchEvent type + handler
- `src/components/views/CodeReviewView.tsx` — rewritten with per-worktree DiffReview, merge controls, cleanup

## Observability Impact

- **New inspection surface:** `worktreeEntries` in taskStore — inspect via React DevTools or `useTaskStore.getState().worktreeEntries` to see pending worktree diff metadata (dagId, branchName, fileCount, additions, deletions) received from `@@orch::diffs_ready`
- **New orchestration log:** `"Diffs ready: N worktrees"` logged at info level when the `diffs_ready` event is handled — visible in orchestrationLogs in the UI
- **Merge/discard visibility:** Per-worktree status (`pending` / `merged` / `discarded`) tracked in local component state; cleanup fires only after all worktrees handled, preventing premature worktree removal
- **Failure visibility:** Merge failures surface via `useWorktree` error state (from existing hook); cleanup errors are non-fatal and still transition to completed
