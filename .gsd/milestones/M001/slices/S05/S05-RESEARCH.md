# S05 Research: End-to-End Integration & Polish

**Depth:** Light research — S05 is integration verification and bug-fixing of work already built in S01–S04. All patterns are established, all code is known.

## Summary

S05's job is to prove the full pipeline works end-to-end and fix the integration bugs that surface. S01–S04 built all the pieces (decomposition, worktrees, frontend state, review/merge) with contract-level verification (unit tests, TypeScript type checks). S05 must:

1. **Fix a confirmed data contract mismatch** between backend and frontend for `diffs_ready` events
2. **Add startup worktree cleanup** so stale worktrees from crashed sessions don't accumulate
3. **Verify all requirements** that were deferred to "runtime UAT in S05" across S01–S04

## Requirements Targeted

S05 is the UAT slice for nearly every requirement in M001:

| Req | Description | Status Before S05 |
|-----|-------------|-------------------|
| R001 | Master agent decomposition → parseable JSON | Contract verified S01 — needs runtime proof |
| R002 | Actionable error messages in UI | Contract verified S01 — needs runtime proof |
| R005 | Task IDs preserved through DAG | Contract verified S01 — needs runtime proof |
| R006 | Approval flow works (activePlan non-null) | Contract verified S03 — needs runtime proof |
| R007 | Task completion matches correct card (dag_id) | Contract verified S03 — needs runtime proof |
| R008 | Review agent receives worktree diffs | Contract verified S04 — needs runtime proof |
| R009 | Per-worktree diff UI + merge controls | Contract verified S04 — needs runtime proof |
| R010 | Per-worker streaming output attribution | Contract verified S03 — needs runtime proof |
| R012 | Worktree cleanup on completion + startup | Contract verified S02/S04 — needs startup gap fix |

## Recommendation

**Fix the diffs_ready bug, add startup cleanup, then run the pipeline.** This is a bug-fix + verification slice, not a build slice.

## Implementation Landscape

### Bug Found: `diffs_ready` Event Field Name Mismatch

**Backend** (`src-tauri/src/commands/orchestrator.rs:1519–1521`):
```rust
emit_orch(&on_event, "diffs_ready", serde_json::json!({
    "worktrees": diffs_summary   // <-- sends "worktrees"
}));
```

**Frontend** (`src/hooks/orchestration/handleOrchEvent.ts:28,289`):
```typescript
| { type: 'diffs_ready'; diffs: Array<...> }  // <-- expects "diffs"
// ...
for (const d of ev.diffs) {  // <-- reads ev.diffs → undefined
```

**Impact:** The entire CodeReviewView worktree section will show "No file changes to review" because `worktreeEntries` in the store is never populated. The review agent still runs and produces output, but the per-worktree diff cards won't render.

**Fix:** Either rename the backend field from `"worktrees"` to `"diffs"`, or update the frontend type + handler. Renaming the backend field to `"diffs"` is simpler since the frontend type and handler already use that name consistently.

### Gap: No Startup Worktree Cleanup

S04 summary explicitly warns: "If the frontend crashes or the user closes the app during review, stale worktrees will remain until the next `cleanup_stale_worktrees` call."

`src-tauri/src/lib.rs` setup handler (`line 144`) only initializes ContextStore — no worktree cleanup on startup. The `WorktreeManager::cleanup_stale_worktrees()` method exists and is tested (`src-tauri/src/worktree/manager.rs:158`) but is only exposed as a Tauri command (`src-tauri/src/commands/worktree.rs:234`), not called at startup.

**Fix:** Call `cleanup_stale_worktrees` in the Tauri `.setup()` handler, or in the frontend on mount (via the existing `cleanupWorktrees` IPC command). Frontend-side is simpler since it already has `projectDir` available.

### What's Already Working (Contract Verified)

These are confirmed working via tests and compilation:

- **Decomposition JSON parsing** — 5 fallback strategies, SubTaskDef.id preserved, 42 tests in `commands::orchestrator`
- **Worktree creation per worker** — `create_for_task` called in orchestrator Phase 2, `worktree_entries` HashMap tracks dag_id → WorktreeEntry
- **Parallel same-type workers** — `skip_tool_slot: true` bypasses per-agent-name lock for orchestrated workers
- **dag_id-based task completion matching** — FIFO removed entirely, dagToFrontendId map used
- **activePlan set from phase_changed events** — before awaiting_approval fires
- **Per-worker stdout attribution** — orch_tag threaded through spawn, worker_output events emitted
- **Review prompt with diffs** — `build_review_prompt_with_diffs` includes file-level summaries per worktree
- **CodeReviewView** — per-worktree collapsible cards, merge all, per-worktree merge/discard, cleanup after all handled
- **Failure-path worktree cleanup** — in orchestrator when all workers fail
- **Process cleanup on app exit** — SIGKILL to all tracked process groups in RunEvent::Exit handler

### Rust Compilation Status

`cargo check` passes with 15 warnings (all dead code, non-blocking). 266 test functions exist across the codebase.

### TypeScript Status

Production code compiles clean (confirmed by S01–S04 summaries). Test files show vitest/module resolution errors due to missing `node_modules` in worktree — not production issues.

## Files to Change

| File | Change | Risk |
|------|--------|------|
| `src-tauri/src/commands/orchestrator.rs:1519` | Rename `"worktrees"` → `"diffs"` in diffs_ready emit | Low — 1-line fix |
| `src/routes/index.tsx` or `src/hooks/useWorktree.ts` | Add startup `cleanupWorktrees()` call | Low — uses existing IPC |

## Verification Plan

### Automated (must pass before UAT)
1. `cargo test --lib` — all 266+ tests pass (existing + any new)
2. `npx tsc --noEmit` — zero production errors (test files excluded)
3. `rg` checks: `diffs_ready` field name consistency between backend and frontend

### UAT (runtime verification through GUI)
The milestone Definition of Done requires proving the full pipeline via `cargo tauri dev`:

1. **Decomposition:** Submit a multi-step task → master agent returns sub-tasks → sub-tasks appear as cards
2. **Approval:** TaskApprovalView renders with correct activePlan → approve tasks
3. **Parallel Execution:** 2+ workers run in separate worktrees → streaming output attributed per-worker
4. **Review:** Review phase fires → diffs_ready populates worktreeEntries → CodeReviewView shows per-worktree cards
5. **Merge:** Accept/reject per worktree → changes merged to main branch → worktrees cleaned up
6. **Error Handling:** Deliberately trigger a failure → DecompositionErrorCard shows actual error text

UAT requires real CLI agents (Claude Code at minimum) to be installed and authenticated.
