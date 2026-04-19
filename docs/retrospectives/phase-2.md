# Phase 2 retrospective — agent integration

**Shipped:** 2026-04-19 at `8f7f895 feat(recovery): surface boot-time crash-recovery banner`
**Started:** 2026-04-18 at `964a052 feat(phase-2): step 1 — IPC wire contract (TS side)`

## Duration vs estimate

| | Estimate | Actual |
|---|---|---|
| Calendar | 2–3 weeks | 2 days (2026-04-18 → 2026-04-19) |
| Active wall time | — | ~30 hours across two working sessions |
| Commits | — | 34 on main between `f7cf6dd..8f7f895` |

Estimate was wrong by roughly 7×. The spec was written assuming a human pace; the work was executed by an AI agent with the spec as the plan. Useful lesson: spec estimates are a budget for the *decisions*, not the typing. The decisions here were already made — the spec locked them. That's what compressed the timeline.

## Step-by-step timing

Timestamps are the commit time of the last commit in each step; durations are measured from the previous step's end, so step 1 has no "duration" column.

| Step | Description | End commit | Completed | Duration |
|---|---|---|---|---|
| 1 | IPC wire contract (TS) | `964a052` | 04-18 10:02 | — |
| 2 | Repo path + settings file | `5f16754` | 04-18 18:19 | (off-keyboard gap) |
| 3 | SQLite schema + plugin | `24253a4` | 04-18 18:31 | 12 min |
| 4 | Agent detection | `99ea919` | 04-18 20:13 | 1h 42m |
| 5 | Agent trait + three adapters | `32f6681` | 04-18 20:57 | 44 min (a/b/c commits) |
| 6 | Git worktree lifecycle | `227b727` | 04-18 21:12 | 15 min |
| 7 | Shared notes + gitignore | `00141ef` | 04-18 21:26 | 14 min |
| 8 | Orchestrator (a–d + fixes) | `23ab397` | 04-18 22:45 | 1h 19m |
| 9 | Frontend integration + ErrorBanner | `865902e` | 04-19 01:37 | 2h 52m |
| 10 | Wire Orchestrator into Tauri | `795d0c3` | 04-19 10:06 | (overnight break) |
| 11 | Verification + bug fixes | `8f7f895` | 04-19 16:19 | 6h 13m |

The longest active chunk was Step 11 — verification and the bugs it surfaced. That is where the gap between "spec complete" and "product works" lives, and it dominated the schedule. Next phase's estimate should reserve ~25–30% of the budget for Step-11-equivalent work.

## Bugs surfaced during Step 11 verification

Phase 2 had twelve acceptance criteria. Each was exercised manually against a real repo (`fatura-budget`) with real agents. Five distinct bug classes came out of that pass; all were fixed before the phase was closed. Categorized by root cause:

### 1. "0 files changed" after Apply — **test gap**
**Symptom:** Apply succeeded, but the final node reported zero diffs; real agents had clearly edited files.
**Fix:** `8f4fe97 fix(phase-2): auto-commit worker changes in dispatcher`
**Root cause:** The worker contract didn't say who was responsible for committing — workers produced file edits, but nobody turned those edits into commits on the subtask branch, so the per-subtask diff was empty and Apply merged nothing. The `ScriptedAgent` test fixture happened to commit inside its own fake `execute`, which masked the gap in every orchestrator unit test.
**Lesson:** Test fixtures that are *more* capable than the real thing hide the seams that production code has to handle. Fake agents should be deliberately dumber than real ones.

### 2. FinalNode didn't activate on DiffReady — **integration issue**
**Symptom:** After all workers completed, the FinalNode stayed in its idle visual state; Apply/Discard buttons were unreachable.
**Fix:** `4eaa8ec fix(phase-2): activate FinalNode actor on DiffReady`
**Root cause:** Phase 1 drove the FinalNode actor from `mockOrchestration` directly. When the store was refactored in Step 9 to be event-sourced, the `DiffReady` handler populated the node data but forgot to send the actor an `ACTIVATE` event. The XState actor was still sitting in `idle`.
**Lesson:** When a source of truth shifts, re-read every downstream consumer — not just the ones named in the change.

### 3. React Flow pointer events — **integration issue (framer-motion × React Flow)**
**Symptom:** Clicking on a worker card did nothing; nothing under the canvas received pointer events.
**Fixes:** `c0ea00f fix(ui): worker card click toggles subtask selection` + `5d337a2 fix(ui): unblock React Flow node pointer events on canvas`
**Root cause:** framer-motion's wrapping `div` inherited `pointer-events: none` from a parent React Flow viewport wrapper in dev mode. In production builds it worked; in dev mode the layer promotion ordering differed enough to block events.
**Lesson:** Dev-mode HMR and framer-motion's layout transitions create visual state that doesn't match production. Treat `pnpm tauri build` as the ground truth, not `pnpm dev`.

