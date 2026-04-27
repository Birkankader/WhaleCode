# Phase 6 verification — real-time partnership

Goal-backward verification per Phase 4 / Phase 5 template.
Each Phase 6 success criterion is restated and given a PASS / FAIL
verdict with the evidence that backs it. Step-level acceptance is
rolled up at the end against the spec.

## Goal-backward — success criteria

Phase 6 defined 3 success criteria in `docs/phase-6-spec.md`. Each
is restated here with verdict and evidence.

### ✅ Criterion 1 — activity chips on running worker cards

> During worker execution, the user sees a stream of structured
> activities (file reads / edits, shell commands, searches) on
> each worker card, parallel to but distinct from the raw log
> tail.

**PASS (always-on backend parsing + frontend chip stack per
Step 0 recommendation).**

- Step 0 diagnostic (`docs/phase-6-toolparsing-diagnostic.md`)
  produced the per-adapter format matrix and committed to the
  unified `ToolEvent` enum (`FileRead`, `FileEdit`, `Bash`,
  `Search`, `Other`) implemented in Step 2.
- Backend tee: `forward_logs` extended to pass each line through
  the adapter parser. Parses emit
  `RunEvent::SubtaskActivity { run_id, subtask_id, event,
  timestamp }` alongside the existing `SubtaskLog`. Both fire —
  log is still authoritative.
- Adapter coverage:
  - **Claude** upgraded to `--print --output-format stream-json`;
    NDJSON tool-use events parse via `serde_json::from_str` per
    line, full coverage of `Read` / `Edit` / `Bash` / `Grep` /
    `Glob`, unknowns route to `ToolEvent::Other`.
  - **Codex** `exec --json --full-auto` JSONL parsed via the same
    `serde_json` path; `apply_patch` fans out to one `FileEdit`
    chip per file in the patch.
  - **Gemini** text-mode parsed via heuristic regex matcher
    (verb-prefix patterns); fidelity gap accepted per Step 0
    recommendation.
