#!/bin/sh
# Phase 7 Step 0 fixture: Codex follow-up turn.
#
# Mirror of claude_followup.sh for Codex's `exec --json --full-auto`
# JSONL shape. Same scenario (extend signup with strength meter on
# parent branch `a1b2c3d`) with the parent-context prefix in the
# prompt. Codex emits `function_call` events instead of `tool_use`.
#
# Codex follows the worktree-state-is-truth pattern by default —
# `exec --json` is stateless, no session token, no prior-message
# carry. The follow-up prefix appears in the prompt body via
# `extra_context` (same channel Phase 5 Step 4 / Phase 6 Step 4 use).
#
# Sequence: shell `git log` discovery → read → apply_patch (single
# multi-file patch covering both edits + a new test file).

set -eu

cat <<'EOF'
{"type":"task_started"}
{"type":"function_call","name":"shell","arguments":{"command":"git log --oneline -5"}}
{"type":"function_call","name":"read","arguments":{"path":"src/signup.tsx"}}
{"type":"function_call","name":"apply_patch","arguments":{"files":["src/signup.tsx","src/signup.test.tsx"],"summary":"Added scoreStrength helper + onChange wiring; covered with 4 unit tests."}}
{"type":"function_call","name":"shell","arguments":{"command":"pnpm test signup.test.tsx"}}
{"type":"task_completed","summary":"Password strength meter added on parent's signup form. 4 new tests."}
EOF
