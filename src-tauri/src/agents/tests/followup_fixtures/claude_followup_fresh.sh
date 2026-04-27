#!/bin/sh
# Phase 7 Step 0 fixture: Claude Code follow-up turn WITHOUT
# prior-context prefix in the prompt.
#
# Pair with `claude_followup.sh`. Both fixtures cover the same
# scenario (extend signup with strength meter on parent branch
# `a1b2c3d`) but this one models the agent receiving a **fresh
# prompt** — no `# Parent run summary` block, no `parent_commit_sha`
# reference. The agent must derive everything from the worktree
# state (which already has the parent's commit applied).
#
# Why this fixture exists: Phase 7 Step 0 must answer "does the
# agent benefit from prior-context injection, or is the worktree
# state self-sufficient?" The diagnostic tests assert both shapes
# produce coherent tool-event sequences. The Step 5 spec
# recommendation falls out of which fixture's output is materially
# better (more focused, fewer discovery tool_uses).
#
# Sequence here: agent does NOT inspect git log first (no parent
# context to reconcile with) — goes straight to source.
# Discovery cost: 1 fewer Bash event, 1 fewer thinking block.

set -eu

cat <<'EOF'
{"type":"system","subtype":"init","model":"claude-sonnet"}
{"type":"thinking","thinking":"Adding password strength meter to signup form."}
{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"src/signup.tsx","offset":1,"limit":80}}
{"type":"tool_use","id":"t2","name":"Edit","input":{"file_path":"src/signup.tsx","old_string":"<input type=\"password\"","new_string":"<input type=\"password\" onChange={onPasswordChange}"}}
{"type":"tool_use","id":"t3","name":"Edit","input":{"file_path":"src/signup.tsx","old_string":"export function SignupForm","new_string":"function scoreStrength(p: string) {\n  let s = 0;\n  if (p.length >= 8) s++;\n  if (/[A-Z]/.test(p)) s++;\n  if (/[0-9]/.test(p)) s++;\n  if (/[^A-Za-z0-9]/.test(p)) s++;\n  return s;\n}\n\nexport function SignupForm"}}
{"type":"tool_use","id":"t4","name":"Bash","input":{"command":"pnpm test signup.test.tsx"}}
{"type":"result","subtype":"success","is_error":false,"result":"Added password strength meter (0-4 score). Tests green."}
EOF
