# Phase 6 retrospective — real-time partnership

**Shipped:** 2026-04-27 at this close-out commit (verification +
retro + KNOWN_ISSUES + CLAUDE.md sync).
**Started:** 2026-04-26 at `a426fdd docs(phase-6): spec draft`.

## Duration vs estimate

| Metric | Spec budget | Actual |
|---|---|---|
| Calendar time | 8-10 days | ~1.5 days (2026-04-26 → 2026-04-27) |
| Active dev time | — | ~5-6 hours across two sessions |
| Commits on `main` | — | 5 between `a426fdd..9e5792a` (spec, Step 0, Steps 2/3/4) + 1 close-out |

Spec budgeted 9-10 days (Step 0 1.5-2d, Step 2 2.5-3d, Step 3
1.5-2d, Step 4 2-2.5d, Step 5 1-1.5d). Actual came in at roughly
1/8 of the calendar budget. Same compounding pattern as Phase 5
(14d → 1d), Phase 4 (16-18d → 2.5d), Phase 3 (2-3w → 2.5d). The
cost-model gap is no longer a surprise; it's a load-bearing fact
about this style of work in this repo.

Two reasons Phase 6 came in *faster* than even Phase 5:

- **Step 0 spike pattern, third consecutive validation.** Phase 4
  (crash-shape diagnostic), Phase 5 (Q&A capability diagnostic),
  Phase 6 (tool-use parsing diagnostic) all front-loaded the
  adapter-divergence question and saved the planning-then-rework
  loop on the largest implementation step. Phase 6 spec
  explicitly leaned on this — Step 0 was budgeted at 1.5-2d and
  came in at ~1.5h. The unified `ToolEvent` proposal it produced
  required zero refinement during Step 2 implementation.
- **Phase 5 infrastructure reuse paid significant dividends in
  Step 4.** `restart_with_extra` was already 90% built as the Q&A
  re-execute branch in `resolve_qa_loop`. Step 4's actual work
  was: extract the helper, add a new IPC, add a frontend input,
  add CancelDecision priority logic. No new orchestration
  pattern. The 2-2.5d spec estimate landed at ~1h.

## Step-by-step timing

| Step | Description | End commit | Duration |
|---|---|---|---|
| 0 | Tool-use parsing diagnostic (matrix + fixtures) | `78d6fa2` | ~1.5h |
| 2 | Activity chips on worker cards (parser + tee + chip stack + compression) | `4f90076` | ~1.5h |
| 3 | Reasoning / thinking surface (parser ext + ThinkingPanel + capability gating) | `ff7efec` | ~1h |
| 4 | Mid-execution hint injection (IPC + restart helper + UI + CancelDecision) | `9e5792a` | ~1.5h |
| 5 | Verification + retrospective + close-out | (this commit) | ~0.5h |

Two-session cadence. Steps 0-2 in one session, Steps 3-5 in the
next. No multi-day breaks. Each step shipped with gates green
before commit.

## Bug clusters surfaced during the phase

Lower noise than Phase 4 (three viewport-math rounds) and
comparable to Phase 5. The clusters that did surface were all
caught before commit, none post-ship.

### 1. `CancelDecision` priority — designing the right tree

The first sketch of Step 4 had hint-restart and manual-cancel
treated symmetrically — whichever flag landed first won. That
admits a race where Stop arrives during the cancel arm of a
hint-restart and the worker ends up Restarting with a hint after
the user explicitly clicked Stop. Wrong. The fix was to write the
priority tree explicitly: manual-cancel > hint-restart > Layer-1
retry, and gate it on a single `CancelDecision::resolve(reason)`
helper. The `manual_cancel` flag (Phase 5 Step 1) carried this
priority; hint just needed to defer.

Why caught before commit: the spec's "Stop-during-hint" acceptance
criterion forced an integration test, which surfaced the race in
the first run.

### 2. Activity chip compression rule — same-dir vs same-prefix

First implementation collapsed any consecutive `FileRead` chips
into "Reading N files in <common-prefix>". That worked for
`src/auth/foo.ts` + `src/auth/bar.ts` (collapses to `src/auth/`)
but produced confusing output for `src/auth/foo.ts` +
`src/utils/bar.ts` — they share `src/`, so the chip read "Reading
2 files in src/", which is technically true but visually
misleading. Fixed by tightening to "same parent dir" rather than
"longest common prefix". The 2s time-window stays unchanged.
Caught by an early `activityCompression.test.ts` case.

### 3. Capability gating — defense in depth, not just UI guard

Initial Step 3 implementation gated the thinking toggle in the
WorkerNode component only. A test that called `setShowThinking`
directly through the store (simulating a future code path that
forgets the UI guard) showed an empty ThinkingPanel rendering on
a Codex worker. Fixed by moving the gate into the store action:
`setShowThinking(workerId, on)` short-circuits if the adapter's
`supportsThinking` capability is false. Same pattern Phase 5 used
for `supportsMaster` on the master-agent fallback chain.

## What went well

- **Step 0 diagnostic, third validation.** Phase 4 + Phase 5 + now
  Phase 6 all opened with a 1-2h spike that priced out the
  adapter-divergence question before any production code landed.
  Each time the downstream step landed cleanly. This is now the
  default first move for any phase whose biggest step is
  adapter-adjacent or infrastructure-heavy. Make it a template.
