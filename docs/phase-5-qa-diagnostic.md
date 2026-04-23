# Phase 5 Step 0 — Q&A adapter capability diagnostic

**Recorded:** 2026-04-23 at start of Phase 5.
**Scope:** Read-only survey of the three agent adapters + two fake-agent fixtures that lock in the pre-Phase-5 baseline. No production code change.
**Consumed by:** Phase 5 Step 4 (interactive agent Q&A).

## Why this diagnostic exists

Phase 4 Step 0 established a pattern: before writing spec for a cross-stack backend surface, survey the adapters to find out what signal actually exists today. That diagnostic shrank Phase 4 Step 5's scope from a full `SubtaskState::Crashed` variant to a one-field discriminant on `subtask_state_changed`. Phase 5 Step 4 is the largest item in the phase and the first step since Phase 3 to touch adapter internals; a two-day spike here pays the same leverage.

Three questions per adapter:

1. **Question-signal on stdout before exit?** Does the CLI emit anything (structured or textual) that distinguishes "I have a question" from "I am writing my final answer"?
2. **Stdin injection after spawn?** Does the CLI read additional input from stdin after the initial prompt, so a user answer can be delivered to a still-running process?
3. **Exit code distinguishable from normal completion?** If the CLI gives up and emits a question, does the exit code carry that, or does it return 0?

## Findings

### `run_streaming` contract today

All three adapters funnel through `src-tauri/src/agents/process.rs::run_streaming`. The stdin contract is single-shot:

```rust
// process.rs:96-109
if let Some(prompt) = spec.stdin {
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(e) = stdin.write_all(prompt.as_bytes()).await {
            let _ = child.kill().await;
            return Err(AgentError::SpawnFailed { ... });
        }
        // Explicit drop → EOF. The child sees its turn is over.
        drop(stdin);
    }
}
```

The initial prompt is written in one call; the pipe is then dropped (EOF). No surface exists today for injecting further stdin into a running worker. Step 4 must either add one (for the interactive path) or side-step it via re-spawn (for the single-shot path).

### Per-adapter survey

**Claude (`src-tauri/src/agents/claude.rs::execute`):**

- Invocation: `claude --print --dangerously-skip-permissions --add-dir <worktree>`. Prompt via stdin + EOF.
- `--print` is explicitly non-interactive mode. Claude Code's interactive mode (no `--print`) would accept follow-up input, but the current adapter never spawns that mode.
- Question signal: none structured. A question would come back as text inside the `result` field of the `--output-format json` envelope (plan path) or as plain stdout text (execute path — which uses `--print` without JSON wrapping).
- Stdin injection: **not possible today** — single-write + drop. Would require: swap `--print` for interactive mode + keep stdin open + maintain per-adapter stdin handle in the agent layer.
- Exit code: 0 on any clean finish. A question-as-answer exits 0 with the question in the `result` body. Indistinguishable from a normal completion.

**Codex (`src-tauri/src/agents/codex.rs::execute`):**

- Invocation: `codex exec --json --full-auto -C <worktree>`. Prompt via stdin + EOF.
- `codex exec` is single-shot by design — it consumes one prompt and exits. No interactive mode exposed by the CLI flags the adapter uses.
- Question signal: stream of JSONL events on stdout. A question event, if one exists, would be one more event type in the stream. The current `handle_execute_output` flow treats the stream as opaque until the terminal "result" event; a question event would not terminate the stream unless the CLI explicitly emits one.
- Stdin injection: **not supported by the CLI.** Codex `exec` is a one-shot transaction.
- Exit code: 0 on clean finish; no question-distinct exit code observed in CLI docs.

**Gemini (`src-tauri/src/agents/gemini.rs::execute`):**

- Invocation: `gemini --output-format text --yolo --include-directories <worktree>`. Prompt via stdin + EOF.
- Single-shot like Codex. `--yolo` bypasses interactive approval prompts entirely.
- Question signal: plain text output. A question would be in the stdout body, terminated by a trailing `?` or similar.
- Stdin injection: **not supported by the CLI.** Same single-shot contract.
- Exit code: 0 on clean finish. Empty stdout with exit 1 is a known rate-limit / cold-start shape (Phase 3.5 benchmark notes) — not the Q&A shape.

### Matrix

| Adapter | Question signal available? | Stdin injection possible? | Exit distinguishable? |
|---|---|---|---|
| Claude (`--print`) | No (text only; question sits inside `result` body) | No (single-write + EOF; would require mode swap to interactive) | No (exit 0) |
| Codex (`exec -p`) | No (JSONL stream has no "question" event in observed output) | No (CLI is single-shot by design) | No (exit 0) |
| Gemini (single-shot) | No (plain text; question sits in stdout body) | No (CLI is single-shot by design) | No (exit 0) |