### 4. Base branch dirty → silent merge failure — **design gap**
**Symptom:** User's working tree had uncommitted changes; Apply "succeeded" from the orchestrator's POV but `git merge` silently refused, leaving no visible signal.
**Fixes:** `a024551 fix(phase-2): refuse merge when base branch has tracked uncommitted changes` + `785947e fix(ui): include repo path in BaseBranchDirty banner`
**Root cause:** The spec assumed a clean base branch. `merge_all` did not check `git status` before attempting the merge, so `git merge` returned the same "no changes" exit path as "everything already applied." A second variant of the same class surfaced when the user had two same-named sibling repos open — the banner couldn't disambiguate without the absolute path.
**Lesson:** Anything involving `git merge` needs a pre-flight. "Did the merge happen?" is not a question `git merge`'s exit code answers cleanly.

### 5. Terminal-state frontend gaps — **design gap (cluster)**
Three closely related gaps, all surfaced by the Step 11 manual replay:

- **Enter did nothing after Apply succeeded.** Fixed in `28077ed fix(ui): unblock new-task submit after a run reaches a terminal state`. The `submitTask` guard threw "a run is already active" because `runId` was non-null even though the status was terminal. EmptyState swallowed the error (`console.error`) and the UI stayed silent.
- **`rejectAll` left the graph frozen.** Fixed in `23e1f19 fix(ui): reset graph after rejectAll so the user lands back in EmptyState`. `rejectAll` awaited the backend but never reset the store; the backend's `StatusChanged(rejected)` event went to a detached subscription and was dropped.
- **Crash recovery was invisible.** Fixed in `8f7f895 feat(recovery): surface boot-time crash-recovery banner`. The backend *did* mark stale runs failed and clean up worktrees on boot — but it only `eprintln!`'d, so the user couldn't tell recovery had happened.

**Root cause (cluster):** The orchestrator ships events for every state transition; the frontend store was designed to consume them. Whenever a command issued by the frontend was supposed to leave the store in a known-clean state (reject, terminal status, crash recovery), the code relied on the event round-trip and didn't reset locally — but in each of these cases the event couldn't deliver (detached subscription, no emit at all, pre-boot event horizon).
**Lesson:** When an action has a "this is definitely done" moment, reset the local store *and* wait for the event. Don't trust the event round-trip to cover terminal cleanup.

## What went well

- **Master-centric + shared notes was the right call.** No rework of the communication model at any point during Phase 2. Workers wrote to their own sections in `.whalecode/notes.md`, master consolidated, no peer-to-peer bugs.
- **Worktree isolation pulled its weight.** Zero cross-subtask interference in every run, including cancellation stress. The one merge bug (base branch dirty) was about the *target*, not the worktrees.
- **Event-sourced frontend store held up.** The one big Step 9 refactor from `mockOrchestration` to event-sourced left the UI visually identical on every responsive breakpoint. XState actors composed cleanly with the event flow.
- **The three-pronged Step 5 structure (trait + commit-a, Claude + commit-b, Codex/Gemini + commit-c) made the adapter contract discoverable.** Every subsequent bug on any adapter had a clean diff to point at.
- **Foundations didn't get rewritten mid-phase.** Detector, worktree manager, notes, registry — all landed at their Step N and stayed. Only the orchestrator accumulated fix commits, which is where the complexity lives.

## Lessons for Phase 3

1. **Fake agents should be deliberately weaker than the real ones.** The `ScriptedAgent` auto-commit masked the worst bug in Phase 2. For Phase 3's retry/re-plan ladder, the test fixture should fail in realistic ways (partial output, exit-1 with stdout noise) rather than clean `Err(AgentError::Timeout)`.
2. **Budget 25–30% of the phase for Step 11 verification.** In Phase 2 this was 6 of ~30 wall hours and surfaced five bug classes. Phase 3 will have more state transitions (retrying, escalating, human-escalation), so the verification matrix is larger.
3. **Pre-flight every git operation.** If Phase 3 introduces "Apply partial results" or similar, add the `git status` pre-flight before the merge. Don't rely on `git merge`'s exit code alone.
4. **When adding a new event, audit every caller that the event is *supposed* to clean up after.** If a caller would be stuck when the event doesn't arrive (detached subscription, terminal state, crash), it should reset locally in addition to listening.
5. **`pnpm tauri build` ≠ `pnpm dev` for animations.** Any UI work touching framer-motion or React Flow layering should be spot-checked against a production build before it ships.
6. **Terminal-state semantics are a frontend design concern, not just a backend one.** Phase 3 adds `escalating` and `human_escalation` — each of these is another "is this terminal?" question that the store guards need to answer explicitly.

## Open debt carried into Phase 3

Tracked in `docs/KNOWN_ISSUES.md`:

- framer-motion dev-mode stuck animations (cosmetic, dev-only)
- Worker card expand affordance (Phase 3 UX pass)
- Multi-repo workspaces (deferred to v3)
- Partial run recovery (deferred to v2.5 — current v2 does cleanup, not resume)
- Conflict resolution UX (Phase 4 — Phase 2 surfaces conflicts honestly but offers no resolution path)

None of these block Phase 3; all are flagged so they don't get lost.

## Scoreboard

- 12 / 12 acceptance criteria: **PASS**
- Frontend tests: **242 / 242**
- Rust tests: **191 / 191** (including new `recovery_report_is_populated_and_drained_once`)
- `tsc --noEmit`, `eslint`, `cargo clippy -- -D warnings`: **clean**
- Worktree stress test (20 starts, random cancels): **0 orphans**
- Crash recovery (`kill -9` mid-run, restart): **0 orphans, banner surfaces**

Phase 2 ships.
