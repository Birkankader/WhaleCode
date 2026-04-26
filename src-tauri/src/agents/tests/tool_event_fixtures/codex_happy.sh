#!/bin/sh
# Phase 6 Step 0 fixture: Codex `exec --json --full-auto` happy-path
# tool-call sequence.
#
# Codex emits JSONL events with `type` discriminator. Tool calls
# come as `function_call` events with `name` + `arguments`. Mapping
# to the unified `ToolEvent` enum:
#
#   function_call.name = "shell"           → ToolEvent::Bash
#   function_call.name = "apply_patch"     → ToolEvent::FileEdit (per file in patch)
#   function_call.name = "read"            → ToolEvent::FileRead
#   function_call.name = "grep" / "search" → ToolEvent::Search
#   anything else                          → ToolEvent::Other
#
# Codex does NOT emit reasoning/thinking blocks in `exec --json`
# output (per Step 0 survey). Phase 6 Step 3's thinking surface is
# Claude-only on the production code path; Codex workers show no
# thinking panel even when the user toggles it on.
#
# Sequence: read → search → apply_patch (single file) → shell → task_complete

set -eu

cat <<'EOF'
{"type":"agent_message","content":"Investigating auth flow."}
{"type":"function_call","name":"read","arguments":{"path":"src/auth.ts"}}
{"type":"function_call","name":"grep","arguments":{"pattern":"validateToken","path":"src"}}
{"type":"function_call","name":"apply_patch","arguments":{"patch":"--- src/auth.ts\n+++ src/auth.ts\n@@ -10 +10 @@\n-if (token<exp)\n+if (token<=exp)\n","files":["src/auth.ts"]}}
{"type":"function_call","name":"shell","arguments":{"command":["bash","-c","pnpm test auth.test.ts"]}}
{"type":"task_complete","result":"Token comparison fixed; tests pass."}
EOF