- Frontend: `subtaskActivities: Map<SubtaskId, ToolEvent[]>`
  store slice capped at 50 events per subtask;
  `ActivityChipStack` renders the most recent 5 chips with
  fade-in animation; compression rule ("same kind + same parent
  dir within 2s") collapses bursts to "Reading 4 files in src/"
  shape.
- Tests: 13 `activityCompression.test.ts` cases covering the
  collapse rule, edge cases (different dirs, mixed kinds, time
  gap > 2s), plus integration tests in
  `graphStore.integration.test.ts` for the 100-event flood →
  50-stored cap, parser-tee ordering vs log lines, a11y
  `aria-label` shape. Rust side: `tool_event_shapes.rs`
  fixtures and integration tests for each adapter (one
  happy-path, one edge-case fixture per adapter).
- Visual obs 01 confirms multi-adapter rendering, compression
  in flight, and a11y on real cards.

### ✅ Criterion 2 — opt-in thinking surface

> For Claude workers (and Codex/Gemini if their format permits per
> Step 0 spike), agent thinking blocks render as a distinct,
> opt-in surface above the log tail. Default off — verbose by
> nature, on-demand for users who want depth.

**PASS (Claude-only per Step 0 capability matrix; Codex/Gemini
gated as designed).**

- Step 0 confirmed: Claude emits structured `<thinking>` blocks
  via stream-json (`{"type":"thinking","thinking":"…"}`); Codex
  `exec --json` does not surface model reasoning; Gemini text
  mode emits no reasoning blocks. Phase 6 ships thinking for
  Claude only, with capability gate on the others.
- Backend parser extension extracts thinking content separately
  from log content; emits
  `RunEvent::SubtaskThinking { run_id, subtask_id, chunk,
  timestamp }` per block. Capped at 500 chunks per subtask
  in-memory, oldest dropped on overflow.
- Frontend: `subtaskThinking: Map<SubtaskId, string[]>` store
  slice; per-card `ShowThinkingToggle` (Brain icon, default
  off); `ThinkingPanel` component above the log tail with
  italicized + muted styling, default-collapsed at 3 chunks
  with "Show all N" expand affordance.
- **Capability gating.** `supportsThinking` capability flag on
  the adapter trait. Codex / Gemini WorkerNode renders the
  toggle in greyed/disabled state with adapter-specific
  tooltip. Defense-in-depth: `setShowThinking` store action
  short-circuits to no-op if the capability flag is false, so
  even an injected store call cannot show an empty panel on an
  incapable worker.
- Per-worker independence: toggling worker A leaves worker B
  unchanged; store accumulates regardless of toggle state so
  re-enabling shows the full backlog.
- Tests: `nodeMachine.test.ts` and `graphStore.test.ts` cover
  toggle state per-subtask; capability-gate no-op test in
  `graphStore.integration.test.ts`; Rust-side parser unit tests
  in `agents/claude.rs` for thinking-tag extraction.
- Visual obs 02 confirms italic/muted styling, empty-state copy,
  capability tooltips, per-worker independence, persistence
  scope.

### ✅ Criterion 3 — mid-execution hint injection

> A user can inject a hint to a running worker without cancelling
> the run: the worker stops gracefully (reusing Phase 5 Step 1
> infrastructure) and restarts with the hint appended to the
> prompt. Distinct from Q&A — hint is user-initiated, Q&A is
> worker-initiated.

**PASS (shared `restart_with_extra` helper, cancel-priority
preserved).**

- New IPC `hint_subtask(run_id, subtask_id, hint)` signals
  graceful cancel via Phase 5 Step 1's per-subtask cancel token,
  then re-dispatches with `extra_context = original_extra +
  "User hint: <hint>"`.
- `restart_with_extra(run_id, subtask_id, extra)` extracted from
  Phase 5 Step 4's `resolve_qa_loop` re-execute branch. Now
  shared between Q&A re-execute and hint re-dispatch. Pending-
  channels map updated atomically; no cross-talk in concurrent
  hint × Q&A scenarios (covered by integration test).
- New `RunEvent::HintReceived { run_id, subtask_id, hint }` event
  emitted post-dispatch. `subtask_activity` and
  `subtask_thinking` events resume on the new attempt.
- **`CancelDecision` priority.** New decision tree resolves
  manual-cancel (Stop) > hint-restart > Layer-1 retry. Stop
  during in-flight hint dispatch wins — worker terminates as
  Cancelled, hint dispatch is dropped. Test:
  `stop_during_hint_takes_priority_over_restart`.
- Layer-1 retry budget unchanged. Test:
  `hint_subtask_does_not_consume_retry_budget` asserts no
  Retrying state fires on the hint path.
- Concurrent hint rejection: second hint while first is
  in-flight returns `WrongSubtaskState`. Test:
  `concurrent_hint_returns_wrong_state`.
- Terminal-state rejection: hint on Done / Failed / Cancelled
  worker returns `WrongSubtaskState`. Test:
  `hint_on_terminal_state_rejected`.
- Frontend: inline `HintInput` on running worker cards (single-
  line, "Add hint…" placeholder); shares the QuestionInput slot
  in `awaiting_input` state (Q&A precedence); "Restarting with
  your hint…" caption appears post-submit, dismisses on
  Running re-entry.
- Visual obs 03 confirms inline placement, restart latency under
  ~2s, Q&A precedence, Stop precedence, concurrent rejection,
  terminal rejection.

## Step-level acceptance — raw totals

| Step | Scope | Spec criteria | Verdicts |
|---|---|---|---|
| 0 | Tool-use parsing diagnostic | 3 (matrix, fixtures, recommendation) | 3/3 PASS |
| 2 | Activity chips on cards | 5 | 5/5 PASS |
| 3 | Reasoning / thinking surface | 5 | 5/5 PASS |
| 4 | Mid-execution hint injection | 5 | 5/5 PASS |
| 5 | Verification + retrospective + close-out | (this commit) | this section |

**Total: 18/18 step-level PASS, 3/3 goal-backward PASS, 0
documented gaps blocking Phase 6.**

## Integration test roll-up

New / extended integration tests landing across Steps 0-4:

- `tool_event_shapes.rs` — 6 fixtures (3 adapters × happy + edge),
  parser asserts.
- `activityCompression.test.ts` — 13 cases covering the
  same-kind + same-parent-dir + 2s window collapse rule.
- `graphStore.integration.test.ts` — 100-event flood capped at
  50, capability-gate thinking no-op on Codex / Gemini,
  hint-restart preserves chip-stack reset, hint-restart
  preserves thinking accumulation across attempts.
- `restart_with_extra` shared by Q&A re-execute and Hint
  re-dispatch — exercised by both paths in dispatcher tests.
- `hint_subtask_does_not_consume_retry_budget`,
  `stop_during_hint_takes_priority_over_restart`,
  `concurrent_hint_returns_wrong_state`,
  `hint_on_terminal_state_rejected`.

## Scoreboard

- 3 / 3 goal criteria: **PASS**
- 18 / 18 step-level acceptance: **PASS**
- Frontend tests: **770 / 770** (target ≥ 730 per spec Step 5 — exceeded)
- Rust tests: **397 / 397** (target ≥ 370 — exceeded)
- `pnpm typecheck` clean
- `pnpm lint` clean (pre-existing useVirtualizer warning — KNOWN_ISSUES, unchanged)
- `cargo clippy -- -D warnings` clean
- `pnpm build` succeeds

## Gaps and deferred debt

Nothing blocks Phase 6 shipping. Carried into Phase 7 or later:

- **Per-worker hint counter affordance.** Spec risk flag
  suggested "3 hints applied this session" surface to discourage
  hint loops. Not shipped — left for Phase 7 if real usage
  surfaces hint-loop pain.
- **Gemini activity-chip fidelity gap.** Heuristic regex misses
  any non-verb-prefix variant Gemini emits. Accepted per Step 0
  recommendation. Revisit if user complaints surface.
- **Cost tracking** still unwired — explicitly deferred to
  Phase 7's cost-aware feature suite (see KNOWN_ISSUES).
- **Claude pause-resume pilot** still deferred to Phase 7
  diagnostic step (interactive-mode swap risk).
- **Per-worker outcome summaries / diff content explanations**
  deferred to Phase 7 cost-aware suite.
- Pre-existing **KNOWN_ISSUES #37** test flake under
  `--test-threads=8`; ran Phase 6 gates at default threading,
  no trip observed this phase. Still monitor-only.

## Phase 6 ships.
