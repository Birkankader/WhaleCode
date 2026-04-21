# Phase 3 spec review — written after Phase 2 closeout

**What this is:** notes from a re-read of `docs/phase-3-spec.md` with Phase 2's shipped code and retro in hand. Every item is a concern or open question about the spec *as written* — not a rewrite. Edits to `phase-3-spec.md` belong in a follow-up change, after Phase 3 kickoff discussion.

**Scope:** spec drift where reality already diverged, design assumptions that Phase 2 experience contradicts, and mechanism gaps that will block Phase 3 step 1 if not resolved first.

Each entry follows: **concern / proposed change / rationale** + any open questions.

---

## Section: Step 1 — `approve_subtasks` signature drift

**Concern.** Spec says:
```rust
async fn approve_subtasks(run_id: RunId, subtasks: Vec<SubtaskFinalized>) -> Result<(), String>
```
Phase 2 shipped with:
```rust
async fn approve_subtasks(run_id: RunId, subtask_ids: Vec<SubtaskId>) -> Result<(), String>
```
(see `src-tauri/src/ipc/commands.rs` and `src/lib/ipc.ts`).

The spec assumes a clean rewrite. In reality, subtask data already round-trips through `run:subtasks_proposed` — the backend knows the subtasks. What the backend does *not* know is which of them were edited by the user.

**Proposed change.** Keep `subtask_ids: Vec<SubtaskId>` as the approval set. Add a sibling command `update_subtask(run_id, subtask_id, patch: SubtaskPatch) -> Result<(), String>` that the UI calls for each edit before `approve_subtasks`. Backend applies patches to the in-memory `SubtaskRuntime` and persists before workers dispatch.

**Rationale.** Two IPC calls instead of one, but:
- Edits become per-field and incremental (matches the inline-edit UX).
- Backend owns the canonical subtask state; frontend doesn't carry a divergent "finalized" shape.
- Reject-then-re-edit doesn't require resending the whole plan.
- `addSubtask` / `removeSubtask` become their own small commands rather than being baked into the approve payload.

**Open question.** Does the backend want to see a flag on each patch (`edited_by_user: true`) or is "any patch landed before approve" sufficient signal for the re-plan prompt?

---

## Section: Step 2 — inline edit UI inside a React Flow node

**Concern.** Phase 2's Step 11 surfaced framer-motion × React Flow pointer-event bugs (commits `c0ea00f`, `5d337a2`). Inline `<input>` inside a custom WorkerNode is exactly the surface area that gets hit:
- React Flow intercepts pointer events on the node wrapper.
- Keyboard events may not reach a nested input because React Flow's default handlers eat them.
- Dev mode and production behave differently for animated transitions.

Spec says "click title → inline input" as if this is a normal DOM interaction.

**Proposed change.** Before any inline-edit work, add a step 2a to the spec:
1. Write a reproducing test case for: focused input inside a React Flow node, typing characters, arrow keys, Escape, Tab.
2. Document which handlers need `.stopPropagation()` and which need `nodrag` class hints from React Flow.
3. Verify against a `pnpm tauri build` binary, not just `pnpm dev`.

**Rationale.** Phase 2's lesson #5: dev-mode animations and React Flow layering produce visual state that doesn't match production. Inline editing is the tightest integration point — we learn the constraints now, or we eat them during Step 11 verification.

**Open question.** Is it worth lifting edit mode out of the node entirely — e.g. pop an inline-positioned overlay anchored to the node — so the editor never lives inside React Flow's event surface?

---

## Section: Step 3 — worker retry and the `MAX_RETRIES = 0 → 1` flip

**Concern.** The spec describes Layer 1 retry purely as an orchestrator change: add `execute_with_retry` in Rust, emit a `retrying` state. But the frontend XState machine (`src/state/nodeMachine.ts`) has `MAX_RETRIES = 0` baked in, and `graphStore.ts` has explicit comments acknowledging this:

```ts
// MAX_RETRIES = 0 so `running --FAIL→ failed` directly.
```

So the work is actually:
1. Flip `MAX_RETRIES` to 1 in the machine.
2. Re-enable the `running → retrying → running` path (currently disabled because MAX_RETRIES=0).
3. Make sure `eventsForSubtaskState` in `graphStore.ts` bridges backend `retrying` into the machine cleanly.
4. Add the orchestrator Rust logic.

Spec only covers (4).

**Proposed change.** Expand Step 3 into three sub-steps (3a machine, 3b store bridge, 3c orchestrator) with explicit acceptance criteria for each.

