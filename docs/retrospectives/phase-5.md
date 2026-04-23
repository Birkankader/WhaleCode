# Phase 5 retrospective — unblock the run

**Shipped:** 2026-04-23 at `1976b94 feat(phase-5): step 4 —
interactive agent Q&A` (plus close-out commit landing this retro).
**Started:** 2026-04-23 at `2a9cefb docs(phase-5): spec draft`.

## Duration vs estimate

| | Estimate | Actual |
|---|---|---|
| Calendar | 2 weeks / ~14 days | ~1 day (2026-04-23 single-day cadence) |
| Active wall time | — | ~5-6 hours across one session |
| Commits on `main` | — | 6 between `2a9cefb..1976b94` (spec, Step 0, Steps 1–4) + 1 close-out |

Spec budgeted 14 days (Step 0 1.5d, Step 1 2d, Step 2 2d, Step 3
2.5d, Step 4 4.5d, Step 5 1.5d). Actual came in at roughly 1/10 of
the calendar budget. Same pattern as Phase 4 (~16-day estimate /
~2.5 days actual) and Phase 3 (~2-week estimate / ~2.5 days
actual). Phase 2-4-5 cadence now consistent enough that the spec
cost-model is the thing that's off, not the phase work.

Two compounding reasons this phase landed faster than even Phase
4's ratio predicted:

- **Step 0 spike pattern validated for the third time.** Phase 4's
  crash-shape diagnostic collapsed Step 5 from ~3d to ~1d by
  picking the event-field branch. Phase 5's Q&A capability
  diagnostic collapsed Step 4 from 4.5d to ~1.5d by finding the
  universal restart-with-appended-prompt path (no adapter branch
  needed). This is now a repeatable leverage pattern.
- **Pattern reuse from Phases 3/4.** Step 1's composite-cancel
  token reuses Phase 3's per-run token + Phase 4's process-group
  kill. Step 2's banner + in-flight flag mirrors Phase 4's
  WorktreeActions pattern. Step 3's popover reuses Phase 4's
  modal-style overlay convention. Step 4's event-field
  discriminant mirrors Phase 4 Step 5's crash classification. No
  step required inventing a new orchestration pattern from
  scratch.

## Step-by-step timing

| Step | Description | End commit | Duration |
|---|---|---|---|
| 0 | Q&A capability spike (diagnostic + fixtures) | `b3efa32` | ~2h |
| 1 | Per-worker stop (dispatcher + UI) | `4183d75` | ~1h |
| 2 | Base-branch dirty helper | `4906765` | ~1h |
| 3 | Merge conflict resolver UX | `96b2397` | ~1h |
| 4 | Interactive agent Q&A | `1976b94` | ~1.5h |
| 5 | Verification + retrospective + close-out | (this commit) | ~0.5h |

Single-day cadence. No overnight breaks (unlike Phase 4's three-
day clock). Each step's scope was small enough to finish in one
focused session with gates green before commit.

## Bug clusters surfaced during the phase

Fewer than Phase 4 (which had 3 clusters in its closeout) and
Phase 3 (six). Phase 5's cluster shape was "semantic distinctions
that would have broken prior contracts if missed":

### 1. `RetryReason::Conflict` vs `::DirtyBase` — event contract preservation

**Symptom during Step 3 tests:** Step 2's tests (which emit
`BaseBranchDirty` → `stash_and_retry_apply` → merge) started
failing after Step 3 added the `MergeRetryFailed` event path. The
`apply_step` conflict branch was incrementing the retry counter
on *every* Retry outcome — including dirty-base retries.

