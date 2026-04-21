# Phase 3 retrospective — approval flow and progressive retry

**Shipped:** 2026-04-21 at `e2c6b5c fix(phase-3): LogBlock placeholder instead of empty black hole during worker startup`
**Started:** 2026-04-19 at `c75302a docs(phase-3): spec review after Phase 2 completion`

## Duration vs estimate

| | Estimate | Actual |
|---|---|---|
| Calendar | 2–3 weeks | ~2.5 days (2026-04-19 → 2026-04-21) |
| Active wall time | — | ~25 hours across three working sessions |
| Commits | — | 33 on main between `c75302a..e2c6b5c` |

Phase 3 was scoped larger than Phase 2 on paper (three retry layers, inline editing, auto-approve, editor launch) and came in at roughly the same wall time. The Phase 2 retrospective had already flagged "budget 25–30% for Step 11 verification" — Phase 3 honored that explicitly, and it showed: the verification pass surfaced 6 distinct fixes in the closeout window rather than the usual single-shot "it works" result.

## Step-by-step timing

Timestamps are the commit time of the last commit in each step; durations are measured from the previous step's end.

| Step | Description | End commit | Completed | Duration |
|---|---|---|---|---|
| 0 | Spec review + kickoff alignment | `60ff2f5` | 04-19 17:50 | — |
| 1 | M002 migration + `Retrying` state plumbing | `7202595` | 04-19 17:56 | 6 min |
| 2a | Backend edit commands (update/add/remove subtask) | `699f123` | 04-19 18:19 | 23 min |
| 2b | Frontend store actions for subtask edits | `7c0e25d` | 04-19 18:36 | 17 min |
| 3 | Machine retry refactor (backend-driven) | `423bf1f` | 04-19 19:10 | 34 min |
| 4 | Layer 1 worker-level retry ladder | `39e63bd` | 04-19 19:26 | 16 min |
| 5 | Inline-edit primitives + pointer-event guard | `d2b8156` | 04-19 19:55 | 29 min |
| 5b | Graph store edit/add provenance tracking | `9bba47e` | 04-19 20:00 | 5 min |
| 5c | Inline edit UI on proposed worker nodes | `ac8bbe1` | 04-19 20:10 | 10 min |
| 5d | + Add subtask button on approval bar | `ba4c912` | 04-19 20:11 | 1 min |
| 5e | Click-to-pan on dependency #N labels | `16ebc34` | 04-19 20:57 | 46 min |
| 6a | Master replan trait + prompts + adapters | `9dffa6b` | 04-19 22:15 | 1h 18m |
| 6b | Master replan orchestration + dispatcher + events | `4338550` | 04-19 22:38 | 23 min |
| 6c | Master replan surface in frontend | `2fe299c` | 04-19 22:56 | 18 min |
| 6d | Layer-3 editor detection + IPC skeletons | `6bee77c` | 04-19 23:33 | 37 min |
| 7 | Layer 3 lifecycle + IPC + frontend UI | `ba8d6e1` | 04-20 08:54 | (overnight break) |
| 7b | Auto-approve bypass + safety gate stub | `f49ef39` | 04-20 09:51 | 57 min |
| 7c | Auto-approve settings UI + Auto badge | `78a6331` | 04-20 11:05 | 1h 14m |
| 8 | Cancel button + cancelled terminal semantics | `0ddd8cd` | 04-20 14:13 | 3h 08m |
| 9 | Verification, fix cluster, phase closeout | `e2c6b5c` | 04-21 07:54 | ~17h (overnight + next day) |

The Step 9 verification-and-fix cluster dominated the tail, exactly as the Phase 2 retro predicted. Six fixes landed across that cluster alone; three required a second look (title/why squeeze → row-max height → LogBlock placeholder) because each fix uncovered the next visible layer of the same "proposed → running" transition.

## Bugs surfaced during Step 9 verification

Phase 3 had 15 acceptance criteria. Manual verification against `fatura-budget` with real Claude agents produced five distinct bug clusters; all were fixed before the phase was closed.

