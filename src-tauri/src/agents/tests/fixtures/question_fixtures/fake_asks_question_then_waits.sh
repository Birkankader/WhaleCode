#!/bin/sh
# Phase 5 Step 0 fixture: simulates an interactive-mode agent that
# emits a question on stdout and *blocks on stdin* for the answer.
# Models what the Claude Code interactive mode would do if we spawned
# it without `--print`: the CLI writes a question, flushes stdout, and
# waits for more input before proceeding.
#
# Today's `run_streaming` writes the initial prompt to stdin once and
# drops it (EOF). Under that contract this fixture reads prompt lines
# until EOF, emits a question on stdout, then attempts a second read
# which returns EOF immediately — so the fixture falls through to its
# "no answer received" branch and exits 0 with the question still in
# stdout. That's the pre-Phase-5 baseline the baseline test asserts.
#
# Phase 5 Step 4 will either:
#   (a) keep stdin open until an answer is injected, then feed the
#       fixture the user's reply on a second write, and the fixture
#       will emit its "resumed" line; or
#   (b) for non-injection adapters, re-spawn the fixture with the
#       answer appended to the prompt.
#
# Env knobs:
#   FAKE_QUESTION   question text (default: "which option should I proceed with, A or B?")
#   FAKE_ANSWER_ACK acknowledge line emitted after reading answer
#                   (default: "received answer: ")

set -eu

question=${FAKE_QUESTION:-"which option should I proceed with, A or B?"}
ack=${FAKE_ANSWER_ACK:-"received answer: "}

# Drain the initial prompt (the orchestrator's worker prompt). We don't
# echo it — only the answer line matters for observation.
first_line=""
while IFS= read -r line; do
  if [ -z "$first_line" ] && [ -n "$line" ]; then
    first_line="$line"
  fi
done || true

# Emit the question. Trailing '?' is the heuristic signal Phase 5 Step
# 4's detection layer will key on.
printf '%s\n' "$question"

# Now wait for an answer. Under pre-Phase-5 run_streaming this read
# returns EOF immediately (stdin was dropped after the initial prompt),
# so the fixture falls through to the no-answer branch.
#
# Phase 5 Step 4 will keep stdin open; when an answer arrives the read
# succeeds and we emit the "resumed" line instead.
answer=""
if IFS= read -r answer; then
  printf '%s%s\n' "$ack" "$answer"
  echo "done: resumed after answer"
  exit 0
fi

# No answer received path (pre-Phase-5 baseline).
echo "done: exited without answer"
exit 0
