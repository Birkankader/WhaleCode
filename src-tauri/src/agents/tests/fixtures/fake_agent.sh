#!/bin/sh
# Fake agent CLI used by integration tests as a stand-in for
# Claude Code / Codex / Gemini. Behavior is knob-driven via env vars
# so a single script covers every scenario the adapter tests want:
# clean plan, malformed output, controlled refusal, crash, slow exit.
#
# Env knobs:
#   FAKE_MODE           plan | execute | refuse | crash   (default: plan)
#   FAKE_EXIT_CODE      integer exit code                 (default: 0)
#   FAKE_DELAY_SECS     sleep before emitting output      (default: 0)
#   FAKE_OUTPUT_FILE    path to a file whose contents are
#                       echoed to stdout instead of the
#                       built-in canned payload            (optional)
#   FAKE_STDERR         text written to stderr before exit (optional)
#
# CLI flags:
#   --version           print a canned version string and exit 0
#   anything else       ignored (stdin is the only input path that matters)

set -eu

# --version short-circuits everything else.
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    echo "fake-agent 0.0.1"
    exit 0
  fi
done

mode=${FAKE_MODE:-plan}
exit_code=${FAKE_EXIT_CODE:-0}
delay=${FAKE_DELAY_SECS:-0}

if [ "$delay" -gt 0 ]; then
  sleep "$delay"
fi

# Drain stdin so tests can verify the caller sent a prompt. We echo
# the first non-empty line to stderr under a marker so assertions
# can pick it up without affecting stdout parsing.
first_line=""
while IFS= read -r line; do
  if [ -z "$first_line" ] && [ -n "$line" ]; then
    first_line="$line"
    echo "[fake-agent] received prompt opener: $first_line" 1>&2
  fi
done || true

if [ -n "${FAKE_STDERR:-}" ]; then
  printf '%s\n' "$FAKE_STDERR" 1>&2
fi

if [ -n "${FAKE_OUTPUT_FILE:-}" ]; then
  cat "$FAKE_OUTPUT_FILE"
  exit "$exit_code"
fi

case "$mode" in
  plan)
    cat <<'EOF'
Breaking the task into two steps.

```json
{
  "reasoning": "small demo plan",
  "subtasks": [
    {"title": "scaffold", "why": "needed first", "assigned_worker": "claude", "dependencies": []},
    {"title": "polish", "why": "after scaffold", "assigned_worker": "claude", "dependencies": [0]}
  ]
}
```
EOF
    ;;
  execute)
    echo "starting"
    echo "working ..."
    echo "done: edited 2 files"
    ;;
  refuse)
    echo "I cannot complete this task because the requirements are unclear." 1>&2
    ;;
  crash)
    echo "fatal: segfault somewhere" 1>&2
    ;;
  *)
    echo "[fake-agent] unknown FAKE_MODE: $mode" 1>&2
    exit 99
    ;;
esac

exit "$exit_code"