**Rationale.** Phase 2 Step 11 bug #2 (FinalNode didn't activate on DiffReady) came from exactly this class of gap: backend emitted an event that the frontend machine wasn't wired to consume. Three distinct call sites need updating; splitting the step makes the wiring auditable.

**Open question.** Should `retrying` get its own `run:` event, or just piggyback on `run:subtask_state_changed { state: 'retrying' }`? Spec mentions both forms inconsistently. My vote: the existing `subtask_state_changed` is enough — adding a `SubtaskState::Retrying` variant is a one-line migration.

---

## Section: Step 3 — agent trait extension shape

**Concern.** Spec: "Add `execute_with_extra_context` method or a parameter to existing `execute`." Either choice has consequences the spec doesn't confront:

- **New method.** All three adapters (`claude.rs`, `codex.rs`, `gemini.rs`) grow a second method that 90% duplicates `execute`. Two code paths means two places for bugs to hide.
- **New parameter.** Changes `AgentImpl::execute` signature, which ripples into `ScriptedAgent` (fake fixture), every integration test, and the dispatcher.

**Proposed change.** Extend the existing `execute` signature:
```rust
async fn execute(
    &self,
    subtask: &Subtask,
    worktree_path: &Path,
    shared_notes: &str,
    extra_context: Option<&str>,   // NEW
    log_tx: mpsc::Sender<String>,
    cancel: CancellationToken,
) -> Result<ExecutionResult, AgentError>;
```
Adapters render `extra_context` into the prompt when `Some`, otherwise proceed as today.

**Rationale.** Single entry point keeps the adapter implementations thin. The test fixture can verify "when `extra_context` is `Some`, it appears in the prompt text" once, and the three real adapters inherit correctness from prompt rendering tests.

**Open question.** Is `&str` sufficient, or do we want a richer `RetryContext { previous_error, attempt_number, previous_logs_tail }` struct? Structured context is easier to template into prompts but requires thinking now about what information actually helps the agent — worth a short discussion before Step 3 starts.

---

## Section: Step 3 — AgentError taxonomy vs uniform retry

**Concern.** Phase 2 ships six `AgentError` variants:
```
ProcessCrashed | TaskFailed | ParseFailed | Timeout | Cancelled | SpawnFailed
```
Spec Step 3 treats "worker failure" as one bucket: any failure → retry once → escalate.

Some of these don't deserve a retry:
- `SpawnFailed` — CLI binary gone. Retrying will fail identically. Should go straight to Layer 3 ("install the agent").
- `Cancelled` — user cancelled. Retrying violates their intent.
- `ParseFailed` — the plan came back unparseable. Retrying the same prompt usually doesn't help; this wants a *re-plan* with stricter format instructions, not a worker retry.
- `TaskFailed` (agent refused) — retrying the same prompt is unlikely to change the refusal. Re-plan territory.

Only `ProcessCrashed` and `Timeout` clearly benefit from a silent Layer 1 retry.

**Proposed change.** Add a `retry_policy(&self, err: &AgentError) -> RetryDecision` helper on the orchestrator (or free function in `orchestration/retry.rs`) that returns `RetryWorker | EscalateToMaster | EscalateToHuman` per variant. Make the policy explicit in the spec so the adapters don't have to second-guess.

**Rationale.** Uniform retry on six-variant error types is the retry-ladder equivalent of catching bare `Exception`. The taxonomy is already there; spec should use it.

**Open question.** Is `Cancelled` ever going to reach `execute_subtask_with_retry`? Cancellation should short-circuit the dispatcher. Worth confirming in Phase 3 kickoff.

---

## Section: Step 4 — `edited_by_user` persistence through re-planning

**Concern.** Spec pitfall: "Edited subtasks must persist through re-planning." But:
- Phase 2's `storage/models.rs::Subtask` has no `edited_by_user` column.
- SQLite migrations are append-only; adding a column requires a migration.
- The re-plan prompt needs to *read* this flag from persisted state (master may be called after a crash-recovery gap).

Spec doesn't call out the schema migration.

**Proposed change.** Add explicit Step 4a (schema migration) before the orchestrator logic:
1. New migration: `ALTER TABLE subtasks ADD COLUMN edited_by_user INTEGER NOT NULL DEFAULT 0;`
2. New migration: `ALTER TABLE subtasks ADD COLUMN replan_count INTEGER NOT NULL DEFAULT 0;`
3. New migration: `ALTER TABLE subtasks ADD COLUMN replan_reason TEXT;`
4. Update `storage::models::Subtask` and query bindings.

**Rationale.** Phase 2 Step 8 debugged one migration bug that could have been caught by listing schema changes up front. Phase 3 has three columns at minimum; list them in the spec.

