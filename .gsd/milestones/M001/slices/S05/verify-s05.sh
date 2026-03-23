#!/usr/bin/env bash
# S05 Verification Suite — End-to-End Integration & Polish
# Checks backend↔frontend wiring for all requirements deferred to S05 UAT:
# R001, R002, R005, R006, R007, R008, R009, R010, R012
# Plus S05-specific fixes (diffs_ready field name, startup cleanup).
set -uo pipefail

PASS=0
FAIL=0

check() {
  local label="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    echo "  PASS: $label"
    ((PASS++))
  else
    echo "  FAIL: $label"
    ((FAIL++))
  fi
}

check_absent() {
  local label="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    echo "  FAIL: $label (pattern should NOT be present)"
    ((FAIL++))
  else
    echo "  PASS: $label"
    ((PASS++))
  fi
}

echo "═══════════════════════════════════════════════════════"
echo "  S05 Verification Suite"
echo "═══════════════════════════════════════════════════════"
echo ""

# ── R001: Task Decomposition ────────────────────────────
echo "── R001: Task decomposition (SubTaskDef + parsing) ──"
check "SubTaskDef struct exists in router/orchestrator.rs" \
  rg 'pub struct SubTaskDef' src-tauri/src/router/orchestrator.rs
check "SubTaskDef has id field" \
  rg 'pub id:' src-tauri/src/router/orchestrator.rs
check "parse_decomposition_from_output exists in commands/orchestrator.rs" \
  rg 'fn parse_decomposition_from_output' src-tauri/src/commands/orchestrator.rs
check "parse_decomposition_json helper exists" \
  rg 'fn parse_decomposition_json' src-tauri/src/commands/orchestrator.rs
echo ""

# ── R002: Decomposition Error Handling ──────────────────
echo "── R002: Decomposition error handling ───────────────"
check "decomposition_failed event emitted in backend" \
  rg 'decomposition_failed' src-tauri/src/commands/orchestrator.rs
check "decomposition_failed handled in frontend handleOrchEvent" \
  rg "case 'decomposition_failed'" src/hooks/orchestration/handleOrchEvent.ts
check "DecompositionErrorCard component exists" \
  test -f src/components/orchestration/DecompositionErrorCard.tsx
check "DecompositionErrorCard reads resultSummary" \
  rg 'resultSummary' src/components/orchestration/DecompositionErrorCard.tsx
echo ""

# ── R005: DAG Scheduling ───────────────────────────────
echo "── R005: DAG scheduling (dag_id + SubTaskDef.id) ───"
check "dag_id used in orchestrator router" \
  rg 'dag_id' src-tauri/src/router/orchestrator.rs
check "SubTaskDef has depends_on for DAG edges" \
  rg 'depends_on' src-tauri/src/router/orchestrator.rs
echo ""

# ── R006: Plan Activation from phase_changed ───────────
echo "── R006: Plan activation from phase_changed ────────"
check "setActivePlan called in handleOrchEvent" \
  rg 'setActivePlan' src/hooks/orchestration/handleOrchEvent.ts
check "phase_changed handler guards on ev.plan_id" \
  rg 'ev\.plan_id' src/hooks/orchestration/handleOrchEvent.ts
echo ""

# ── R007: DAG-to-Frontend ID Matching (no FIFO) ────────
echo "── R007: DAG-to-frontend ID matching (no FIFO) ─────"
check "dagToFrontendId map used in handleOrchEvent" \
  rg 'dagToFrontendId' src/hooks/orchestration/handleOrchEvent.ts
check_absent "No subTaskQueue.shift() (FIFO removed)" \
  rg 'subTaskQueue\.shift' src/hooks/orchestration/handleOrchEvent.ts
echo ""

# ── R008: Review Prompt with Diffs ─────────────────────
echo "── R008: Review prompt includes diffs ──────────────"
check "build_review_prompt_with_diffs exists in router/orchestrator.rs" \
  rg 'fn build_review_prompt_with_diffs' src-tauri/src/router/orchestrator.rs
check "build_review_prompt_with_diffs has tests" \
  rg 'test_build_review_prompt_with_diffs' src-tauri/src/router/orchestrator.rs
echo ""

# ── R009: Code Review View ─────────────────────────────
echo "── R009: Code review view (DiffReview + merge) ─────"
check "DiffReview imported in CodeReviewView" \
  rg 'import.*DiffReview' src/components/views/CodeReviewView.tsx
check "DiffReview rendered in CodeReviewView" \
  rg '<DiffReview' src/components/views/CodeReviewView.tsx
check "Merge All button in CodeReviewView" \
  rg 'Merge All' src/components/views/CodeReviewView.tsx
check "Per-worktree merged/discarded status tracking" \
  rg "'merged' | 'discarded'" src/components/views/CodeReviewView.tsx
check "worktreeEntries state in taskStore" \
  rg 'worktreeEntries' src/stores/taskStore.ts