**Three-for-three: no structured signal, no injection path, no exit discriminator.** Every detection must be heuristic (based on stdout content), and every response must be either (a) a mode-swap + stdin-keep-open for Claude only, or (b) a re-spawn with answer-appended prompt for all three.

## Baseline tests

Two fake-agent fixtures lock in today's behavior. Tests at `src-tauri/src/agents/tests/question_shapes.rs`:

1. **Shape G — question + block-on-stdin** (fixture: `fake_asks_question_then_waits.sh`). Simulates what an interactive-mode adapter would do: write question, wait for answer. Under pre-Phase-5 `run_streaming` the fixture's second read sees EOF (stdin dropped after initial prompt) and falls through to its "no answer received" exit-0 branch. The orchestrator sees `ChildOutput { exit_code: Some(0), stdout: "...?..." }` and marks the subtask `Done`. Test asserts the no-answer branch fires, the `?` survives in stdout, and the resumed-after-answer branch does not fire.

2. **Shape H — question + exit-0** (fixture: `fake_asks_question_then_exits.sh`). Simulates the observed Phase 3 bug: worker emits question as its final line, exits 0. Orchestrator marks Done. Test asserts the indistinguishability: exit 0, question in stdout, trailing `?` on the last non-empty line — the heuristic signal Step 4's detector will key on.

Plus two supporting tests:

3. **Shape G + no-stdin → EOF cascade.** Records that today there is no hang path without Step 4's stdin-keep-open wiring.
4. **Shape G + custom question copy.** Parameterizes the question via `FAKE_QUESTION` so Step 4 adapter-specific tests can exercise false-positive heuristics (mid-sentence `?` vs terminal `?`).

All four baseline tests pass on `main` (today). They document the current state; Phase 5 Step 4's acceptance criteria include different assertions that these same fixtures will exercise under the new code.

## Recommendations for Phase 5 Step 4

### Detection signal per adapter — all three use heuristic

No structured signal exists in any adapter's current output. Step 4 detection is heuristic across the board:

- **Signal:** last non-empty stdout line ends in `?` *and* the line appears within a 2-second quiesce window before EOF-on-stdout / child-exit.
- **For Claude:** applied to the `result` body of the `--output-format json` envelope (plan-equivalent flow) or to the last stdout chunk (execute flow). The detection is evaluated after the adapter has attempted parse: if `ParseFailed` on an otherwise-clean exit and the last non-empty output line ends in `?`, flag as question.
- **For Codex:** applied to the last JSONL event's message text. If no terminal "result" event arrived and the last message ended in `?`, flag as question.
- **For Gemini:** applied directly to the last stdout line.

**False-positive calibration** must happen in Step 4 verification on a real-adapter run of 10 diverse tasks; the 5% threshold stated in the spec's Step 4 risk flags governs tightening.

### Response path — two mechanics, same UI

- **Stdin-injection path (Claude interactive-mode only, Step 4 sub-feature):** Swap `--print` for interactive mode in the adapter's execute args. Keep stdin open after the initial prompt. Store a per-subtask stdin write handle in the dispatcher (new `HashMap<SubtaskId, ChildStdin>`, guarded under the existing run arc). On `answer_subtask_question`, write the answer + newline to the handle. Worker continues naturally. Requires process-lifecycle tightening — the handle needs to be closed on cancel, on timeout, on natural exit.
- **Restart-with-appended-prompt path (Codex, Gemini, Claude fallback):** Re-spawn the adapter via `adapter.execute()` with the original `Subtask` plus a new `extra_context` line "User answered: <answer>" appended. The adapter's `build_execute_prompt` already accepts `extra_context` for Layer-1 retry — reuse the plumbing; Step 4 adds a new `RetryReason::QuestionAnswer` variant so the appended copy is distinct from a retry-after-failure. Does **not** count against Layer 1 retry budget.

Both mechanics land the same UI: `SubtaskState::AwaitingInput` + `QuestionInput` component. Only the backend differs.

### False-positive cost

Mid-sentence `?` ("Is this the right approach? I'll try option A.") would be caught by the "last non-empty line ends in `?`" heuristic only if the line ending in `?` is literally the last one. The fake fixtures' test parameterization exercises the common mid-sentence case by design.