**Open question.** Should `edited_by_user` persist as a boolean, or as a `JSON` blob of the actual diff-from-original (for more nuanced re-plan prompts)? Latter is richer but adds storage complexity.

---

## Section: Step 5 — "Manual fix" editor detection

**Concern.** Spec says: "Worker's worktree path is opened in their configured editor (detected from `$EDITOR` env var or settings)."

Tauri app context: `$EDITOR` is frequently unset because the app is launched from a GUI, not a shell. Spec pitfall acknowledges this ("Don't hardcode `code`. Respect `$EDITOR`, then fall back to platform defaults") but doesn't resolve it.

**Proposed change.** Explicit fallback chain in spec:
1. `settings.editor` (user-set, persisted)
2. `$EDITOR` env var
3. Platform default via `open -a` (macOS) / `xdg-open` (Linux) / `Start-Process` (Windows)
4. Last resort: show path in a "copy to clipboard" dialog and let the user open it themselves

Also: this is a Phase 2 architectural-debt item — Phase 2 already has `tauri-plugin-opener` available. Phase 3 likely wants `tauri-plugin-shell` for the command-style launch; add it to the spec's dependency list.

**Rationale.** Editor detection is a solved problem in the ecosystem but a nasty surprise when skipped — and because it only breaks on user machines with unusual shells, it's a class of bug that escapes Step 11 verification.

**Open question.** Do we want a "don't open an editor; just reveal in Finder/Explorer" option as a safe default for users without a configured editor?

---

## Section: Step 6 — master re-plan "one more attempt" button

**Concern.** Spec says if master fails during re-planning, "Layer 3 offered directly... plus 'try replan again' as a fourth option (one more attempt allowed)."

Loop protection: "Max 2 re-plans per original subtask."

These interact: does "try replan again" count against the cap? If a single failed subtask has already had 2 re-plans, and the user clicks "try replan again," what happens?

**Proposed change.** Clarify: the per-subtask `replan_count` cap is hard and only advances on *successful* plan output. Master-failed-to-produce-a-plan is distinct: the frontend-side "try replan again" button calls master one more time, capped at 1 retry per re-plan attempt (not per subtask). If master fails again: Layer 3 without that button.

**Rationale.** Without clarity here, a pathological case (API flakiness on re-plan) can eat the cap without making progress.

**Open question.** Does master's failure-to-plan deserve its own `AgentError::PlanningFailed` variant, or is `ParseFailed` enough? Phase 2 currently lumps them.

---

## Section: Step 7 — auto-approve first-activation warning modal

**Concern.** `CLAUDE.md` rule: "Do not use modals for approval. Use the sticky bottom bar." Phase 3 Step 7 says: "First activation shows warning modal per docs/architecture.md section 7."

Edge case: is the first-activation warning an *approval* modal, or a *mode toggle* modal? The rule was written about subtask approvals; a one-time settings confirmation is a different category. But the spec doesn't draw that line.

**Proposed change.** Either:
- Reword the spec to "first-activation warning popover/panel" (not modal), explicitly keeping the CLAUDE.md rule.
- Or add a note in CLAUDE.md clarifying that settings-confirmation modals are permitted, approval modals are not.

**Rationale.** Small thing, but the kind of rule ambiguity that causes drift. Resolve before Step 7.

**Open question.** Is there a design-system pattern for "settings confirmation" already in use, or will Step 7 need to invent one?

---

## Section: Step 8 — new RunStatus / SubtaskState variants

**Concern.** Spec introduces states without calling out the enum migrations:
- Run: `escalating` (Layer 2), `human_escalation` (Layer 3) — currently `RunStatus` is 8 variants in `src-tauri/src/ipc/mod.rs`.
- Subtask: `retrying` (from Step 3), `escalating`, `human_escalation`.

Each new variant is touched by:
- `RunStatus` / `SubtaskState` Rust enum (+ `Display`, `FromStr`)
- zod schema in `src/lib/ipc.ts` (`runStatusSchema`, `subtaskStateSchema`)
- `mapRunStatus` in `graphStore.ts`
- `eventsForSubtaskState` bridge
- XState machine state graph
- SQLite column values (strings persisted in `runs.status`, `subtasks.state`)
- Any test that asserts over the enum

**Proposed change.** Add a Step 0 (before Step 1) to the spec: "Enum migration list." Enumerate every new variant, every call site, every test. Treat it as the acceptance criterion "enums are synchronized" before any feature work begins.

**Rationale.** Phase 2 Step 11 bug cluster #5 was "an event had nowhere to go." Adding four enum variants across two languages and a persistence layer is exactly the shape that produces that class of bug. Enumerate up front.

