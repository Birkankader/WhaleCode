#!/bin/sh
# Phase 6 Step 0 edge-case fixture for Gemini text output.
#
# Gemini's text mode is the most fragile parser surface — it
# emits prose, not structured events. Edge shapes the heuristic
# matcher must handle:
#
#   1. Verb collisions ("Reading" appears in normal prose):
#      "Reading the spec carefully before changes." — heuristic
#      should NOT trigger FileRead because no path follows in the
#      expected `Reading <path>` shape.
#   2. Path with spaces (rare on real repos but possible).
#   3. Multi-action line ("Edited a.ts and b.ts."):
#      Heuristic captures one or splits — Step 2 design choice.
#      Diagnostic recommends single-event-per-line; chip stack
#      compression handles bursts.
#   4. Quoted file path ("Reading 'src/auth.ts'") — common
#      Gemini formatting variation.
#   5. Untranslatable verbs ("Analyzed dependency graph") — no
#      FileEdit / FileRead trigger; plain log line.
#   6. Empty stdout or trailing whitespace.

set -eu

cat <<'EOF'

Investigating the codebase.
Reading the spec carefully before changes.
Reading src/auth.ts
Reading 'src/types.ts'
Edited a.ts and b.ts.
Analyzed dependency graph.
Running: cargo test --lib
   Trailing whitespace line below.

Done.
EOF
