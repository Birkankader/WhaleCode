#!/bin/sh
# Phase 7 Step 0 fixture: Codex follow-up turn WITHOUT prior-context
# prefix.
#
# Pair with codex_followup.sh. Same scenario, fresh prompt only.
# Codex with no parent-context prefix skips the `git log` discovery —
# goes straight to read + apply_patch. One fewer function_call event
# in the stream.

set -eu

cat <<'EOF'
{"type":"task_started"}
{"type":"function_call","name":"read","arguments":{"path":"src/signup.tsx"}}
{"type":"function_call","name":"apply_patch","arguments":{"files":["src/signup.tsx","src/signup.test.tsx"],"summary":"Added scoreStrength helper + onChange wiring; 4 unit tests."}}
{"type":"function_call","name":"shell","arguments":{"command":"pnpm test signup.test.tsx"}}
{"type":"task_completed","summary":"Password strength meter added. 4 new tests."}
EOF
