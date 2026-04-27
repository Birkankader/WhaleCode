#!/bin/sh
# Phase 7 Step 0 fixture: Gemini follow-up turn.
#
# Gemini in `--output-format text --yolo` worker mode emits prose
# only — no structured tool events. Phase 6 Step 0 already
# established this gap; the heuristic regex matcher catches verb-
# prefix lines (`Reading X`, `Editing X`, `Running: <cmd>`).
#
# This fixture covers the same scenario as claude/codex follow-up
# fixtures (extend signup with strength meter on parent branch
# `a1b2c3d`) with the parent-context prefix in the prompt. Gemini's
# behavior with prior context is the most fragile of the three —
# Gemini is prone to 413s past ~60KB prompt size (see
# `gemini.rs::PROMPT_CHAR_BUDGET` + `trim_tree_to_budget`), so the
# Step 5 follow-up dispatch must clip prior-summary length on
# Gemini specifically.

set -eu

cat <<'EOF'
Looking at recent commits to understand parent state.
Running: git log --oneline -5
Reading src/signup.tsx
Found existing SignupForm component shipped by parent run.
Editing src/signup.tsx: added onChange wiring on password input
Editing src/signup.tsx: added scoreStrength helper
Running: pnpm test signup.test.tsx
Tests pass. Strength meter wired up on parent's signup form.
EOF
