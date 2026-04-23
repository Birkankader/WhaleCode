# Phase 5: Unblock the run

> **Phase 5 shipped 2026-04-23** at `1976b94 feat(phase-5): step 4 — interactive agent Q&A` (code) + close-out commit (docs). See `docs/phase-5-verification.md` for goal-backward pass/fail and `docs/retrospectives/phase-5.md` for the retrospective.

**Goal:** When a run gets stuck, give the user a way out that doesn't require killing the whole run. Merge conflicts, dirty base branches, worker agents asking questions, and workers grinding on the wrong problem are today's four dead-ends: each forces the user to Discard and start over, or to reach outside the app to fix it. Phase 5 ships the resolution paths for all four — *inside* the graph, without schema rewrites or a headless-mode detour.

**Duration estimate:** 2 weeks (with a realistic read of 3-5 active working days based on Phase 3 / 3.5 / 4 evidence — prior three phases all came in at 2-3 days actual against 2-week estimates; padding here is for Q&A spike risk).

**Theme:** *Unblock the run.* Phase 4 made the run *legible* — users can see what happened. Phase 5 makes the run *recoverable* — when a worker crashes into a wall (conflict / dirty tree / question / wrong direction), the user resolves it in-canvas and the run continues. Each scope item is a specific "stuck" shape already visible in today's UI with no exit other than full Discard.

**Success criteria:**

- A worker stuck on the wrong approach can be stopped individually without cancelling the run or triggering Layer-2 replan. The stopped worker enters `cancelled` (terminal, user-initiated); the run continues with remaining subtasks and can still reach Apply.
- On `BaseBranchDirty`, the user can click "Stash & retry apply" from the error banner. The backend runs `git stash push -u -m "whalecode: before apply"`, retries the merge, and on success re-applies. A dismissible post-apply prompt offers to pop the stash back.
- On `MergeConflict`, the user can choose "Open resolver" from the error banner. The resolver surfaces the conflicted files, exposes each worktree's version, and provides Reveal-in-Finder / Open-terminal affordances plus a "Retry apply" button that re-enters the merge oneshot after the user resolves externally. No in-app merge editor — we ship the workflow, not the text UI.
- A worker agent that asks a question ("which option should I proceed with?") pauses in a new `awaiting-input` state, surfaces the question on its card, and accepts a typed answer that resumes the worker with the answer injected into its input stream. Agents that don't support mid-run stdin (Gemini single-shot, Codex `-p`) emit a synthetic question-detection event from stdout + exit, and the user's answer restarts the subtask with the answer concatenated to the original prompt. Either path delivers a working "answer and continue" loop.
- Stopping a worker while Layer-2 replan is already in flight fails gracefully (clear error toast, no double-state). Answering a Q&A worker after run-cancel is a no-op. Retrying apply after a stale conflict (worker state drifted) falls through to the existing `WrongState` error surface. No new dead-ends introduced by the new resolution paths.

## Why this matters

Phase 4's verification pass and the Phase 3 retrospective already named these four dead-ends with a combined six flags in `KNOWN_ISSUES.md`:

- Merge conflict resolution UX (`functional`, Phase 5 target, since Phase 2).
- Base-branch dirty guard is all-or-nothing (`functional`, Phase 5 target, since `a024551` + `785947e`).
- Interactive agent Q&A not supported (`functional`, Phase 5 target, observed Phase 3 Step 9 with worker-completed-as-Done-with-question).
- No per-worker stop — cancel is run-wide (`functional`, implicit in Phase 3 Layer 2 replan design — see `docs/phase-3-spec.md` Step 5 "subtask cancel").

Phase 4's own verification (`docs/phase-4-verification.md`) noted three of its own acceptance criteria pass on visibility while leaving the resolution path silent — ErrorBanner honestly reports "merge conflict" but the only action is Discard. The overlay shows Apply succeeded, but Apply itself refuses if the base is dirty. The WorktreeActions menu exposes the path but doesn't help a user resume.

The common shape of all four: **the run wants to keep going, the user has the information to unstick it, but the path between "I know what to do" and "the run continues" exits the app.** Phase 5 closes the loop.

## What this phase does NOT include

Defer to Phase 6+:

- **Mono-repo planning awareness.** Carried from Phase 3 retro, surfaced again in Phase 4 KNOWN_ISSUES, still not Phase 5. Dependency-graph-aware master prompting is its own research question; the four "unblock" items have higher pain density. **Target:** Phase 6 (alongside cost tracking — both are planning-adjacent).
- **Rate-limit classification + exponential backoff.** KNOWN_ISSUES entry; surfaces cleanly in Phase 4 Step 0's diagnostic as Category B. Needs per-adapter backoff policy + token bucket — too adjacent to agent-adapter architecture to bolt into Phase 5's Q&A work. **Target:** Phase 6 or later; write the fix when a real user reports mis-classification.
- **In-app merge editor.** Phase 5 ships the conflict *workflow* (identify, reveal, retry) but not a 3-way merge UI. Users resolve in their own editor. A Monaco-style inline merger is Phase 7+ if ever.
- **Chat mode / multi-turn agent conversation.** Phase 5's Q&A is single question → single answer → resume. Not a back-and-forth chat. Agents that want to ask a second question trigger a second `awaiting-input` state; each Q is a discrete round-trip.
- **Multi-agent comparison / fan-out within a subtask.** Each subtask runs one agent; Q&A targets that one agent. Multi-agent consensus is a v3 concern.
- **In-progress visibility for what a stopped worker was doing.** Stopped workers show their collected log (same as pre-Phase-5 cancelled workers); no mid-stream snapshot of scratch files.
- **Partial run recovery / resume-on-crash.** Still cleanup-only (KNOWN_ISSUES, v2.5). Phase 5 ships user-initiated unblocking, not orchestrator-initiated recovery.
- **Cost tracking.** Phase 6. Same tables, still unwired.
- **Safety gates.** Phase 7. `is_action_safe` still returns `true`.
- **Gemini-as-master latency fix.** Phase 4 subtracted Gemini from the master picker; the upstream latency fix is still open. Phase 5 does not revisit — the capability gap is honest today.
- **Windows cancel cleanup.** v2.5. Per-worker stop (Step 1) inherits the same Unix-only process-group-kill semantics; Windows direct-child kill continues to work, grandchildren still orphan.