- **Phase 5 infrastructure compounding.** Step 4's `restart_with_
  extra` extraction was a 1-hour task because Phase 5 Step 4 had
  already debugged the re-execute path under Q&A pressure (auth
  preservation, pending-channel cleanup, extra_context routing).
  Hint inherited a battle-tested path. Phase-over-phase reuse
  ratio keeps growing — same effect Phase 5 noted from Phase 3/4
  patterns.
- **Capability gating pattern formalized.** Phase 5 introduced
  `supportsMaster` as an adapter trait method to keep Gemini out
  of the master fallback. Phase 6 added `supportsThinking` for
  the same shape. Pattern is now boilerplate enough that Phase 7's
  candidate features (pause-resume pilot in particular) should
  use the same shape on day one — `supportsPause` gating drops
  feature-flag complexity to a per-adapter capability check.
- **Adapter divergence accepted gracefully.** Codex / Gemini have
  no thinking support; Gemini has lower activity-chip fidelity.
  Step 0 surfaced both gaps explicitly, the spec called out
  "fidelity gap acceptable" up front, and the implementation
  shipped without the temptation to retrofit unsupported features
  with brittle heuristics. Compare to a counterfactual Phase 6
  that tried to fake Codex thinking — that path leads to false
  empty panels and user trust erosion.
- **Spec scope discipline before kickoff.** The original Phase 6
  draft proposed 8 steps including outcome summaries, diff
  explanations, cost wiring, and a Claude pause-resume pilot.
  Trimmed to 5 steps (3 features + diagnostic + verification)
  before Step 0 fired. Cost-aware features clustered into
  Phase 7 to avoid mode-swap risk in Phase 6. The trim was the
  most impactful single decision in the phase — it removed the
  one part that needed its own diagnostic step (interactive-mode
  swap) and kept Phase 6's pace at 1/8 calendar budget.

## Lessons for Phase 7+

1. **Budget Step 0 in hours, not days.** Phase 4-6 evidence: every
   Step 0 came in at 1-2h vs 1.5-2d spec. Phase 7's diagnostic
   (interactive-mode swap for pause-resume) should budget
   accordingly. If it grows past 4h, that's a signal the
   feature is fundamentally bigger than the spec assumed.
2. **Capability gates on day one.** Any new adapter-divergent
   feature should land its capability flag (`supportsX`) in the
   adapter trait in the same step that introduces the feature,
   with the store action gating on the capability, not just the
   UI. Phase 6 Step 3 retrofitting the gate was cheap because the
   pattern existed; on a colder feature it's a full bug surface.
3. **Spec trim before kickoff is the highest-leverage move.**
   Phase 6's 8 → 5 step trim saved more time than any single
   implementation decision in the phase. Future phases: list all
   candidates, identify mode-swap or LLM-cost surfaces, cluster
   them, and commit to *one* coherent sub-scope per phase.
   Cost-aware features as a Phase 7 cluster is the model.
4. **`restart_with_extra` is the universal mid-flight intervention
   primitive.** Q&A re-execute and Hint re-dispatch share it.
   Phase 7's pause-resume pilot (if it ships) will likely *not*
   use it (true pause needs adapter mode swap, not restart). But
   any Phase 7 feature that's "user nudges a running worker
   without paradigm shift" should reuse `restart_with_extra`
   directly.
5. **Adapter divergence is the spec's job to surface, not the
   implementer's job to paper over.** Step 0 should explicitly
   produce a "fidelity gap" line for each criterion that doesn't
   apply to all adapters. Phase 6 did this for Codex / Gemini
   thinking and Gemini chip fidelity. Saved retrofitting work.

## Open debt carried into Phase 7 (suggestions, not commitments)

Tracked in `docs/KNOWN_ISSUES.md`. Phase 7 candidates are listed,
not committed — spec writes after real-usage data from Phase 6's
shipped surface:

- **Cost-aware feature suite cluster.** Per-worker outcome
  summaries (heuristic + semantic), diff content explanations,
  Claude pause-resume pilot, cost dashboard foundation. Coherent
  sub-scope around LLM-cost user actions; needs per-call cost
  preview, cumulative session tally, undo affordance, optional
  budget cap. Phase 6 ships zero LLM-cost surfaces by design;
  Phase 7 ships the cluster.
- **Per-worker hint counter affordance.** Risk flag from Phase 6
  Step 4 spec — "3 hints applied this session" UI to discourage
  hint loops. Defer until real-usage observation surfaces hint-
  loop pain.
- **Gemini activity-chip fidelity gap.** Heuristic regex misses
  non-verb-prefix variants. Accepted per Step 0; revisit only if
  Gemini-as-worker complaints surface.
- **Q&A false-positive heuristic calibration.** Carried from
  Phase 5 retro; still unmeasured on real-adapter runs. Phase 7
  candidate.
- **Mono-repo planning awareness.** Carried since Phase 3 retro.
  Architecture-shaping, deserves its own phase.
- **Programmatic visual regression.** Carried since Phase 3.5
  retro #4. Phase 7 pilot candidate.
- **KNOWN_ISSUES #37** flake — still monitor-only. No trip
  observed under default threading this phase.
- **Multi-agent same-task comparison.** Phase 7+ candidate.
- **Rate-limit classification + backoff.** Phase 7+ candidate.

None of these block Phase 6 shipping. No Phase 7 scope commitments
in this retro — spec writes after real-usage data on Phase 6's
shipped surfaces.

## Scoreboard

- 3 / 3 goal criteria: **PASS** (see `docs/phase-6-verification.md`)
- 18 / 18 step-level acceptance: **PASS**
- Frontend tests: **770 / 770** (target ≥ 730, exceeded)
- Rust tests: **397 / 397** (target ≥ 370, exceeded)
- `pnpm typecheck`, `pnpm lint`, `cargo clippy -- -D warnings`: **clean**
- `pnpm build`: **succeeds**
- CI green on every Phase 6 commit: verified via `git log
  a426fdd..HEAD`.

Phase 6 ships.
