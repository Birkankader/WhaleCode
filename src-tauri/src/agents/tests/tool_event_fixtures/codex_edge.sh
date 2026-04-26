#!/bin/sh
# Phase 6 Step 0 edge-case fixture for Codex JSONL.
#
# Edge shapes the parser must handle:
#
#   1. Malformed JSON (truncated `arguments`).
#   2. Multi-file `apply_patch` — single function_call covering
#      three files. Parser must emit three `ToolEvent::FileEdit`
#      events from one event line, OR (per Step 2 design choice)
#      emit a single `ToolEvent::FileEdit` whose `summary` cites
#      "3 files". The diagnostic recommends per-file expansion so
#      the chip stack can compress same-dir bursts uniformly with
#      Claude single-file edits.
#   3. Unknown function (`name = "browse"`) — routes to `Other`.
#   4. Empty arguments object — parser tolerates, emits Other with
#      empty detail.
#   5. Shell with array-form command (typical Codex shape) — parser
#      joins the array on space for the chip label.

set -eu

cat <<'EOF'
{"type":"agent_message","content":"Multi-file refactor."}
{"type":"function_call","name":"apply_patch","arguments":{"patch":"--- a\n+++ a\n--- b\n+++ b\n--- c\n+++ c","files":["src/a.ts","src/b.ts","src/c.ts"]}
{"type":"function_call","name":"browse","arguments":{"url":"https://example.com"}}
{"type":"function_call","name":"shell","arguments":{"command":["bash","-c","pnpm test"]}}
{"type":"function_call","name":"unknown_tool","arguments":{}}
{"type":"task_complete","result":"Done."}
EOF
