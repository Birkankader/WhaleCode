#!/bin/sh
# Phase 6 Step 0 fixture: Gemini `--output-format text --yolo`
# happy-path tool-use sequence.
#
# Gemini does NOT emit structured tool events in text mode. The CLI
# prints natural-language descriptions of its actions interleaved
# with model output. The Step 0 diagnostic recommends a regex/
# heuristic matcher for Gemini, accepting lower fidelity than the
# JSONL adapters.
#
# Lines this fixture exercises (matching Gemini-CLI output observed
# in Phase 3.5 latency benchmarks):
#
#   "Reading <path>"               → ToolEvent::FileRead
#   "Edited <path>"                → ToolEvent::FileEdit
#   "Running: <command>"           → ToolEvent::Bash
#   "Searching for '<query>'"      → ToolEvent::Search
#   anything else                  → no ToolEvent (plain log)
#
# Gemini emits no thinking/reasoning blocks; Step 3's thinking
# panel stays empty for Gemini workers.

set -eu

cat <<'EOF'
Investigating auth flow.
Reading src/auth.ts
Searching for 'validateToken' in src/
Found 3 matches.
Edited src/auth.ts: replaced '<' with '<=' in token comparison.
Running: pnpm test auth.test.ts
Tests pass. Done.
EOF
