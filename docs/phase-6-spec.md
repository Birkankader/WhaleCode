# Phase 6: Real-time partnership

**Status: SHIPPED 2026-04-27.** All 5 steps landed; goal-backward verification at `docs/phase-6-verification.md` (3/3 criteria PASS, 18/18 step-level PASS); retrospective at `docs/retrospectives/phase-6.md`; visual observations at `docs/retrospectives/phase-6-visuals/`. Frontend 770 / 770, Rust 397 / 397. `tsc --noEmit`, `eslint`, `cargo clippy -- -D warnings`, `pnpm build` all clean.

**Goal:** Make the run a partnership the user can read and steer mid-flight. Phase 4 shipped *visibility* (logs, diff popover, apply summary). Phase 5 shipped *unblock* (per-worker stop, conflict resolver, Q&A). Phase 6 ships the *layer between*: process visibility (what is the agent doing right now?) and user-initiated mid-execution intervention (interject without stopping the run).

**Duration estimate:** 8-10 days spec budget. Realistic floor 3-5 active working days based on Phase 3 / 3.5 / 4 / 5 evidence (each came in at 1-2.5 days vs 14-day budgets).

**Theme:** *Real-time partnership.* Phase 6 keeps the structured plan-approve-execute lifecycle — no chat mode, no paradigm shift. Within that lifecycle it adds activity chips so the user can read the agent's tool use as it happens, an opt-in thinking surface for users who want depth, and hint injection so a running worker can be nudged without being killed.

**Success criteria:**

- During worker execution, the user sees a stream of structured activities (file reads / edits, shell commands, searches) on each worker card, parallel to but distinct from the raw log tail.
- For Claude workers (and Codex/Gemini if their format permits per Step 0 spike), agent thinking blocks render as a distinct, opt-in surface above the log tail. Default off — verbose by nature, on-demand for users who want depth.
- A user can inject a hint to a running worker without cancelling the run: the worker stops gracefully (reusing Phase 5 Step 1 infrastructure) and restarts with the hint appended to the prompt. Distinct from Q&A — hint is user-initiated, Q&A is worker-initiated.

## Why this matters

Phase 5's retrospective opened with the observation that the spec cost-model is consistently ~10× too high for the current cadence — but only because we keep scope tight to *closing already-flagged user pain*. Phase 6 candidates listed in `docs/KNOWN_ISSUES.md` cluster around three themes; this revised Phase 6 takes the cleanest two:

- **"What is the agent doing right now?"** — Phase 4 shipped log tails, but logs are raw stdout. The user sees `[claude] Bash($"pnpm test")` mid-stream and has to parse it. Activity chips translate that to "Running pnpm test".
- **"How do I steer mid-flight?"** — Phase 5 shipped Stop + Q&A. Stop is terminal; Q&A is worker-initiated. The user-initiated, non-terminal nudge ("you forgot to update the tests") is missing. Hint injection (Step 4 in this revised numbering) closes it.

The third theme — outcome clarity (per-worker semantic summaries, diff explanations) — is deferred to Phase 7 alongside the cost-aware feature suite. Reasoning: those features introduce LLM-cost user actions, which need per-call cost preview, cumulative session tally, undo affordance, and an optional budget cap. That's a coherent sub-scope, not a tail commit on a phase that otherwise ships zero LLM-cost surfaces.