## Prerequisites

Phase 4 shipped and stable:

- `errorCategory` discriminant on `subtask_state_changed` (Phase 4 Step 5). Per-worker-stop emits `errorCategory: null` because cancelled is not failed; Q&A uses a new `awaiting-input` state not a failed variant.
- `ApplySummaryOverlay` + `DiffPopover` (Phase 4 Steps 2, 6). Retry-apply after a stashed / resolved conflict re-uses the same ordering invariant: `DiffReady → Completed → StatusChanged(Done) → ApplySummary`.
- `WorktreeActions` menu (Phase 4 Step 4). The conflict resolver (Step 3 below) extends this menu rather than building a parallel surface; same portal-to-document.body pattern for popover stacking-context.
- Retry ladder (Layer 1 / Layer 2 / Layer 3) — unchanged. Per-worker-stop (Step 1) explicitly bypasses the ladder so manual cancel doesn't trigger replan; Q&A answer (Step 4) restarts the worker without counting against Layer 1 budget.
- `AgentKind::supports_master()` + fallback chain (Phase 4 Step 1). Q&A capability probe (Step 0) uses the same per-adapter capability pattern.

## Architecture changes

Phase 5 is the first phase since Phase 3 that adds meaningful backend surface — mostly new IPC commands plus one new `SubtaskState` variant for Q&A. No SQLite migration (the new state persists the same way `Retrying` does — in memory on the run row, never written back). No XState machine rewrite — new state added, transitions wired.

```
Existing (Phase 4)                         Added (Phase 5)
──────────────────                         ──────────────────
SubtaskState enum                          + AwaitingInput    (Step 4 only)
                                             Per-instance, transient, not
                                             persisted; gates dispatch +
                                             cancel.

Events                                     + run:subtask_question_asked
                                           + run:subtask_answer_received
                                           + run:stash_created (+ popped)
                                           + run:merge_retry_failed
                                             (reuses MergeConflict payload
                                             shape; distinguished by a
                                             `retry_attempt: u32` field)

IPC commands                               + cancel_subtask(run_id, subtask_id)
                                           + answer_subtask_question(run_id, subtask_id, text)
                                           + stash_and_retry_apply(run_id)
                                           + pop_stash(run_id)
                                           + retry_apply(run_id)   [new name for
                                             reuse of apply_run post-conflict;
                                             backend is the same oneshot]

Master/worker adapters                     + capability probe:
                                             AgentKind::supports_stdin_injection()
                                             Claude/Codex interactive: true
                                             Codex -p / Gemini single-shot: false
                                           + question-detection layer (Step 0
                                             spike informs shape)

Frontend                                   + QuestionInput on worker card
                                             (input + "Send" + "Cancel worker")
                                           + ConflictResolverPopover (reuses
                                             Phase 4 WorktreeActions portal
                                             pattern)
                                           + ErrorBanner action variants:
                                             "Stash & retry" on BaseBranchDirty
                                             "Open resolver" on MergeConflict
                                             "Retry apply" on resolver
```

