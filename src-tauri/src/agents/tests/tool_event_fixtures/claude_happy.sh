#!/bin/sh
# Phase 6 Step 0 fixture: Claude Code `--print --output-format
# stream-json` happy-path tool-use sequence.
#
# Models the wire shape Phase 6 Step 2 will tee through the parser.
# Each line is a JSON object (NDJSON). Worker tasks stream these on
# stdout; the parser converts a subset (`tool_use`, `thinking`) into
# `ToolEvent` / `ThinkingChunk` events.
#
# This fixture is intentionally minimal — the diagnostic asserts on
# `tool_use.name` + `tool_use.input` shape per tool kind. Real Claude
# output contains additional fields (id, message wrapper) which the
# parser tolerates but doesn't depend on.
#
# Sequence: thinking → Read → Grep → Edit → Bash → result
#
# Phase 6 Step 0 — read-only fixture. Step 2 lands the production
# parser + integration tests that exercise this fixture against the
# actual `parse_tool_event` impl.

set -eu

cat <<'EOF'
{"type":"system","subtype":"init","model":"claude-sonnet"}
{"type":"thinking","thinking":"Need to find auth flow first."}
{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"src/auth.ts","offset":1,"limit":50}}
{"type":"tool_use","id":"t2","name":"Grep","input":{"pattern":"validateToken","path":"src"}}
{"type":"thinking","thinking":"Found it. Edit needed."}
{"type":"tool_use","id":"t3","name":"Edit","input":{"file_path":"src/auth.ts","old_string":"if (token<exp)","new_string":"if (token<=exp)"}}
{"type":"tool_use","id":"t4","name":"Bash","input":{"command":"pnpm test auth.test.ts"}}
{"type":"result","subtype":"success","is_error":false,"result":"Done. Added <= comparison."}
EOF