A pause-resume pilot for Claude (originally proposed as part of Phase 6) is also deferred to Phase 7. The interactive-mode swap it requires would change tool-event output format (this phase's Step 2 parser depends on stable `--print` format), Q&A detection logic, and test fixtures. Feature-flagging doubles every test path; the decision needs a deeper spike than Step 0's budget allows. Phase 7 gives it its own diagnostic step.

Phase 5's Step 0 spike (Q&A capability diagnostic) shrunk Step 4 from 4.5d to ~1.5d. Phase 4's Step 0 (crash-shape diagnostic) had the same effect. Phase 6 leans on the same pattern: Step 0 is a tool-use parsing diagnostic that informs Steps 2 and 3.

## What this phase does NOT include

Defer to Phase 7+ alongside the cost-aware feature suite:

- **Per-worker outcome summaries** (heuristic + semantic). LLM-cost feature; ships with cost dashboard.
- **Diff content explanations** (per-file "Explain this change"). LLM-cost feature; ships with cost dashboard.
- **Cost tracking wire-up.** Schema is in place since Phase 2; Phase 6 ships zero LLM-cost features, so the schema stays unwired this phase.
- **Cost dashboard** (per-worker / per-call / per-month / per-provider breakdowns).
- **Claude pause-resume pilot.** Needs its own Phase 7 diagnostic step covering interactive-mode swap, tool-event format stability, Q&A detection compatibility, and feature-flag rollout cost.

Defer to Phase 7+ on independent grounds:

- **Multi-agent same-task comparison.** Run two adapters on the same subtask and pick the better diff. Phase 7+ candidate.
- **Mono-repo planning awareness.** Carried since Phase 3 retro. Architecture-shaping; deserves its own phase.
- **Programmatic visual regression.** Carried since Phase 3 retro #4.

Defer to v2.5+:

- **Chat / agent mode.** Multi-turn freeform conversation with the run as a side-effect. Paradigm shift.
- **Continuous-interaction UI** (OpenCode-style). Persistent agent-and-user thread.
- **Background mode / unattended runs.** Headless server.
- **PR creation and management; auto-merge after tests pass.**

## Prerequisites

Phase 5 shipped and stable:

- `SubtaskState::Cancelled` (Phase 5 Step 1) + per-subtask cancellation token + `manual_cancel` flag. Step 4's hint flow reuses the cancel mechanism — graceful stop + restart with augmented prompt is exactly the Q&A re-execute path with different copy.
- `resolve_qa_loop` (Phase 5 Step 4) — the universal restart-with-appended-prompt skeleton that Step 4 builds on. The shared restart helper (`restart_with_extra`) is extracted in Step 4 and called by both Q&A re-execute and Hint re-dispatch.
- `forward_logs` (Phase 3) — the worker task's stdout-tee. Step 2 extends this with a parser tee that produces `ToolEvent`s alongside the existing log lines.
- WorkerNode card body layout (Phase 4 Steps 3-4) — Step 2 (activity chips) and Step 3 (thinking panel) both render inline on the card, above the log tail.

Phase 6 introduces no new `SubtaskState` variant. The cost schema (`cost_tally` rows) remains unwired this phase.

## Architecture changes

Smaller surface than originally proposed — three feature surfaces (activity chips, thinking panel, hint injection) plus the diagnostic spike. No cost tracking, no new lifecycle state, no adapter mode swap.

```
Existing (Phase 5)                          Added (Phase 6)
──────────────────                          ──────────────────
Events                                      + run:subtask_activity
                                            + run:subtask_thinking
                                            + run:hint_received

IPC commands                                + hint_subtask(run_id, subtask_id, hint)

Adapter trait                               + parse_tool_event(line) -> Option<ToolEvent>
                                            + parse_thinking(chunk) -> Option<String>

Frontend                                    + ActivityChipStack (Step 2)
                                            + ThinkingPanel (Step 3, opt-in toggle)
                                            + HintInput (Step 4, inline on running cards)
```

## Step-by-step tasks

The numbering follows the revised 5-step structure: Step 0 (diagnostic), Step 2 (activity chips), Step 3 (thinking surface), Step 4 (hint injection), Step 5 (verification). Step 1 is reserved per the existing convention where Step 0 is the diagnostic and the first feature step is Step 2.

---

### Step 0: Tool-use parsing diagnostic

Phase 4 Step 0 surveyed exit shapes; Phase 5 Step 0 surveyed Q&A capability. Phase 6 extends the matrix to the *structured-output* side: what does each adapter emit, in what format, that we can parse into structured activities + thinking blocks?

**Scope (what it does):**

- Survey each adapter (`src-tauri/src/agents/{claude,codex,gemini}.rs`) for:
  1. **Tool-use events.** Claude Code's `--print --output-format json` envelope wraps tool calls; Codex `exec --json` emits JSONL events; Gemini `--output-format text` is plain stdout. Document the exact shapes per adapter.
  2. **Thinking / reasoning blocks.** Claude emits `<thinking>...</thinking>` tags in the result body. Codex / Gemini equivalents (if any).
  3. **Stream protocols + ordering invariants.** When does a tool-use event fire relative to the file write that triggered it? Is there a guaranteed before/after ordering, or are events asynchronous?
- Build a fake-fixture pair under `src-tauri/src/agents/tests/tool_event_fixtures/` — one per adapter shape — that emits scripted tool-use events and asserts the parser handles them.
- Propose a unified `ToolEvent` Rust enum with kebab-case wire variants:
  - `ToolEvent::FileRead { path: PathBuf, lines: Option<(u32, u32)> }`
  - `ToolEvent::FileEdit { path: PathBuf, summary: String }`
  - `ToolEvent::Bash { command: String }`
  - `ToolEvent::Search { query: String, paths: Vec<PathBuf> }`
  - `ToolEvent::Other { kind: String, detail: String }` — escape hatch for unmodeled tools.
- Write `docs/phase-6-toolparsing-diagnostic.md` with the matrix, recommendation, and risk flags (rate of upstream format changes, edge cases like binary files, multi-tool atomicity).

**Scope (what it does NOT):**

- Does not implement the parser in production code — that's Step 2.
- Does not modify any adapter execute path — read-only survey + fake fixtures.
- Does not commit to the unified type; Step 2 may refine based on what the diagnostic surfaces.

**Acceptance criteria:**

- `docs/phase-6-toolparsing-diagnostic.md` exists with: per-adapter format matrix, unified `ToolEvent` proposal, parser implementation strategy, risk assessment.
- Two fake-fixture scripts per adapter (one happy-path, one edge-case) with integration tests asserting their current shape.
- One paragraph of explicit recommendation: "always-on backend parsing + opt-in frontend visibility" vs. alternatives, with rationale tied to overhead measurements (parser CPU cost per stream-line).

**Open questions the spike must answer:**

- Do all three adapters provide *structured* enough output that a single unified parser can serve all three, or does each adapter need its own parser feeding a common `ToolEvent` enum?
- Thinking blocks: are they stable across Claude versions? Are they ever truncated mid-stream? Does parsing cost slow down the log-streaming path?
- Atomic vs streaming tool events: when Claude says `Edit src/auth.ts`, does the user see the edit before or after it lands? Does this affect ordering for the activity chip stack?

**Risk flags:**

- **Format drift.** Upstream CLIs change output formats between versions. Phase 4 Step 1 already flagged Gemini as worker-only because of latency drift; Phase 6's parsing is more brittle. Mitigation: parser must tolerate unknown event shapes (route to `ToolEvent::Other`), never panic.
- **Spike scope creep.** Three adapters × tool events × thinking × ordering = lots to survey. Cap at 2 days per Phase 4/5 Step 0 precedent.

**Estimated complexity:** small (1.5-2 days).

---

### Step 2: Activity chips on worker cards

Render the structured `ToolEvent` stream as inline chips on each worker card during running state. Chips appear next to (not inside) the log tail — log shows raw output, chips show semantic actions.

**Scope (what it does):**

- Backend: extend `forward_logs` (the worker task's stdout-tee) to also pass each line through the Step 0 parser. On a successful parse, emit `RunEvent::SubtaskActivity { run_id, subtask_id, event: ToolEvent, timestamp }` *in addition to* the existing `SubtaskLog`. Both fire — log is still authoritative; activity is a re-projection.
- New event `run:subtask_activity` with the `ToolEvent` payload + monotonic timestamp.
- Frontend: store gains `subtaskActivities: Map<SubtaskId, ToolEvent[]>` capped at the most recent 50 events per subtask (older events drop off — this is a streaming surface, not a log).
- New `ActivityChipStack` component on `WorkerNode` running state. Renders the most recent 3-5 events as horizontal chips above the log tail. Each chip has an icon (file, terminal, search, edit), a 1-line label ("Reading src/auth.ts", "Running pnpm test"), and a fade-in animation.
- Chips compress when the same kind fires repeatedly within a short window: "Reading 4 files in src/" instead of four separate "Reading X" chips.

**Scope (what it does NOT):**

- Does not replace the log tail — chips are additive.
- Does not add per-chip click affordances (e.g., click the file chip to open the file). Phase 7 polish if useful.
- Does not store activities long-term; capped at 50 in-memory per subtask, no SQLite persistence (parallel to log retention policy).

**Acceptance criteria:**

- Running worker card shows chips streaming in as the agent does work. Chip stack caps at 5 visible; older chips fade.
- Compression: 4 successive `FileRead` chips for paths in the same dir collapse to one "Reading 4 files in src/" chip.
- Activity events arrive *after* their corresponding log lines (parser runs as a tee, doesn't block log streaming).
- Memory cap: 50 events per subtask. Integration test floods with 100 events and asserts the store holds 50.
- A11y: each chip has a descriptive `aria-label`.

**Open questions:**

- Chip stack vertical or horizontal? Reference UI: WorktreeActions has horizontal footer; LogBlock has vertical lines. Recommend horizontal stack on the card body, scrolling left as new chips push in.
- Animation: fade-in on new, fade-out on aged-out? Or hard-replace? Recommend fade-in only — too much animation distracts.
- Compression rule complexity: keep simple ("same kind + same parent dir within 2s = compress") to avoid edge-case debugging.

**Risk flags:**

- **Parser overhead per log line.** Worker logs can stream at hundreds of lines per second on chatty agents. The parser must be O(1) per line — regex against a small set, no full JSON parse on every line. Step 0 spike measures.
- **Chip label truncation.** File paths can be long. Truncate at 40 chars with mid-ellipsis (`src/…/auth.ts`).

**Estimated complexity:** medium (2.5-3 days: 1 day backend parser + tee, 1.5-2 days frontend stack + styling).

---

### Step 3: Reasoning / thinking surface

Surface agent thinking blocks (Claude `<thinking>...</thinking>` tags + Codex/Gemini equivalents from Step 0) as a distinct, opt-in panel on each worker card.

**Scope (what it does):**

- Backend: extend the parser to extract thinking content separately from log content. Emit `RunEvent::SubtaskThinking { run_id, subtask_id, chunk, timestamp }` per thinking block.
- Frontend: store gains `subtaskThinking: Map<SubtaskId, string[]>` (chunks in arrival order). Per-card "Show thinking" toggle, default *off* (thinking is verbose; opt-in for users who want depth).
- When toggle is on, a `ThinkingPanel` renders above the log tail in italicized + muted color (visually distinct from log content). Expandable like the Phase 4 Step 3 log expand affordance.
- Toggle state per-worker, not global — different workers can have thinking shown/hidden independently. Persists per-session, not across app restarts.

**Scope (what it does NOT):**

- Does not surface thinking on the master node (master's thinking is the run's plan output; redundant).
- Does not summarize thinking — verbatim or hidden. Summarization could be a Phase 7+ refinement.
- Does not persist thinking to SQLite; in-memory only, capped per-subtask.

**Acceptance criteria:**

- Running worker card has "Show thinking" toggle in footer.
- Toggle on → ThinkingPanel renders above log tail with italicized text, distinct from log lines.
- Per-worker toggle state — toggling worker A doesn't affect worker B.
- Toggle off → ThinkingPanel hides, store still accumulates (so re-enabling shows full backlog).
- Memory cap: configurable; default 500 chunks per subtask.

**Open questions:**

- Should thinking content fold into a worker's outcome surface? No outcome surface in this phase (deferred to Phase 7); keep thinking standalone.
- Default toggle state: per-app preference vs always-off? Recommend always-off — most users won't want it, those who do can toggle. A future Settings panel option lets users invert the default.

**Risk flags:**

- **Verbosity.** Thinking blocks can be 500+ words per call. Even with the toggle off (default), the store accumulates them. Mitigation: cap per subtask at 500 chunks, drop oldest on overflow.
- **Format fragility.** Claude's `<thinking>` tags are stable today but not contractually guaranteed. Step 0 spike documents the exact pattern; parser tolerates absence (no thinking events emitted if format unknown).

**Estimated complexity:** small-to-medium (1.5-2 days: 0.5 day parser extension, 1-1.5 days frontend panel + toggle).

---

### Step 4: Mid-execution hint injection

User can inject a hint to a running worker without cancelling the run. The worker stops gracefully (Phase 5 Step 1's cancel mechanism) and restarts with the hint appended to the prompt.

**Scope (what it does):**

- New IPC command `hint_subtask(run_id, subtask_id, hint)`. Signals graceful cancel + re-dispatches the subtask with `extra_context = original_extra_context + "User hint: <hint>"`.
- Reuses Phase 5 Step 1 cancel infrastructure + Phase 5 Step 4 `resolve_qa_loop`'s re-execute path. Common helper `restart_with_extra(run_id, subtask_id, extra)` extracted from `resolve_qa_loop` in this step and shared between Q&A re-execute and hint re-dispatch.
- New event `run:hint_received { run_id, subtask_id, hint }` emitted after dispatch.
- Frontend: small inline single-line input on each running worker card, placeholder "Add hint…". Submit on Enter → calls `hint_subtask` → button disables, "Worker will restart with your hint" copy appears under the input.
- Critical: this is restart, not pause. Worker loses partial progress. UI surface this explicitly. (Pause-resume is Phase 7 territory.)

**Scope (what it does NOT):**

- Does not pause the worker (Phase 7 pilot).
- Does not allow multiple in-flight hints — second hint while first is still being processed rejects with `WrongSubtaskState`.
- Does not surface hint history per worker beyond the most-recent. No per-worker hint log.

**Acceptance criteria:**

- Running worker card has "Add hint…" inline input.
- Type + Enter → cancel signal fires → worker stops within the Phase 5 Step 1 latency budget (~2s) → re-dispatch with hint appended.
- Worker re-enters Running state, log resumes.
- Hint is visible on the card briefly post-submit; dismisses when worker reaches Running again.
- Stop-during-hint: clicking Stop after submitting a hint cancels the in-flight hint dispatch (treats as plain manual cancel).

**Open questions:**

- Q4 (architectural): Hint vs Q&A semantic distinction. Q&A is worker-initiated (worker asks); Hint is user-initiated (user nudges). Recommend separate events but shared restart code path. See Architectural questions section.
- UI placement: inline input vs button-opens-modal? Recommend inline input — frequency justifies always-visible. But consumes vertical space; reuse the question input slot when in awaiting_input.
- Multi-line hints: single-line for simplicity. Phase 7 expands to textarea if user complaints.

**Risk flags:**

- **Cancel-and-restart latency.** 2s + worker startup time. UX impact: user sees the worker grind to a halt before the new prompt kicks in. Mitigation: clear UI feedback ("Stopping current attempt… Restarting with your hint…") with progress states.
- **Hint loops.** User keeps adding hints. Each restart loses progress. Bound is informational — UI shows "3 hints applied this session" so user notices the pattern.

**Estimated complexity:** medium (2-2.5 days: 0.5 day IPC + restart helper extraction, 0.5 day frontend input + states, 1 day cross-step integration with Phase 5 cancel + Q&A paths, 0.5 day tests).

---

### Step 5: Verification + retrospective + close-out — SHIPPED 2026-04-27

Same shape as Phase 4 Step 7 / Phase 5 Step 5 — manual verification on real repo, integration tests verified, visual observations, retrospective, KNOWN_ISSUES + CLAUDE.md sync.

**Scope:**

- Manual verification pass exercising every shipped surface: activity chips during a real run, thinking toggle, hint injection mid-execution.
- Integration test additions:
  - Activity chip stack capacity (50 events per subtask, oldest dropped on overflow)
  - Thinking toggle persistence per subtask
  - Hint injection cancel-and-restart full flow
  - `restart_with_extra` shared helper exercised by both Q&A re-execute and Hint re-dispatch
- Visual observations under `docs/retrospectives/phase-6-visuals/` (3-4 text observations — fewer than Phase 5 since fewer feature surfaces).
- Goal-backward `docs/phase-6-verification.md` with PASS/FAIL per success criterion.
- Retrospective per Phase 4/5 template.
- KNOWN_ISSUES updates (Resolved in Phase 6 + retargets, including the new "Phase 7 cost-aware feature suite" cluster covering the deferred outcome summaries / diff explanations / cost dashboard / pause-resume pilot).
- CLAUDE.md status update.

**Acceptance criteria:**

- All step-level acceptance from Steps 0, 2, 3, 4 PASS.
- Frontend tests green (target: +25 over Phase 5's 705 = 730).
- Rust tests green (target: +10 over Phase 5's 360 = 370).
- `tsc --noEmit`, `eslint`, `cargo clippy -- -D warnings` clean.
- CI green on every PR.

**Estimated complexity:** small-to-medium (1-1.5 days: 0.5-1 day manual + integration tests, 0.5 day docs).

---

## Estimated total complexity

| Step | Complexity | Days |
|---|---|---|
| 0 — Tool-use parsing diagnostic | small | 1.5-2 |
| 2 — Activity chips on cards | medium | 2.5-3 |
| 3 — Reasoning / thinking surface | small-medium | 1.5-2 |
| 4 — Mid-execution hint injection | medium | 2-2.5 |
| 5 — Verification | small-medium | 1-1.5 |
| **Total** | | **~9-10 days** |

Comfortably within the 8-10 day spec budget. Realistic floor (Phase 5 evidence): 3-5 active working days.

## Architectural questions addressed

**Q1: Tool-use parsing — opt-in or always-on?**

**Recommendation: always-on at backend, opt-in at frontend visibility.** The parser runs as a tee on `forward_logs` (Step 2), so it costs only the regex overhead per log line — bounded. The frontend renders activity chips by default (visible, builds the partnership feel) but the thinking panel (Step 3) is opt-in (verbose). This balances the cost-of-not-having-it (chips are core to the theme) with the cost-of-defaulting-noisy (thinking).

**Q2: Cost tracking integration scope.**

**Deferred to Phase 7.** Phase 6 ships zero LLM-cost user-action surfaces (outcome summaries, diff explanations, and pause-resume all moved to Phase 7). The cost schema (Phase 2 cost tables, unused since) remains unwired this phase. Phase 7 will introduce the cost-aware feature suite with proper per-call cost preview, cumulative session tally, undo affordance, and optional budget cap — shipping cost-aware features as a coherent set rather than piecemeal.

**Q3: Pause/resume state design.**

**Deferred to Phase 7.** Phase 6 introduces no new `SubtaskState` variant. Hint injection (Step 4) reuses Phase 5's `Cancelled` + restart-with-`extra_context` helper. The `Paused` state design remains the right answer for the pause-resume pilot when it's revisited in Phase 7, but that decision should follow Phase 7's own diagnostic step covering interactive-mode swap, tool-event format stability, and feature-flag rollout cost.

**Q4: Hint vs Q&A distinction.**

**Recommendation: separate events but shared restart code path.** Q&A's `subtask_question_asked` + `answer_subtask_question` IPC remain as Phase 5 contract. Hint introduces `subtask_hint_received` event + `hint_subtask` IPC. Both invoke the same `restart_with_extra(run_id, subtask_id, extra)` helper internally — the restart mechanism is identical, but the user-facing semantics are distinct. Refactor: extract `restart_with_extra` from Phase 5 Step 4's `resolve_qa_loop` re-execute branch in Phase 6 Step 4, then both Q&A re-execute and Hint re-dispatch call it.

## Post-phase deliverables

- `docs/phase-6-spec.md` (this file) closed with a "Shipped" note.
- `docs/phase-6-toolparsing-diagnostic.md` (Step 0 output).
- `docs/phase-6-verification.md` (goal-backward PASS/FAIL).
- `docs/retrospectives/phase-6.md` (timing + bug clusters + lessons for Phase 7).
- `docs/retrospectives/phase-6-visuals/` (3-4 text visual observations).
- `docs/KNOWN_ISSUES.md` updated. New entries: "Phase 7 cost-aware feature suite" cluster covering deferred outcome summaries, diff explanations, cost dashboard, and Claude pause-resume pilot.
- `CLAUDE.md` updated.
- Phase 7 spec kickoff brief — written after Phase 6 ships and real-usage data lands. Phase 7's likely scope: cost-aware AI augmentation features (per-worker outcome summaries, diff content explanations, Claude pause-resume pilot, cost dashboard foundation), plus existing candidates (multi-agent comparison, mono-repo planning awareness, programmatic visual regression).
