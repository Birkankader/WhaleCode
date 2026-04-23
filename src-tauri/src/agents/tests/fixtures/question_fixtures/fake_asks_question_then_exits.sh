#!/bin/sh
# Phase 5 Step 0 fixture: simulates a single-shot agent (Codex `-p` /
# Gemini single-shot) that emits a question on stdout and *exits 0*
# without reading any further stdin.
#
# Models the observed Phase 3 bug: a worker agent that isn't sure what
# to do writes a question to stdout, treats the question as its final
# answer, and exits cleanly. The orchestrator sees exit code 0 and
# marks the subtask `Done` with the question in its log — there is no
# signal today that distinguishes "asked a question" from "finished
# the work."
#
# Phase 5 Step 4's non-injection path will detect this via the
# heuristic "last non-empty stdout line ends in '?' AND exit code 0
# AND no result JSON parsed" — then re-spawn the adapter with the
# answer appended to the original prompt.
#
# Env knobs:
#   FAKE_QUESTION   question text (default: "should I use option A or B?")

set -eu

question=${FAKE_QUESTION:-"should I use option A or B?"}

# Drain the initial prompt but don't act on it — this fixture never
# reads a second line, which is the point.
while IFS= read -r _line; do
  :
done || true

# Some lead-in context, then the question as the final line. The
# trailing '?' is the heuristic signal; the exit 0 + no-result-JSON is
# the other half of the detection condition.
echo "looking into the task..."
echo "there are two reasonable approaches."
printf '%s\n' "$question"

exit 0