**Fix (inside Step 3's commit):** Split `MergeStepOutcome::Retry`
into `Retry(RetryReason)` where `Conflict` bumps the counter and
`DirtyBase` doesn't. Dirty-base retries go through Step 2's
distinct user flow; they're not "still conflicted (attempt N)"
events semantically.

**Lesson:** a retry counter is only meaningful within one retry
cause. Before adding multi-cause retry counters, split the cause
discriminant first.

### 2. ScriptedAgent HashMap insert-overwrite vs queue

**Symptom during Step 4 tests:** Q&A tests failed because
`.with_execute("t0", question).with_execute("t0", answer)` only
kept the second script — HashMap `.insert()` overwrites. First
execute returned the "answer" summary with no question; detection
didn't fire.

**Fix:** added `with_execute_sequence` helper that queues per-title
scripts FIFO. Popped front on each `execute()` call; empty →
fallthrough to HashMap path.

**Lesson:** test fixtures with per-call behavior need queues, not
maps. One-line to document, but the default HashMap intuition
cost 15 minutes of debugging.

### 3. approve_all awaits Merging; Q&A parks before Merging

**Symptom during Step 4 tests:** every Q&A test timed out at
`approve_all`'s `await_status(Merging)` because the run was parked
in `AwaitingInput`, not reaching Merging until after the answer.

**Fix:** added `approve_only` helper that waits for `Running` only,
leaves the Merging transition to the test body.

**Lesson:** test helpers that over-specify terminal states lock
out phases that introduce new intermediate states. Keep helpers
tight to what they must assert.

## What went well

- **Step 0 diagnostic pattern, third-time validation.** Phase 4's
  crash-shape and Phase 5's Q&A-capability diagnostics both
  shrunk the rest of the phase materially (~3d → ~1d; ~4.5d → ~1.5d
  respectively). The write-up stays cheap and the downstream steps
  start with the right architectural assumption. Worth making a
  template pattern for any future phase whose biggest step has
  uncertain adapter / infra dependencies.
- **Theme proved correct again.** Phase 4's retro validated
  "visibility" against real user pain via Phase 3 retro + 3.5
  observations. Phase 5's "unblock the run" was written against
  already-flagged KNOWN_ISSUES items (conflict UX, base-branch
  dirty, Q&A, per-worker stop — all four had severity `functional`
  before we started). Success criteria mapped to real complaints,
  not invented scope.
- **Pattern reuse accelerates each step.** None of the four shipped
  steps invented new orchestration architecture. Composite tokens,
  in-flight flags, portal popovers, event-field discriminants,
  pending-channel maps, oneshot parks — all had Phase 3/4
  precedents. Estimation should lean on pattern-reuse ratio from
  here on.
- **ScriptedAgent test fixture paid compound interest.** Phase 3's
  retry ladder tests used `fail_attempts` queues. Phase 5 Step 4
  extended to `execute_sequence` queues. Same underlying pattern,
  different variant. Add-only changes to the fixture have zero
  carry cost for prior tests.
- **Single-commit-per-step discipline held.** Each of 4 functional
  steps landed in one commit — no "fix follow-up" churn like Phase
  4's three height-tier bounces. Probably because Phase 5's scope
  items were backend-plus-contained-UI; no viewport math, no
  stacking-context traps.

## Lessons for Phase 6+

1. **Step 0 spike is now the default first move for big-uncertainty
   steps.** If Phase 6 has a scope item that feels adapter-adjacent
   or infrastructure-heavy (monorepo planning, cost tracking wire
   shape, safety-gate policy), front-load a 1-2 hour spike before
   locking the plan. Two consecutive phases where this saved ~70%
   of the planned budget is enough evidence.
2. **Spec estimates remain ~10× too high for this cadence.** Phase
   5 spec said 14 days; actual was one working day. Phase 4 said
   16-18 days; actual was ~2.5 days. Phase 3 said 2-3 weeks; actual
   was 2.5 days. Either the spec cost model is consistently wrong
   for this style of work, or we've built enough patterns that the
   marginal phase is small. Phase 6's spec should budget in half-
   days and pad explicitly for verification — not pad the
   implementation.
3. **Heuristic detection calibration is real debt if users report
   noise.** Step 4's `detect_question` is intentionally
   conservative: last non-empty line ends in `?`. False-positive
   rate unmeasured on real adapter runs — the Skip affordance is
   the escape hatch. If Phase 6 opens with user complaints about
   spurious AwaitingInput states, calibrate (add question-word
   start requirement) before anything else. If no complaints
   surface, leave it.
4. **Retry counters must be scoped to cause.** The `RetryReason`
   split from Step 3 surfaced late in testing. When the next phase
   adds a new retry / redo loop, start with the cause enum.
5. **Test-fixture queues > HashMaps for scripts.** Add-to-fixture
   cost is tiny; the debugging cost of insert-overwrite
   surprise is not.
6. **approve_only-style helpers over approve_all for phases that
   introduce intermediate states.** Generalize: every phase that
   adds a new non-terminal state should audit existing test
   helpers that over-specify "run reaches Merging" — helpers
   should only assert what they need to.

## Open debt carried into Phase 6 (suggestions, not commitments)

Tracked in `docs/KNOWN_ISSUES.md`. Phase 6 candidates are *listed*,
not committed — spec writes after real-usage data from the shipped
Phase 5 surface:

- **Q&A false-positive calibration.** Universal heuristic. Measure
  on 10-task real-adapter run; tighten if FP rate > 5%.
- **Claude interactive-mode stdin injection.** Deferred per Step 0
  recommendation. Revisit if output-divergence on answer restart
  becomes user-reported.
- **Base-branch terminal affordance in conflict resolver.** Small
  IPC addition + UI button. Not shipped in Phase 5 because per-
  worker Reveal covered the primary use case.
- **KNOWN_ISSUES #37 flake** still trips under full parallelism.
  Ran Phase 5 gates at `--test-threads=4` as the workaround.
  Investigate only if trip rate increases.
- **Mono-repo planning awareness.** Carried from Phase 3/4 retros.
  Phase 6 or later.
- **Cost tracking wiring.** Phase 6.
- **Rate-limit classification + backoff.** Phase 6 or later.
- **Safety gate real policy.** Phase 7.
- **Windows cancel cleanup.** v2.5.
- **Programmatic visual regression.** Phase 3.5 retro → Phase 4
  retro → still manual text observations in Phase 5. Worth a
  Phase 6 pilot.

None of these block Phase 5 shipping. No Phase 6 scope commitments
in this retro — spec writes after real-usage data on Phase 5's
shipped surfaces.

## Scoreboard

- 5 / 5 goal criteria: **PASS** (see `docs/phase-5-verification.md`)
- 25 / 25 step-level acceptance: **PASS**
- Frontend tests: **705 / 705** (target ≥ 660, exceeded)
- Rust tests: **360 / 360** (target ≥ 340, exceeded)
- `pnpm typecheck`, `pnpm lint`, `cargo clippy -- -D warnings`: **clean**
- `pnpm build`: **succeeds**
- CI green on every Phase 5 commit: verified via `git log
  2a9cefb..HEAD`.

Phase 5 ships.
