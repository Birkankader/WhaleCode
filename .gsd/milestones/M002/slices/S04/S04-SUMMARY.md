# S04: Review, Merge & Cleanup — Summary

---
slice: S04
milestone: M002
status: done
tasks_completed: [T01, T02, T03]
requirements_validated: [R008, R009, R012]
verification_result: passed
completed_at: 2026-03-23
---

## What This Slice Delivered

Wired the complete review-merge-cleanup pipeline — the last missing connection between worker execution (S02) and the user seeing and acting on results. Before S04, the review UI existed but received no data. Now:

1. **Phase 2.5 pipeline** (T01): After workers complete, the orchestrator sequentially auto-commits each worktree, generates unified diffs, emits a `diffs_ready` event with per-worktree metadata, and passes real diff text to the review agent via `build_review_prompt_with_diffs()`.

2. **Review navigation + targeted cleanup** (T02): The UI auto-navigates to the review view when `orchestrationPhase === 'reviewing'` (not `'completed'`). Individual worktrees can be discarded via `remove_single_worktree` IPC command. Stale worktrees are cleaned on app startup. Zero-change worktrees show an explicit empty state with discard option.

3. **Full verification** (T03): 54 router + 29 orchestrator + 22 worktree Rust tests, 94 frontend tests, 0 TypeScript errors, all 8 wiring checks pass.

## Key Patterns Established

- **Phase 2.5 block:** auto-commit → diff → emit → enrich prompt. Runs sequentially to avoid git contention. Lives between Phase 2 wave completion and Phase 3 review dispatch.
- **`spawn_blocking` for git2 ops:** Blocking git2 functions wrapped in `tokio::task::spawn_blocking` inside the async orchestrator.
- **Proportional diff truncation:** ~20KB total budget split evenly across worktrees. Each worktree's diff is capped at its share.
- **Branch-to-directory derivation:** `remove_single_worktree` strips `whalecode/task/` prefix from branch name to derive worktree directory name — same pattern as `merge_worktree` cleanup.
- **Fire-and-forget startup cleanup:** `cleanupWorktrees` called on mount, errors silently caught to avoid blocking app startup.

## What Changed (Files)

| File | Change |
|------|--------|
| `src-tauri/src/commands/orchestrator.rs` | Phase 2.5 block: auto-commit, diff generation, `diffs_ready` emission, enriched review prompt |
| `src-tauri/src/router/orchestrator.rs` | `build_review_prompt_with_diffs()` method + 4 unit tests |
| `src-tauri/src/commands/worktree.rs` | `remove_single_worktree` IPC command |
| `src-tauri/src/commands/mod.rs` | Re-export `remove_single_worktree` |
| `src-tauri/src/lib.rs` | Register `remove_single_worktree` in invoke_handler |
| `src/routes/index.tsx` | Auto-navigate on `'reviewing'`, startup cleanup, projectDir selector |
| `src/components/review/DiffReview.tsx` | Targeted discard via `removeWorktree`, zero-changes empty state |
| `src/hooks/useWorktree.ts` | `removeWorktree` method |
| `src/bindings.ts` | `removeSingleWorktree` TypeScript binding |

## Verification Results

| Suite | Result |
|-------|--------|
| `cargo test --lib -- "router::"` | 54 passed |
| `cargo test --lib orchestrator_test` | 29 passed |
| `cargo test --lib -- "worktree::"` | 22 passed |
| `npx tsc --noEmit` | 0 errors |
| `npx vitest run` | 94 passed |
| Wiring checks (8 rg commands) | All pass |

## Decisions Made

- D013: Sequential per-worktree auto-commit/diff (avoids git contention)
- D014: Proportional truncation at ~20KB total for review prompt diffs

## What the Next Slice Should Know

- The full data pipeline from worker completion → review agent → user merge UI is now live. The review agent receives actual unified diff text (truncated if large).
- `diffs_ready` event shape: `{ diffs: [{ dag_id, branch_name, file_count, additions, deletions }] }` — parsed into `worktreeEntries` in taskStore.
- `remove_single_worktree` takes `project_dir` + `branch_name`, validates prefix, removes the specific worktree.
- Startup cleanup is fire-and-forget — if it fails, the app still starts normally.
- Zero-change worktrees appear in the review UI with an empty state card and discard-only button.
- Pre-existing Rust warnings (10 total) are from earlier milestones — not introduced by S04.
- **Remaining for S05:** Dead code removal, DOM manipulation anti-patterns, silent `.catch(() => {})` replacement, jargon cleanup.
- **Remaining for S06:** Full end-to-end pipeline UAT with real agents.
