#!/bin/sh
# Phase 6 Step 0 edge-case fixture: Claude stream-json with shapes
# the parser must tolerate without panic:
#
#   1. Malformed JSON line (missing closing brace) — parser must
#      log + skip, never crash the tee.
#   2. Unknown tool kind (`tool_use.name = "WebFetch"`) — parser
#      routes to `ToolEvent::Other` per the spec's escape hatch.
#   3. Tool with binary file payload (Edit on `assets/logo.png`)
#      — parser captures path, summary stays generic.
#   4. Multi-tool atomic burst (Read + Read + Read same dir within
#      ~50ms) — parser emits 3 events; chip-stack compression rule
#      collapses them downstream in Step 2.
#   5. Truncated thinking block (no closing tag would arrive in a
#      real stream cut mid-flight). Modeled here as a single
#      `thinking` event whose body ends abruptly — parser must
#      treat each `thinking` line independently.
#   6. Very long path (200+ chars) — parser captures verbatim;
#      truncation lives in the UI (chip label render), not here.

set -eu

cat <<'EOF'
{"type":"system","subtype":"init","model":"claude-sonnet"}
{"type":"thinking","thinking":"Starting investigation, will be cut by stream"
{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"src/a.ts"}}
{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"src/b.ts"}}
{"type":"tool_use","id":"t3","name":"Read","input":{"file_path":"src/c.ts"}}
{"type":"tool_use","id":"t4","name":"WebFetch","input":{"url":"https://example.com/spec"}}
{"type":"tool_use","id":"t5","name":"Edit","input":{"file_path":"assets/logo.png","old_string":"<binary>","new_string":"<binary>"}}
{"type":"tool_use","id":"t6","name":"Read","input":{"file_path":"src/very/long/path/that/exceeds/normal/lengths/and/keeps/going/and/going/and/going/until/we/have/well/over/two/hundred/characters/in/this/single/path/segment/auth.ts"}}
{"type":"result","subtype":"success","is_error":false,"result":"Done with edge cases."}
EOF
