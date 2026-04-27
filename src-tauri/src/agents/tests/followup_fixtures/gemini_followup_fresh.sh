#!/bin/sh
# Phase 7 Step 0 fixture: Gemini follow-up turn WITHOUT prior-context
# prefix.
#
# Pair with gemini_followup.sh. Fresh prompt — agent reads worktree
# state directly, no `git log` discovery prose. Mirrors the claude /
# codex `_fresh` fixtures.

set -eu

cat <<'EOF'
Reading src/signup.tsx
Editing src/signup.tsx: added onChange wiring on password input
Editing src/signup.tsx: added scoreStrength helper
Running: pnpm test signup.test.tsx
Tests pass. Strength meter wired up.
EOF