Cost of a false positive:
- **High-visibility:** a worker that finished its work and wrote `Done. Anything else?` as its final line would be flagged as awaiting-input. User must click "Skip question, mark as done" to clear. Cheap one-click recovery.
- **Low-impact:** no data loss — the worker's output is preserved; marking done retains the diff.
- **Calibration:** target < 5% false-positive rate on 10 diverse real-adapter tasks. If exceeded, tighten heuristic (e.g., require question word at sentence start — "which", "should", "does", "can", "do you", "is it").

### Timeout strategy — UI-side cap

Adapter-specific timeouts are heterogeneous (10-min plan, 30-min execute). A question-awaiting state bound by the execute timeout is too lenient — a user walking away would see a 30-minute stall before the worker gives up.

**Recommended:** UI-side 10-minute cap on `AwaitingInput`. After 10 minutes with no answer, emit a "question timed out" toast and transition the subtask to `Failed` with `errorCategory: timeout`. The underlying worker's stdin handle is closed (interactive path) or no worker is actually running (single-shot path, waiting for re-spawn input). Consistent behavior across adapters. User can always explicitly Stop via Step 1 before the cap.

## State vs discriminant — recommendation

**Recommend: new `SubtaskState::AwaitingInput` variant.** The Phase 4 Step 5 discriminant pattern works when the subtask's lifecycle transitions are unchanged; Q&A *changes the transitions* (dispatch gated, cancel routing differs, aggregate-diff pass skips it). A discriminant on `Running` would lie about what the subtask can do. The state carries correct gating — `Retrying` is the existing precedent for "transient state that affects dispatch but doesn't persist."

The diagnostic findings reinforce this: with no structured signal and no stdin-injection available in two of three adapters, transitioning to `AwaitingInput` is the only way to correctly gate the Layer-1 retry path. A worker in `Running` with `awaiting_input: true` would race with the existing Layer-1 retry trigger on timeout / non-zero exit; a worker in `AwaitingInput` is unambiguously paused.

## Open questions the spike answered

- **Do any adapters emit a structured question signal?** No. All three would need heuristic detection.
- **Restart-with-appended-prompt pain level?** Unknown magnitude of output divergence — Step 4 verification must calibrate on a real-adapter run. Known cost: re-running a prompt burns another API-call budget; we bear this to preserve single-shot adapter Q&A.
- **User walkaway timeout:** UI-side 10-minute cap (not adapter-specific). Explicit Stop always available.

## Surprises that affect Step 4 scope

1. **No structured signal exists anywhere.** The spec's Step 4 pathway where "structured signal available on at least one adapter" is **not** the world we live in. Step 4's detection layer is heuristic-only for all three adapters. This modestly increases the false-positive-tuning burden but does not change the architectural shape.
2. **Claude's `--print` mode is the current execution flow — interactive mode is not wired.** Supporting stdin injection on Claude requires swapping to interactive mode, which changes the entire output format (no more JSON envelope for execute, though execute already doesn't use the envelope). Step 4 mode-swap must be scoped and tested carefully; it may be cheaper to fall back to restart-with-appended-prompt for Claude too and defer the interactive-mode work to Phase 6. **Recommendation:** start Step 4 with restart-with-appended-prompt universally; add interactive-mode stdin injection for Claude only if false-positive calibration shows users commonly ask follow-up questions where output divergence from re-spawn is unacceptable.
3. **Codex `exec` subcommand has no interactive mode flag available** in the adapter's current invocation. Single-shot is the only path. Restart-with-appended-prompt is the only response mechanic. This was anticipated; recorded here for completeness.

## Step 4 scope impact summary

Step 4 budget **shrinks** slightly on evidence of this diagnostic, because one of its two backend mechanics (stdin-injection) can be deferred to a follow-up if false-positive calibration is tight. Proposed revised Step 4 scope:

- **Universal:** heuristic detection + `SubtaskState::AwaitingInput` + `answer_subtask_question` IPC + restart-with-appended-prompt response path + `QuestionInput` UI + Skip affordance.
- **Optional (conditional on Step 4 verification's false-positive + divergence numbers):** Claude-only interactive-mode stdin injection.

If "optional" is deferred, Step 4 collapses from 4.5 days to ~3 days and frees time for Step 5 verification to include the Q&A calibration run properly. Final call during Step 4 planning.

## Cap

Step 0 delivered in well under the 2-day cap (approximately 2 hours: survey + fixtures + tests + doc). The leverage pattern from Phase 4 holds: a short diagnostic upstream of the big step pays back the rest of the phase.