The biggest architectural question is whether Q&A should be a new `SubtaskState::AwaitingInput` or a discriminant field on `Running` (the Phase 4 Step 5 "event-field branch" pattern). This spec recommends state (rationale in Step 4's Open questions) — but Step 0 is where that decision gets confirmed against real adapter behavior.

## Step-by-step tasks

The ordering stacks smallest-to-largest, and front-loads the Q&A capability spike because its findings may reshape Step 4. Steps 1-3 are backend-shallow + UI additive. Step 4 is the phase's heavy hitter. Step 5 closes.

---

### Step 0: Q&A capability spike (diagnostic)

Before we decide whether Q&A needs a new `SubtaskState`, a new event, or a new adapter trait, we need to know what the three adapters can *do* when a worker wants to ask a question mid-run. The Phase 4 Step 0 diagnostic paid for itself by shrinking Step 5's scope from a full state-machine rewrite to a one-field wire extension; this spike aims for the same leverage.

**Scope (what it does):**

- For each adapter (`src-tauri/src/agents/{claude,codex,gemini}.rs`), survey:
  1. Does the CLI emit a question-like signal on stdout before exiting? (Claude Code's interactive mode does; Codex `-p` may on certain prompts; Gemini single-shot does not — it returns whatever it has and exits.)
  2. Does the CLI accept stdin injection after spawn? (Claude interactive: yes, via open stdin pipe. Codex `-p`: no, prompt is an argv flag, stdin is not read post-spawn. Gemini: same as Codex.)
  3. If the CLI exits with a question in its last stdout block, is the exit code distinguishable from a normal completion? (Likely not — this is the Phase 3 observed bug where a Q-asking worker completes as `Done` with the question in its log.)
- Build a taxonomy matrix: adapter × (question-signal-available, stdin-injection-possible, exit-distinguishable). Populate each cell from CLI documentation + a quick fake-agent fixture that makes the CLI pause on a question.
- Prototype two fake-agent fixtures under `src-tauri/src/agents/tests/question_fixtures/`:
  - `fake_asks_question_then_waits.sh` — writes a question to stdout, blocks on stdin, writes an answer-acknowledgement on read. Simulates Claude interactive.
  - `fake_asks_question_then_exits.sh` — writes a question to stdout with an exit code 0, does not read stdin. Simulates Codex / Gemini single-shot.
- Write a short report (`docs/phase-5-qa-diagnostic.md`) naming, per adapter: (a) the recommended detection signal, (b) the recommended response path (stdin-inject vs restart-with-appended-prompt), (c) the cost of a false positive (detecting a question that wasn't really one).

**Scope (what it does NOT):**

- Does not implement question detection or answer injection — that's Step 4.
- Does not change any adapter production code. Read-only survey + fake-agent fixtures.
- Does not spec the UI — the diagnostic informs Step 4's Open questions, which informs the UI in the planner doc.

**Acceptance criteria:**

- `docs/phase-5-qa-diagnostic.md` exists with: three-adapter matrix, per-adapter recommendation, risk flags (false-positive rate, "what if the worker asks two questions before we can inject the first answer"), and one recommended path for Step 4.
- Two fake-agent fixture scripts in `src-tauri/src/agents/tests/question_fixtures/` with integration tests that exercise each path's *current* behavior (which will fail Step 4 acceptance by design — this is the baseline).
- One paragraph of explicit recommendation: "Q&A should be a new `SubtaskState::AwaitingInput`" or "Q&A should be a discriminant field on `Running`" — with the rationale tied back to the diagnostic findings.

**Open questions the spike must answer:**

- Do any adapters emit a structured question signal (JSON field, stderr prefix, etc.) we can trigger on, or is every detection heuristic?
- For the non-stdin-injection adapters, how painful is "restart with appended prompt" — does the adapter produce different (worse? better?) output on re-run, or roughly stable output?
- If the user walks away without answering, how long do we wait before offering "Cancel worker"? Adapter-specific timeouts, or a single UI-side 10-minute cap?

**Risk flags:**

- **Spike expands.** If the diagnostic finds that all three adapters need bespoke capability work, the Phase 5 budget shifts toward Step 4 and the other three steps compress. Mitigation: same cap as Phase 4 Step 0 — 2 day max, ship partial taxonomy if we hit it.
- **False-positive detection.** A worker that writes "should I use option A or B?" as part of normal output (not a genuine blocker) could be mis-classified as awaiting-input. Mitigation: keep the detection signal conservative (e.g., must end in `?` as last non-whitespace character of last stdout chunk within N seconds of exit), add a "Skip question, mark as done" affordance on the UI so false positives have a cheap escape.

**Estimated complexity:** small (1.5 days: 0.5 day adapter survey + doc reading, 0.5 day fake-agent fixtures, 0.5 day write-up + recommendation).

---

### Step 1: Per-worker stop

The foundational lifecycle change and the smallest scope. Phase 3 shipped run-wide `cancel_run`; Phase 5 extends it to per-subtask. Today a user who wants to stop one worker (gone off the rails, wrong file, infinite loop) has to cancel the whole run — losing the other workers' progress and forcing a full re-plan.

**Scope (what it does):**

- New IPC command `cancel_subtask(run_id, subtask_id)` in `src-tauri/src/ipc/commands.rs`. Mirrors `cancel_run` but scoped: sends a cancel signal to that subtask's dispatcher handle only, not the run-wide `cancel_token`.
- Orchestrator method `Orchestrator::cancel_subtask(run_id, subtask_id)`:
  - Validates state: subtask must be in `Running` / `Retrying` / `AwaitingInput` (the latter added in Step 4; guard gracefully for pre-Step-4 callers). Proposed / Waiting / Done / Failed / Cancelled → `WrongSubtaskState` error.
  - Sets a `manual_cancel: true` flag on the subtask's runtime row.
  - Invokes the dispatcher's per-subtask cancel handle (existing `subtask_cancel_tokens: HashMap<SubtaskId, CancellationToken>` in `dispatcher.rs`, if present; otherwise extend with one).
  - Transitions the subtask to `Cancelled` on cancel-confirmed; emits `SubtaskStateChanged { state: Cancelled, errorCategory: None }`.
- Crucially: `dispatcher.handle_subtask_exit` checks `manual_cancel` *before* routing through `classify_nonzero` / `EscalateToMaster`. Manual cancels short-circuit the retry ladder entirely — no Layer 1 retry, no Layer 2 replan, no Layer 3 escalation. The worker is *user-intentionally stopped*, not failed.
- Frontend: per-worker "Stop" affordance on the WorkerNode's running/retrying/awaiting-input states. Lives next to the existing cancel-all-run button in the TopBar — not on the card proper. **Decision resolution:** kebab menu on the card footer, inside the existing footer region. Mirrors WorktreeActions' portal pattern. Only rendered on cancellable states.
- A confirmation dialog is *not* required. Cancel is a common action; a confirm dialog makes it painful. An undo affordance is also out of scope — cancelled is terminal. The kebab menu's label is explicit ("Stop this worker") so the click is intentional.

**Scope (what it does NOT):**

- Does not stop dependent subtasks cascade-style. A worker depending on the cancelled one will transition to `Skipped` when the cancelled worker fails to produce output (existing behavior), not to `Cancelled`. The distinction is worth keeping — cancelled means user-intent, skipped means automatic fallout.
- Does not allow "uncancel" or resume. Cancelled is terminal. To retry the work, the user re-plans (Layer 2 trigger) or re-runs.
- Does not expose per-worker cancel on `Proposed` or `Waiting` subtasks — those have the existing "remove from plan" affordance on the approval bar.
- Does not rename the existing `cancel_run` to `cancel_run_all` or similar — run-wide cancel stays as-is.

**Acceptance criteria:**

- Click the kebab → Stop on a running worker → worker transitions to `Cancelled` within 2s on a fake-agent fixture. Sibling workers continue.
- Run with 3 workers, cancel worker B mid-run → workers A and C still complete → run reaches `AwaitingApproval` with A + C done, B cancelled. Apply proceeds on A + C's diffs only.
- Layer 2 replan does *not* fire for a manually-cancelled subtask. Integration test: set `replan_budget: 2`, manually cancel a worker, assert no `ReplanStarted` event emitted.
- Cancel a worker in `AwaitingInput` (Step 4 prerequisite — test once Step 4 lands): worker transitions to `Cancelled`, the question is dismissed. The integration test ordering: Step 1 lands first with `AwaitingInput` as a TODO marker; Step 4 activates the cross-step assertion.
- `cancel_subtask` on a `Done` / `Failed` / already-`Cancelled` subtask returns `WrongSubtaskState` (no-op on frontend — toast the error).
- Frontend race: `cancel_subtask` in-flight while backend emits `SubtaskStateChanged { state: Done }`. Frontend must tolerate "tried to cancel a worker that just completed." UI: show "worker completed before stop signal arrived" toast; no error state.

**Open questions (resolved before implementation):**

- **Per-worker stop × Layer 2 replan interaction:** Manual cancel bypasses the retry ladder completely. A failed worker whose Layer 1 retry is in-flight when the user clicks Stop → the retry is cancelled, the subtask transitions to `Cancelled`, Layer 2 does not fire. The existing `manual_cancel` flag is the carrier.
- **Stop during an active Layer 2 replan for that subtask:** The replan is a master-side operation, not a worker-side one. The cancel applies to the subtask's runtime state, not the master's in-flight replan call. Cleanest shape: cancel sets `manual_cancel`, master completes its replan naturally, lifecycle checks `manual_cancel` before applying the replacement plan and skips it if set. No new master-cancel wiring.
- **UI surface location:** kebab menu on the card footer, inside `WorktreeActions` if the states overlap — otherwise sibling of it. Decision: sibling component `SubtaskActionsMenu` that encompasses both the Phase 4 worktree actions (when inspectable) and the new Stop action (when cancellable), gated per-state.

**Risk flags:**

- **Race between cancel and Layer 1 retry kickoff:** dispatcher needs to acquire a lock on the subtask row when setting `manual_cancel`, before the Layer 1 retry path reads the state. Existing `run_arc.write()` lock pattern covers this; audit the dispatch path to confirm no lock-free read of state between exit and retry-kick.
- **Cancelled cascade on dependents:** verify a cancelled subtask's dependents transition to `Skipped` (not `Failed`) cleanly. Phase 3 already handles this for `Failed`; confirm the `Cancelled` path is symmetric.
- **No per-subtask cancel handles today:** `dispatcher.rs` may only hold a single `cancel_token` per run, not per subtask. Adding the map is cheap but needs audit — count as 0.5 day of dispatcher work on top of the command plumbing.

**Estimated complexity:** small-to-medium (2 days: 0.5 day dispatcher per-subtask cancel wiring, 0.5 day orchestrator command + `manual_cancel` flag, 0.5 day frontend menu + IPC + race handling, 0.5 day tests including Layer 2 bypass assertion).

---

### Step 2: Base-branch dirty helper

Today when the user clicks Apply and their base branch has tracked uncommitted changes, `BaseBranchDirty` fires, the ErrorBanner shows "cannot apply: base branch has local changes," and the only action is Discard. The user goes to their terminal, `git stash`, comes back, clicks Apply — which works. We're shipping step-two-of-two as a button.

**Scope (what it does):**

- New IPC command `stash_and_retry_apply(run_id)`:
  - Validates run is in `Merging` + last merge-phase outcome was `BaseBranchDirty`.
  - Shells out (structured args, no `sh -c`) to `git stash push -u -m "whalecode: before apply <run_id>"` in the base repo. Captures stash ref.
  - Records the stash ref on the run (in-memory; not persisted — restart loses the reference, which matches today's "restart is cleanup-only" invariant).
  - Sends `ApplyDecision::Apply` to the merge oneshot (same path as a user's second Apply click).
  - Emits `run:stash_created { run_id, stash_ref }`.
- New IPC command `pop_stash(run_id)`:
  - Validates a stash ref is recorded for the run.
  - Shells out to `git stash pop <stash_ref>`.
  - Emits `run:stash_popped { run_id, had_conflicts: bool }` — `had_conflicts` surfaces the "pop conflicted with the just-applied changes" case honestly.
  - Clears the run's stash ref.
- Frontend: ErrorBanner for `BaseBranchDirty` gains a "Stash & retry" button alongside the existing Discard. Click → calls `stash_and_retry_apply`. A follow-up prompt after Apply success: "Restore stashed changes?" with Pop / Keep-stashed / Dismiss (default: Dismiss — explicit is safer than auto-restore).
- A separate "your stash is still here" notice lands in the ApplySummaryOverlay when a run has a lingering stash ref — a single-line info strip, not an error state. Gives the user an out-of-band reminder without the modal.

**Scope (what it does NOT):**

- Does not auto-pop the stash after Apply. Auto-pop is a recipe for surprise conflicts. The user initiates pop explicitly.
- Does not handle the case where the user had *staged* changes alongside unstaged. `git stash push` with `-u` captures both; `git stash pop` restores both. If the user staged deliberately and Apply adds on top, pop may conflict — that's surfaced honestly via `had_conflicts`.
- Does not cross-reference the stashed files against the Apply's file set. The user can see the overlap via `git status` after pop.
- Does not introduce "inspect stash contents" UI. If the user wants to see what they stashed, they go to the terminal.
- Does not touch untracked-but-ignored files (`-u` captures untracked, `-a` captures ignored — we don't want to stash `node_modules`).

**Acceptance criteria:**

- Dirty base branch + run in `Merging` + click "Stash & retry" → `git stash push -u` succeeds → Apply retries → succeeds → user sees ApplySummaryOverlay with the "stash still held" notice → click Pop in the notice → `git stash pop` runs → stash notice clears.
- `git stash` failure (e.g., read-only filesystem) → error toast with the stderr line, run stays in `Merging` + `BaseBranchDirty` state. Retry button remains available.
- User pops stash, pop fails with conflicts → `had_conflicts: true` → info-toast the user ("Stash pop conflicted; resolve in terminal and run `git stash drop` when done") + leave the stash in place.
- Integration test: 3-subtask run, base branch with `echo foo > README.md` uncommitted → first Apply emits `BaseBranchDirty` → `stash_and_retry_apply` → emits `run:stash_created` → Apply succeeds → emits `ApplySummary`.
- Per-worker stop (Step 1) mid-merge: not possible today (subtasks are already Done in the Merging phase). Non-goal.

**Open questions (resolved before implementation):**

- **Stash message format:** `"whalecode: before apply <run_id>"` — run_id in the message makes multi-run stash identification trivial without a separate registry.
- **Multiple stashes for same run:** if the user triggers stash-and-retry, Apply fails differently (e.g., merge conflict), the user fixes, clicks Apply again — we already have a stash. Do we stash again? **Recommend: no.** A run has at most one stash at a time. Second-apply reuses the in-memory ref; no new stash created.
- **Pop after process restart:** if the app crashes between `stash_created` and pop, the stash remains in git. We can't auto-detect "that stash was mine" after restart. **Recommend:** surface any `whalecode:`-prefixed stashes in a startup banner ("Whalecode left N stashed changes from previous runs") with "open terminal to handle" + "dismiss." Scope carried to Step 4 verification only if time permits — otherwise Phase 6 polish.

**Risk flags:**

- **Stash-on-wrong-branch:** if the base branch has moved (user switched branches between Apply click and Stash click), we stash on the current branch, not the target. Mitigation: capture branch name at merge-phase start, assert it matches before `git stash`. If drifted, emit an error and let the user re-orient.
- **Nested Tauri shell calls:** base-branch dirty helper shells out to `git` — same plumbing as Phase 4 worktree creation. Reuse the `std::process::Command` pattern with structured args, not the shell plugin.
- **Stash pop ambiguity:** `git stash pop <ref>` can be ambiguous if the user has stashed manually between. Use `git stash pop --index <ref>` with explicit ref; fall back to showing the full `git stash list` output in the error if pop fails.

**Estimated complexity:** small-to-medium (2 days: 0.5 day `stash_and_retry_apply` + `pop_stash` commands + shell plumbing, 0.5 day ErrorBanner action + post-apply prompt, 0.5 day integration test on a fixture repo, 0.5 day startup-banner scope decision + polish).

---

### Step 3: Merge conflict resolution UX

Builds on Step 2's retry-apply shape. Today a `MergeConflict` event leaves worktrees preserved (good), files marked conflicted in the base branch (good), and the user holding a "now what?" (bad). We add a resolver surface that names the conflicted files, reveals each worktree's version, and offers a one-click retry.

**Scope (what it does):**

- New component `ConflictResolverPopover`, opened from a new "Open resolver" action on the MergeConflict ErrorBanner. Portal-to-document.body (Phase 4 pattern).
- Popover content per conflicted file:
  - File path (relative to repo root).
  - Per-contributing-worker row: worker name + "View this worker's version" → opens its worktree at that path in the default editor (reuses `tauri-plugin-opener` from Phase 4 Step 4).
  - "Open in terminal at base branch" → opens a terminal at the base branch root (reuses Phase 4 `open_terminal_at`). User resolves with standard git tooling.
- Footer: "Retry apply" button. Click → calls a new IPC command `retry_apply(run_id)` which just re-sends `ApplyDecision::Apply` to the lifecycle's re-installed oneshot. No stash logic — that's Step 2's path. The lifecycle already reinstalls the oneshot on `MergeConflict` (see `orchestration/lifecycle.rs:683`); `retry_apply` is the explicit-by-name IPC that threads it.
- On retry: if conflict persists, `MergeConflict` re-fires with a new field `retry_attempt: u32` (incremented). UI shows "Still conflicted on N files" and the resolver re-opens; the attempt count surfaces as a subtle counter in the banner.
- On retry-clean: ApplyProceeds through the rest of the merge oneshot; overlay fires as usual.

**Scope (what it does NOT):**

- Does not ship an in-app merge editor. User resolves in their own tool. Shipping a text merge UI is a Phase 7+ scope.
- Does not auto-merge or suggest resolutions. The 3-way marker (`<<<<<<<` / `=======` / `>>>>>>>`) is the user's interface; we just help them get there.
- Does not support per-file retry. Retry re-applies the whole merge oneshot — if the user fixed 3 of 4 conflicts, the retry will conflict on the remaining one.
- Does not cross-link to Phase 4's `DiffPopover`. The diff popover shows each worker's diff against its base; the conflict is against the merged base. Different view.
- Does not persist conflict-resolver open/closed state across runs (ephemeral by design).

**Acceptance criteria:**

- Run with 2 workers that modify the same file in incompatible ways → Apply → `MergeConflict` fires → user clicks "Open resolver" → popover shows 1 file with 2 worker rows → user picks worker A's version via the editor link, saves → user clicks "Retry apply" → merge succeeds → overlay fires.
- Retry after an incomplete resolution → `MergeConflict` re-fires with `retry_attempt: 2` → resolver re-opens. Integration test asserts the `retry_attempt` counter and the un-dismissed ErrorBanner state.
- Retry-apply after user cancels the run (`cancel_run` in-flight) → command rejects with `WrongState` → toast.
- Clicking "Retry apply" while the lifecycle is still cleaning up the previous conflict (< 100ms window) → command queues via the oneshot (not a new send) → one of the two lands, the other errors cleanly.

**Open questions (resolved before implementation):**

- **IPC command name:** `retry_apply(run_id)` — separate from `apply_run` for UI clarity. Backend-side, it's the same oneshot send with `ApplyDecision::Apply`; the separation is purely semantic so the Tauri-specta binding surfaces a distinct label.
- **Multiple retries:** no cap in the backend. UI may want to gently suggest "you've retried 3 times — consider Discard" after N attempts, but that's polish. Phase 5 doesn't cap.
- **Resolver popover anchoring:** anchored to the MergeConflict ErrorBanner's trigger (banner row with "Open resolver"). Portal to document.body, position computed from the banner's trigger rect.

**Risk flags:**

- **Stale worker state on retry:** if the user triggers Layer 2 replan *between* a failed apply and a retry-apply (not currently possible in the UI but worth auditing), the conflict could reference subtasks that have been replaced. Audit `retry_apply`'s state validation to reject if the subtask set has changed.
- **Rebind editor links:** the "View worker's version" link uses the worktree path. If the worktree has been cleaned up (shouldn't be — lifecycle preserves on conflict, but defence in depth), the link fails. Same error path as Phase 4 Step 4's reveal failure.
- **Retry-apply after stash-and-retry (Step 2 cross-interaction):** a user stashes base-branch changes, apply conflicts on worker merge, retry-apply is clicked. The stash is still in place. The retry re-enters the merge oneshot with the stash still live (good — consistent with Step 2's flow). The post-apply overlay's "stash still held" notice fires correctly.

**Estimated complexity:** medium (2.5 days: 0.5 day `retry_apply` command + payload field, 1 day `ConflictResolverPopover` + worker-row affordances, 0.5 day ErrorBanner integration + `retry_attempt` counter UI, 0.5 day integration tests covering retry success/failure/cancel races).

---

### Step 4: Interactive agent Q&A

The largest scope and the phase's riskiest step. Informed by Step 0's diagnostic. This spec takes a **decision-conditional stance**: if Step 0 finds that all three adapters can emit a question signal (structured or heuristic) and at least Claude supports stdin injection, we ship the full "pause-resume" flow below. If Step 0 finds that no adapter supports stdin injection, we ship the "restart-with-appended-prompt" fallback across all three — same UI surface, different backend mechanics.

The success criteria in the phase header are written to be satisfied by either implementation path.

**Recommended path (pending Step 0 confirmation):**

- New `SubtaskState::AwaitingInput` variant. Transient, not persisted, gates dispatch + cancel. Rationale: questions are per-instance (like retrying), but they *block forward progress* unlike a discriminant — a field on `Running` would conflict with the Phase 4 Step 5 precedent that a discriminant doesn't change lifecycle transitions. Q&A does change transitions; state is the right carrier.
- New adapter capability: `AgentKind::supports_stdin_injection() -> bool`. Claude interactive: `true`. Codex `-p` / Gemini single-shot: `false`.
- New event `run:subtask_question_asked { run_id, subtask_id, question_text, detection_method: "structured" | "heuristic-suffix" | "exit-with-trailing-question" }`. The `detection_method` field flags false-positive risk to the UI (UI can show a "not a question? Mark done instead" affordance for heuristic detections).
- New IPC command `answer_subtask_question(run_id, subtask_id, text)`:
  - Validates subtask is in `AwaitingInput`.
  - For stdin-injection adapters: writes the answer to the open stdin pipe + a newline; transitions subtask back to `Running`; worker continues.
  - For non-injection adapters: concatenates the answer onto the original worker prompt, re-spawns the worker, transitions subtask back to `Running` with `retry_attempt` bumped (not counted against Layer 1 budget — this is a question-answer restart, not a failure retry).
- New event `run:subtask_answer_received { run_id, subtask_id }` emitted after answer-delivery succeeds.
- UI surface: WorkerNode in `AwaitingInput` state renders an inline input + "Send" button + "Skip question, mark done" affordance. Multi-line input via Shift+Enter. Submits on Enter. Escape cancels the input focus but does not cancel the subtask (user must explicitly Stop).

**Scope (what it does):**

- Detection layer per adapter:
  - Claude interactive: trigger on stdout chunks ending in `?` that haven't been followed by more output within a 2s quiesce window (per Step 0's "conservative heuristic" recommendation). If Claude surfaces a structured signal in a future release, swap heuristic for structured.
  - Codex `-p` / Gemini single-shot: trigger on exit code 0 + last stdout line ending in `?` with no result JSON parsed. This is the Phase 3 observed bug; the detection formalizes it.
- Frontend: `QuestionInput` component on WorkerNode. Renders in place of the log-tail when `awaiting-input`. Full log accessible via the Phase 4 expand affordance.
- Answer injection: structured argument API, no shell interpolation. For the restart-with-appended-prompt path, the answer text is the new `--last-answer` argv value (or append to the existing prompt flag — decided per adapter after Step 0).
- Timeout: if no answer in 10 minutes, the question stays pending. No auto-cancel. User can Stop (Step 1) or walk away; run's own timeout eventually fires.
- Skip affordance: "Mark done without answering" transitions the subtask to `Done` with an empty diff (no changes). The false-positive escape hatch.

**Scope (what it does NOT):**

- Does not support multi-turn Q&A in one subtask. Each question is a discrete round-trip: ask → pause → answer → resume. A worker that asks a second question enters a second `AwaitingInput` state.
- Does not inject answers into cancelled / failed subtasks (irreversible).
- Does not show a global "all pending questions" panel. Questions are per-worker; user navigates to the card.
- Does not persist the answer text across restart. If the app crashes mid-Q&A, the worker is lost (Layer 1 retry may re-ask).
- Does not attempt to classify question quality. If Claude asks "Are you sure?" we pause; that's the detection's scope.

**Acceptance criteria:**

- Fake-agent fixture `fake_asks_question_then_waits.sh` + Claude-interactive-like adapter → stdout-suffix-with-`?` → `SubtaskStateChanged { state: AwaitingInput }` + `run:subtask_question_asked` fires → user types "option A" + Enter → `answer_subtask_question` → worker receives "option A\n" on stdin → worker produces output → subtask transitions to `Running` then `Done`.
- Fake-agent fixture `fake_asks_question_then_exits.sh` + Codex-like adapter → worker exits 0 with question-suffix in stdout → `AwaitingInput` + question_asked fires (detection heuristic) → user answers → worker *re-spawned* with appended prompt → produces output → Done. Integration test distinguishes the two paths via `detection_method` field.
- Skip affordance: "Mark done without answering" → subtask transitions to `Done` with empty `FileDiff` → Apply still works on remaining workers' diffs → ApplySummaryOverlay attributes 0 files to this worker (honest signal).
- Cancel a worker in `AwaitingInput` → Step 1's `cancel_subtask` transitions to `Cancelled` → question is dismissed, no answer injection attempted.
- Submit answer after run-cancel → `WrongState` error toast.
- False positive: detection fires on a worker's non-question trailing `?` (e.g., "Is this the right approach? Yes, going with option A.") → Step 0's conservative heuristic reduces this to a rare case; when it happens, user clicks Skip → subtask transitions to Done with whatever output was captured.

**Open questions:**

- **If Step 0 finds stdin-injection is universally unavailable:** fall back to the restart-with-appended-prompt path for all three adapters. UI is unchanged; backend mechanics converge. Spec below still applies; the `supports_stdin_injection()` capability returns `false` uniformly.
- **Multiple simultaneous questions across workers:** supported — each worker has its own AwaitingInput. UI shows each card's input independently.
- **Answer retention in UI:** if user types an answer and switches focus, does the input clear? **Recommend:** persist until subtask transitions out of AwaitingInput or user submits. In-session only; restart clears.
- **"What if the agent asks a question that references files it edited?"** The user may want to expand the worker card (Phase 4 Step 3) and view the diff popover (Phase 4 Step 6) before answering. The UI supports both in parallel — expand + question input coexist on the expanded card.

**Risk flags:**

- **Detection false-positive rate is unknowable from the spec.** The Step 0 spike must give us a calibrated number; if it's > 5% on a reasonable sample, the conservative heuristic needs to be tightened (e.g., second signal: question word at sentence start — "which", "should", "does") before ship. Track in verification.
- **Stdin injection race:** user types answer while the worker is still producing stdout. If we inject mid-stream, Claude may interpret partial input as a separate message. Mitigation: require the 2s stdout-quiesce before transitioning to AwaitingInput; require worker to have consumed previous stdin before accepting next. Adapter-level bookkeeping.
- **Restart-with-appended-prompt changes output:** re-running the same prompt with the answer appended may produce different output than a "continue" would. Verify with Step 0 spike. If output divergence is severe, we may need to accept this as a known limitation and flag to the user: "Answer will restart this worker; output may differ."
- **AwaitingInput in the persistence layer:** the state is in-memory only (like `Retrying`). On app restart, the subtask is resurrected as `Failed` (existing `recover_active_runs` behavior). The user loses the answer they typed. Flag as known limitation; full persistence is Phase 6+.

**Estimated complexity:** large (4-5 days: 1 day adapter capability + detection layer per adapter, 1 day stdin-injection path, 1 day restart-with-appended-prompt path, 1 day frontend `QuestionInput` + state transitions + cross-step integration with Step 1 cancel, 0.5 day tests including false-positive skip path, 0.5 day Step 0 recommendation bake-in).

---

### Step 5: Verification

Same shape as Phase 4 Step 7 — verify goal-backward, not just step-complete.

**Scope:**

- Manual verification pass on a reference repo. Exercise all four unblock paths end-to-end:
  1. Start a run, click Stop on one worker mid-execution, confirm run continues with remaining workers and reaches Apply.
  2. Make base branch dirty, click Apply, click "Stash & retry," confirm merge succeeds, click Pop, confirm stash returns.
  3. Craft a run with 2 workers modifying the same file to force a conflict, click "Open resolver," resolve manually via editor link, click "Retry apply," confirm success.
  4. Use a fake-agent fixture to emit a question-shaped output, answer it in the UI, confirm worker resumes and completes.
- Integration tests:
  - Per-worker stop bypasses Layer 2 replan (Step 1).
  - `stash_and_retry_apply` event ordering: `BaseBranchDirty → stash_created → ApplyDecision → ApplySummary` (Step 2).
  - `retry_apply` after incomplete resolution re-emits `MergeConflict` with incremented `retry_attempt` (Step 3).
  - Q&A round-trip: `question_asked → answer_received → SubtaskStateChanged { Running → Done }` (Step 4).
  - Cross-step: Q&A subtask cancelled via Step 1 → transitions to `Cancelled` cleanly (Step 4 × Step 1).
- Visual regression artifacts in `docs/retrospectives/phase-5-visuals/` — 5 text observations per the Phase 4 pattern.
- Goal-backward VERIFICATION.md: does the phase deliver on "unblock the run"?
- KNOWN_ISSUES.md updates: move 4 Phase 5 entries to "Resolved in Phase 5," retarget any remaining debt, add new entries for unshipped Q&A edge cases (false-positive tuning, restart-with-prompt output divergence, AwaitingInput non-persistence).
- CLAUDE.md status update.

**Acceptance criteria:**

- 5/5 goal criteria PASS.
- Step-level acceptance pass tallies: Step 1 ~6 items, Step 2 ~5, Step 3 ~4, Step 4 ~7, totalling ~22.
- Frontend tests green (target: +30 over Phase 4's 630 = 660).
- Rust tests green (target: +15 over Phase 4's 325 = 340).
- `tsc --noEmit`, `eslint`, `cargo clippy -- -D warnings` clean.
- CI green on every commit.
- `docs/phase-5-verification.md` written with one paragraph per scope item + scoreboard.
- `docs/retrospectives/phase-5.md` matching the Phase 3 / Phase 4 retrospective format.

**Open questions:**

- Should a "force a question" debug affordance land alongside the Step 4 verification? KNOWN_ISSUES entry #38 ("No debug-only failure injection") is targeted at Phase 5 anyway — a 1-day debug-flag helper that lets the user force a subtask into AwaitingInput on-demand would pay back in verification and stay useful for Phase 6+.  **Recommend:** include the debug helper as a Step 4 sub-deliverable, scope 0.5 day.
- Should we attempt programmatic visual regression (KNOWN_ISSUES #39) as part of Step 5? **Recommend no** — Phase 5's scope is already heavy; Phase 6 pilots visual regression with a focused spike.

**Risk flags:**

- **Manual verification compounds across 4 steps × 2-3 scenarios each.** Budget 1 full day for the manual pass.
- **Q&A false-positive rate is the single biggest unknown.** Verification should include a calibration run — 10 diverse tasks on a real adapter, count false positives, adjust heuristic if > 5%.
- **Cross-step interactions are fertile for bugs.** Step 1 × Step 4 (cancel a Q&A worker) and Step 2 × Step 3 (stash-and-retry with a conflict following) both deserve explicit integration tests, not just manual.

**Estimated complexity:** medium (1.5 days: 1 day manual pass + integration tests, 0.5 day retrospective + KNOWN_ISSUES + CLAUDE.md + VERIFICATION.md).

---

## Estimated total complexity

| Step | Complexity | Days |
|---|---|---|
| 0 — Q&A capability spike | small | 1.5 |
| 1 — Per-worker stop | small-medium | 2 |
| 2 — Base-branch dirty helper | small-medium | 2 |
| 3 — Merge conflict resolution UX | medium | 2.5 |
| 4 — Interactive agent Q&A | large | 4.5 |
| 5 — Verification | medium | 1.5 |
| **Total (full Step 4)** | | **~14 days** |

Fits within the 2-week duration estimate. Prior phases (3, 3.5, 4) all came in at ~2-3 active working days against 2-week estimates — Phase 5's realistic floor on Phase-4-budget-model evidence is 3-5 active working days. The conservative estimate here accounts for Q&A being the first phase in three that touches agent-adapter internals rather than pure orchestration/UI plumbing; the floor may hold anyway if Step 0 finds a clean capability story.

## Architectural questions addressed

Three open questions from the Phase 5 kickoff brief, each grounded in the phase's backend shape:

**Q1: Should Q&A introduce a new `SubtaskState::AwaitingInput`, or a discriminant field on `Running` (the Phase 4 Step 5 pattern)?**

**Recommendation: new state.** Phase 4 Step 5 used a discriminant for crash *classification* because the subtask's lifecycle transition (`Running → Failed`) was unchanged; only the copy rendered differed. Q&A *changes the lifecycle*: the worker stops producing output, blocks on input, and cannot advance without user action. A discriminant on `Running` would lie about what the subtask can do (dispatch is gated, cancel routing differs, aggregate-diff pass must skip it). The state carries the correct gating — `Retrying` is the existing precedent for "transient state that affects dispatch but doesn't persist." Step 0 confirms or overturns this.

**Q2: Does per-worker stop interact with Layer 2 replan?**

**Recommendation: manual cancel bypasses the retry ladder completely.** A manually-cancelled subtask sets `manual_cancel: true` on the runtime row; `dispatcher.handle_subtask_exit` checks the flag before routing through `classify_nonzero` / `EscalateToMaster`. Layer 1 retry, Layer 2 replan, Layer 3 escalation — all skipped. The subtask transitions to `Cancelled` (user-intent terminal), not `Failed` (orchestrator-intent terminal). Dependents of the cancelled subtask still transition to `Skipped` via the existing cascade (not changed in Phase 5).

**Q3: What's the IPC shape for merge retry-apply?**

**Recommendation: reuse the existing merge-phase apply oneshot, expose it as a dedicated `retry_apply(run_id)` command for UI clarity.** The lifecycle already reinstalls the `ApplyDecision` oneshot on `MergeConflict` (`orchestration/lifecycle.rs:683`); the backend plumbing for retry is identical to a second-click of Apply. The new command is a semantic label for Tauri-specta bindings — backend-side it's `ApplyDecision::Apply` sent to the same channel. Step 2's stash-and-retry is a distinct command (`stash_and_retry_apply`) because it composes stash + apply; Step 3's retry is plain apply.

## Post-phase deliverables

- `docs/phase-5-spec.md` (this file) closed with a "Shipped" note.
- `docs/phase-5-qa-diagnostic.md` (from Step 0) — may be inlined into the retro if short.
- `docs/phase-5-verification.md` — goal-backward pass/fail.
- `docs/retrospectives/phase-5.md` — timing, bug clusters, lessons for Phase 6.
- `docs/retrospectives/phase-5-visuals/` — 5 text visual observations.
- `docs/KNOWN_ISSUES.md` updated: 4 items move to "Resolved in Phase 5," new entries for Q&A edge cases.
- `CLAUDE.md` updated with last-shipped + next-phase target.
- Phase 6 spec kickoff brief — one-paragraph scope plus success-criteria sketch. Phase 6's likely scope: mono-repo awareness, cost tracking wiring, rate-limit classification + backoff, programmatic visual regression pilot.