**Open question.** Worth considering a code-gen step (tauri-specta or a hand-rolled codegen) to keep the Rust ↔ TS contract in lockstep? Was deferred in Phase 2 for being too much ceremony; Phase 3 adds enough surface to revisit.

---

## Section: Testing — the ScriptedAgent problem

**Concern.** Retrospective bug #1 (`8f4fe97`): Phase 2's `ScriptedAgent` fake committed its own edits, which masked the "who commits?" production bug. The spec's proposed tests for Layers 1–3:

> - Fake adapter that fails once then succeeds: verify retry triggers, final state is `done`
> - Fake adapter that fails twice: verify escalation triggers

...will only catch bugs that happen inside the orchestrator. If ScriptedAgent is still the only fake, the integration tests will be as generous as Phase 2's — and Layer 3's "manual fix" flow will ship with the same class of hidden bug.

**Proposed change.** Step 0.5 (new): extend the test fixture to support:
- Fail on attempt N (parameterized)
- Emit specific `AgentError` variants
- Leave uncommitted changes in the worktree (to exercise "did someone commit?" code paths)
- Optionally refuse to honor cancellation (to stress Layer 3)

**Rationale.** Retrospective lesson #1. The cost is small; the payoff is every test after Step 0.5 being more honest.

**Open question.** Do we also want a "chaos" fake that injects random failures at deterministic seeds? Useful for stress testing the ladder; overkill for Phase 3 alone.

---

## Section: `ReplanApprovalBar` vs `ApprovalBar`

**Concern.** Spec file list:
```
src/components/approval/
  ├── ApprovalBar.tsx (extended: "+ Add subtask")
  └── ReplanApprovalBar.tsx (new variant for re-plan approvals)
```

Phase 2's ApprovalBar is ~100 lines, tightly coupled to the approval-bar state (Approve / Reject all / selection count). Two near-identical components risk divergence.

**Proposed change.** One `ApprovalBar` component with a `variant: 'initial' | 'replan'` prop that swaps:
- Title text
- Approve button label ("Approve all 3" vs "Approve re-plan")
- Reject behavior (reject-run vs reject-replan — reject-replan should not kill the run)

**Rationale.** Phase 2 has exactly one bottom bar; adding a second risks z-index / mount-order bugs. A single component with two variants keeps the rendering discipline consistent.

**Open question.** Does rejecting a re-plan send the failed subtask to Layer 3 (user decides manually) or back to Layer 2 (re-plan again)? Spec is silent.

---

## Cross-cutting open questions

1. **Cost ceiling per run.** Loop protection at `replan_count = 2` allows up to `1 + 2*2 = 5` agent calls per subtask plus 2 re-plan calls. A 5-subtask plan × cascading failures could make 35+ agent calls. Phase 6 will add cost tracking — should Phase 3 ship with a hard numeric ceiling (e.g. "no more than 50 agent calls per run without user re-confirmation") as a placeholder?

2. **`replan_count` visibility.** Spec says "user should be able to see 'this subtask has been re-planned twice already' if they look at the failed node." The design system doesn't have an obvious place for this. Worth a small UX sketch before Step 4.

3. **Crash recovery interaction with Layer 3.** If the app crashes while a subtask is in `human_escalation`, the current Phase 2 recovery marks the whole run `Failed`. Arguably the user should see "you were mid-decision" instead. This is a v2.5 "resume" item per KNOWN_ISSUES, but Phase 3 should at least document the intended behavior.

4. **Does "Skip subtask" count as user consent to run without it?** If subtask A was skipped and subtask B depends on A, does B run, fail, or also skip? Spec doesn't say.

5. **Auto-approve + Layer 3 interaction.** Auto-approve doesn't bypass Layer 3. But what if the user is away? The run sits indefinitely in `human_escalation`. Worth defining a "auto-abort after N hours of no user input" behavior now so Phase 7's safety gates have a shape to fit into.

---

## Summary

The spec is directionally right and the three-layer retry ladder is the correct design. The concerns above are almost all of the form "Phase 2 shipped something the spec assumed was freshly writable" (approve signature, enum variants, schema shape) or "Phase 2 learned something the spec hasn't absorbed yet" (ScriptedAgent generosity, React Flow pointer events, dev vs production).

Before Step 1 starts, I'd want decisions on:
1. The approve/update command split (Section: Step 1)
2. The AgentError → RetryDecision policy (Section: Step 3)
3. The enum migration list (Section: Step 8)
4. The ScriptedAgent extension (Section: Testing)

Everything else can be resolved during its own step, but these four are cross-cutting enough that a pre-Step-1 design call saves a later Step 11 fire drill.