### 1. Cancel left the store non-terminal — **lifecycle gap**
**Symptom:** Pressing Cancel emitted the backend event but the frontend kept `runId` set; the next Enter re-hit the "already active" guard.
**Fixes:** `7a513e4 fix(phase-3): treat cancelled as terminal in store detach + submit guard` + `01f701f fix(phase-3): sweep actors into cancelled state so cancel is visible` + `0ddd8cd fix(phase-3): route cancelled runs back to EmptyState`
**Root cause:** `Cancelled` was introduced as a new terminal status but the store's terminal-set list (built in Phase 2) was copy-pasted with only the Phase 2 terminals. Two sites (detach-on-terminal and the submit guard) had to be updated, and each was independently necessary.
**Lesson (reinforces Phase 2 #5):** Every new terminal state is a multi-site change. Grep for `isTerminal` / the literal `['done', 'failed', ...]` shape when adding one.

### 2. Worker card squeeze — **CSS defaults × new content**
**Symptom:** In the proposed state, title truncated to `…` and the `why` line disappeared before the user could read it.
**Fix:** `98977c4 fix(phase-3): keep title visible when why wraps (flex shrink + truncate)`
**Root cause:** The card's body was a flex column; with Phase 3's added `why` line the default `flex-shrink: 1` caused the title's 1-line min to be reclaimed. `shrink-0` on the title + `min-h-0 overflow-hidden` on the why container fixed it.
**Lesson:** Flex-column defaults are hostile to variable-height content. Every flex column that hosts user-supplied text needs `shrink-0` on the fixed-height bits.

### 3. Running/done worker cards overflowed — **layout × content gap**
**Symptom:** Once a card entered `running`/`done`, the 54px LogBlock made the 140px default card insufficient; `why` was covered by the opaque LogBlock background.
**Fix:** `1e93761 fix(phase-3): worker card height accommodates why field in running/done states`
**Root cause:** `layoutGraph` treated worker height as a single constant with one `human_escalation` override. Adding LogBlock to 4 more states (`running`/`retrying`/`done`/`failed`) required a per-state override map; the row-max alignment pattern (existing code) then lifted proposed neighbours to match.
**Lesson:** When a node's visual height is state-driven, the override map should live next to the state list, not next to the default constant. Easier to spot the coverage gap.

### 4. Empty LogBlock rendered as a black hole — **visual identity bug**
**Symptom:** Before the first log line arrived, running workers showed a stark black 54px rectangle on the card, drawing more attention than the title.
**Fix:** `e2c6b5c fix(phase-3): LogBlock placeholder instead of empty black hole during worker startup`
**Root cause:** LogBlock's original dark fill was designed around "always has content." The empty branch inherited the fill without content. Removing the fill + showing an italicized "Waiting for output…" + blinking cursor in `running`/`retrying`, and skipping the block entirely in `done`/`failed` with no logs, matched designer intent.
**Lesson:** If an affordance needs an "empty" state to make sense, design the empty state first. The non-empty path is usually the easy one.

### 5. Interactive agent Q&A dead-end — **scope-level gap**
**Symptom:** Worker emitted a clarifying question ("Which option should I proceed with?") and the run completed as Done with the question in its log; the user had no way to answer.
**Fix:** None — logged to `docs/KNOWN_ISSUES.md` as Phase 4 target (`9c2270a docs(phase-3): log interactive Q&A gap in KNOWN_ISSUES`).
**Root cause:** The agent lifecycle treats worker output as one-shot. There is no channel to surface a question back to the UI or to relay the user's answer mid-execution. Addressing it requires changes to the agent adapter trait, the dispatcher, and the approval surface.
**Lesson:** Bugs that require core lifecycle changes must be triaged to KNOWN_ISSUES early, not fought with incremental patches. The moment "workaround: frame tasks more specifically" shows up in the fix notes, that's the signal to stop.

### 6. Flaky replan integration test — **test timing**
**Symptom:** `replan_happy_path_accepts_replacement_and_reaches_done` failed once, passed on re-run during Step 5 Commit 1 work.
**Fix:** Logged to KNOWN_ISSUES (`03ee45d`) as a Phase 3 verification item; investigated later, root cause suspected around `SubtaskStateChanged` dispatch vs. the test waiter. Did not recur in Step 9 runs.
**Lesson:** A single flake that doesn't reproduce isn't worth blocking a phase on — log it, watch for recurrence, fix only if it hits twice.

## What went well

- **Layer-by-layer structure held.** Layer 1 (worker retry) → Layer 2 (master re-plan) → Layer 3 (human escalation) landed in that order, and no layer's tests broke when the next layer was added. The boundary between backend-driven machine state (Step 3) and frontend presentation (Steps 5–7) stayed clean.
- **Backend-driven retry counter was the right call.** The Phase 2 state machine had `MAX_RETRIES` / `canRetry` guards in the XState machine itself; Phase 3's refactor moved the counter to `graphStore.subtaskRetryCounts` with the machine reflecting backend state. Zero retry-counter bugs surfaced in Step 9 verification as a result.
- **Replan reused Phase 2 events.** The spec's "don't invent `run:replan_started`" pitfall note proved correct — `Status(Planning) + SubtasksProposed` was sufficient, and the replan UI was ~150 LOC rather than a new event-handling cluster.
- **Layer 3 parked lifecycle semantics (`16306bd`, `c2616d8`).** Keeping the run `Running` with individual subtasks in `human_escalation` avoided an entirely separate "escalating" run status, which would have touched every frontend guard.
- **Auto-approve safety gate stub (`f49ef39`).** Exposing `is_action_safe` now, even returning `true`, means Phase 7 only has to fill in the predicate. Zero architectural churn deferred.
- **Cancel button shipped mid-phase, not deferred.** Originally scoped for "later"; the Step 8 push surfaced three bugs that would have been much harder to untangle in Phase 4 once more lifecycle states accumulated.

## Lessons for Phase 4

1. **State-driven height overrides need a dedicated map.** The current `workerHeights` override pattern worked, but the coverage table (which states → which heights) should live as a first-class object in `layout.ts`, not as ad-hoc conditionals. Phase 4 will add mono-repo dependency affordances that likely need their own height tier; don't re-derive the pattern.
2. **Every new terminal state is 3 store edits + 1 test.** Log this explicitly in the Phase 4 kickoff: `isTerminal` set, detach handler, submit guard, a store test that iterates every status and asserts guard behavior. Phase 3 found two of three by hand.
3. **KNOWN_ISSUES is the right answer when you catch yourself saying "workaround."** The Q&A gap was caught in ~20 minutes of triage; faster than the first three squeezed fixes took individually.
4. **Verification in `pnpm tauri dev` still doesn't catch everything.** Three of the six fixes (running/done height, LogBlock visual, title squeeze) were only visible to a user who actually ran tasks and watched the cards transition. Unit tests covered the logic; visual regressions need eyeballs. Phase 4 should reserve a pass specifically for the running→done visual transition on every worker state.
5. **Fake agents remained weaker than real ones (as Phase 2 resolved).** The Phase 3 test fixture didn't auto-commit and didn't mask any of the retry/replan bugs. Keep that discipline.
6. **Failure-injection is a Phase 4 investment.** Criteria 7, 15 (and arguably 14) are integration-verified but not end-to-end manually verified because the app has no "force this subtask to fail" affordance. A debug-only fault injection surface (`force_fail_next`, `force_ceiling_exceeded`) would let Phase 4+ ship manual verification for the whole acceptance list. Estimate: 1 day, pays itself back within the phase.

## Open debt carried into Phase 4

Tracked in `docs/KNOWN_ISSUES.md`:

- Interactive agent Q&A not supported (Phase 4 target, functional)
- Merge conflict resolution UX (Phase 4, functional — surfaces conflicts but offers no resolution path)
- Base-branch dirty guard is all-or-nothing (Phase 4, functional)
- Flaky `replan_happy_path_accepts_replacement_and_reaches_done` (monitor; didn't recur in Step 9)
- Worker card expand affordance — partial progress (cancel button + height overrides landed); inline log expansion still deferred
- Worktree path inspection from UI — still open; Layer 3 "Manual fix" opens the editor but doesn't surface the path elsewhere

None of these block Phase 3 shipping.

## Scoreboard

- 15 / 15 acceptance criteria: **PASS** (11 manual, 4 integration-verified — see `docs/phase-3-spec.md` verification tally)
- Frontend tests: **492 / 492**
- Rust tests: **290 / 290** (`detection::tests::version_parse_falls_back_when_stdout_has_no_semver` is a known timing-flake at 3s timeout; reruns clean)
- `tsc --noEmit`, `eslint`, `cargo clippy -- -D warnings`: **clean**
- Layer 1 retry: **verified end-to-end** against real Claude workers
- Layer 2 replan: **verified end-to-end** with forced double-failure input
- Layer 3 escalation: **integration-verified** (skip cascade, manual-fix editor launch, abort)
- Auto-approve: **verified end-to-end** (bypass), **integration-verified** (ceiling + escalation honor)

Phase 3 ships.
