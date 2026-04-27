#!/bin/sh
# Phase 7 Step 0 fixture: Claude Code follow-up turn.
#
# Models a follow-up run on a feature branch where the parent run
# already shipped commit `a1b2c3d` ("Add user signup flow"). The
# follow-up prompt asks the agent to extend that work with a
# password-strength meter on the same form.
#
# Wire shape: same `--print --output-format stream-json` envelope
# Phase 6 Step 2 already consumes. This fixture asserts the agent
# does NOT need any prior conversation context to produce a
# coherent follow-up — it inspects the working tree (Read /
# Grep / Bash `git log`) to discover the parent's commit, then
# proceeds. The Phase 7 Step 5 follow-up run wires `parent_commit_sha`
# + `parent_run_summary` into the existing `extra_context` field
# so the agent can skip the discovery step when desired.
#
# Phase 7 Step 0 — read-only fixture. Step 5 lands the production
# follow-up dispatch path that pre-populates the prior-context
# prefix via the existing `extra_context` channel.

set -eu

cat <<'EOF'
{"type":"system","subtype":"init","model":"claude-sonnet"}
{"type":"thinking","thinking":"Follow-up on signup flow. Check current state first."}
{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"git log --oneline -5"}}
{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"src/signup.tsx","offset":1,"limit":80}}
{"type":"thinking","thinking":"Parent shipped basic signup. Adding strength meter now."}
{"type":"tool_use","id":"t3","name":"Edit","input":{"file_path":"src/signup.tsx","old_string":"<input type=\"password\"","new_string":"<input type=\"password\" onChange={onPasswordChange}"}}
{"type":"tool_use","id":"t4","name":"Edit","input":{"file_path":"src/signup.tsx","old_string":"export function SignupForm","new_string":"function scoreStrength(p: string) {\n  let s = 0;\n  if (p.length >= 8) s++;\n  if (/[A-Z]/.test(p)) s++;\n  if (/[0-9]/.test(p)) s++;\n  if (/[^A-Za-z0-9]/.test(p)) s++;\n  return s;\n}\n\nexport function SignupForm"}}
{"type":"tool_use","id":"t5","name":"Bash","input":{"command":"pnpm test signup.test.tsx"}}
{"type":"result","subtype":"success","is_error":false,"result":"Added password strength meter (0-4 score) wired to existing signup form. Tests green."}
EOF