check "mergeWorktree used in CodeReviewView" \
  rg 'mergeWorktree' src/components/views/CodeReviewView.tsx
echo ""

# ── R010: Worker Output Attribution ────────────────────
echo "── R010: Worker output attribution ─────────────────"
check "worker_output event type in handleOrchEvent" \
  rg "worker_output" src/hooks/orchestration/handleOrchEvent.ts
check "orch_tag parameter in process manager" \
  rg 'orch_tag' src-tauri/src/process/manager.rs
check "orch_tag used in commands/orchestrator.rs" \
  rg 'orch_tag' src-tauri/src/commands/orchestrator.rs
echo ""

# ── R012: Worktree Cleanup ─────────────────────────────
echo "── R012: Worktree cleanup ──────────────────────────"
check "cleanup_stale_worktrees exists in worktree/manager.rs" \
  rg 'fn cleanup_stale_worktrees' src-tauri/src/worktree/manager.rs
check "cleanupWorktrees called on startup in index.tsx" \
  rg 'cleanupWorktrees' src/routes/index.tsx
check "cleanupWorktrees used in CodeReviewView" \
  rg 'cleanupWorktrees' src/components/views/CodeReviewView.tsx
echo ""

# ── S05 Fixes ──────────────────────────────────────────
echo "── S05 Fixes (diffs_ready field + startup cleanup) ─"
check "diffs_ready uses \"diffs\" field (not \"worktrees\")" \
  rg '"diffs"' src-tauri/src/commands/orchestrator.rs
check_absent "No \"worktrees\" field in diffs_ready emit" \
  rg '"worktrees".*diffs_summary\|diffs_summary.*"worktrees"' src-tauri/src/commands/orchestrator.rs
check "Startup cleanup useEffect in index.tsx" \
  rg 'cleanupWorktrees.*projectDir' src/routes/index.tsx
echo ""

# ── Compile Gates ──────────────────────────────────────
echo "── Compile Gates ───────────────────────────────────"

echo "  Running: npx tsc --noEmit..."
if npx tsc --noEmit --project tsconfig.json 2>&1; then
  echo "  PASS: TypeScript compiles cleanly"
  ((PASS++))
else
  echo "  FAIL: TypeScript has errors"
  ((FAIL++))
fi

echo "  Running: cargo test --lib (from src-tauri/)..."
CARGO_OUTPUT=$(cd src-tauri && cargo test --lib 2>&1) || true
CARGO_LAST=$(echo "$CARGO_OUTPUT" | grep 'test result:' | tail -1)
if echo "$CARGO_LAST" | grep -q '0 failed'; then
  echo "  PASS: cargo test --lib — all tests pass"
  echo "        $CARGO_LAST"
  ((PASS++))
else
  echo "  FAIL: cargo test --lib — tests failed or did not complete"
  echo "$CARGO_OUTPUT" | tail -5
  ((FAIL++))
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0

# ══════════════════════════════════════════════════════════
# UAT Runbook — Manual Runtime Verification Steps
# ══════════════════════════════════════════════════════════
#
# These steps require a running app with real CLI agents.
# They cannot be fully automated in CI — they verify end-to-end
# runtime behavior through the GUI.
#
# 1. Start the app:
#    cargo tauri dev
#
# 2. Submit a multi-step task to trigger decomposition:
#    - Type a complex request (e.g. "Refactor auth module and add tests")
#    - Verify the master agent decomposes it into sub-tasks
#    - Sub-tasks should appear as cards in the task view (R001)
#
# 3. Approve tasks in TaskApprovalView (R006):
#    - The phase_changed event should set the active plan
#    - plan_id should be present and guard the setActivePlan call
#
# 4. Watch workers execute in parallel with attributed output (R010):
#    - Each worker's output should appear tagged with its dag_id via orch_tag
#    - worker_output events should route to the correct sub-task card
#
# 5. Verify CodeReviewView shows per-worktree diffs after review (R008, R009):
#    - After workers complete, the review phase should trigger
#    - build_review_prompt_with_diffs should include actual file diffs
#    - CodeReviewView should render DiffReview components per worktree
#    - "Merge All" button should be visible for batch operations
#
# 6. Merge changes and confirm worktree cleanup (R012):
#    - Click "Merge All" or per-worktree merge buttons
#    - After merge completes, cleanupWorktrees should run
#    - Stale worktrees should be removed from disk
#
# 7. Deliberately trigger a failure and confirm error card (R002):
#    - Submit a task that will cause the master agent to fail decomposition
#    - The decomposition_failed event should fire
#    - DecompositionErrorCard should display with resultSummary detail
#
# 8. Restart the app and verify startup cleanup (S05 fix):
#    - On app launch with a project open, the useEffect should call
#      cleanupWorktrees(projectDir)
#    - Browser console should NOT show "Startup worktree cleanup failed"
#    - Any leftover worktrees from previous sessions should be cleaned
