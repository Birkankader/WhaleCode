# Phase 3.5 retrospective — usability patches

**Shipped:** 2026-04-21 at `a2be333 Merge pull request #8 from Birkankader/phase-3.5-pan-fix`
**Started:** 2026-04-21 at `998be29 fix(phase-3.5): cancel propagation`

Phase 3.5 was an interstitial patch batch, not a formal phase. It has no spec in `docs/` — the scope was an 8-observation list the user compiled after running real tasks on the shipped Phase 3 build. Everything moved from observation → triage → commit → gates → PR inside a single working day.

## Duration vs estimate

| | Estimate | Actual |
|---|---|---|
| Calendar | 1–2 days | same day (2026-04-21) |
| Active wall time | — | ~8 hours |
| Commits on main | — | 10 (excluding 3 merge commits) |
| PRs | — | 3 (`#5`, `#6`, `#8`) |

## The 8 observations → outcome

| # | Observation | Verdict | Commit |
|---|---|---|---|
| 1 | Cancel leaves grandchildren orphaned (MCP servers keep stdout open; run hangs in Running while UI has dismounted the button) | **fixed** | `998be29` |
| 2 | Master is silent during planning — the UI looks frozen on slow providers | **fixed** (10s heartbeat + future streaming hook) | `acedc10` |
| 3 | Gemini-as-master is unusably slow (~230s TTFB vs claude's ~4s) | **deferred** — benchmarked, no 1-line fix exists; TTFB == total rules out streaming | `9f2e464` + KNOWN_ISSUES |
| 4 | Zoom range too tight (minZoom 0.4 / maxZoom 2.5 missing; no Controls; no keyboard) | **fixed** — zoom bounds widened, Controls added, `+`/`-`/`0` wired | `d600789` |
| 5 | Unticked proposed workers read identical to ticked ones; dense plans look like every subtask is queued | **fixed** (50% opacity + neutral-gray border on node + in-edges) | `6bd3657` |
| 6 | No per-subtask diff visibility — user has to wait for aggregate DiffReady to see what each worker touched | **fixed** (per-subtask diff event + "N files" chip + popover) | `acedc10` |
| 7 | TopBar repo chip doesn't show branch; external `git checkout` is invisible from canvas | **fixed** (branch after middle-dot, repoll on window focus) | `e3d367d` |
| 8 | CI Frontend job broken — trying to run `npm ci` against a pnpm-only repo | **fixed** (switched to pnpm/action-setup v4) | `5723c15` |

7 / 8 shipped fixes, 1 deferred with a written rationale. 

## Self-inflicted regression surfaced within the phase

Commit 4 (`d600789` Item 4, zoom bounds) flipped React Flow to scroll-to-zoom, thinking "keyboard covers pan." Real usage surfaced the failure mode: with 6+ subtasks the canvas has almost no empty space, every drag starts on a node, and `nodesDraggable={false}` isn't enough — RF's hit-test still eats the gesture before panOnDrag inherits. User effectively couldn't pan once the plan fanned out.

Reverted in `46fa740` (PR #8). Net-zero code change from Phase 3's pre-zoom-bounds state for scroll behaviour (scroll pans, Cmd+scroll zooms, pinch zooms), but kept the useful additions from commit 4: widened zoom bounds (0.4 ↔ 2.5), Controls component, keyboard +/-/0. The mistake was assuming "scroll-to-zoom" matched user expectation because it matched Figma; in fact it matches Figma with Cmd, and naked scroll-to-zoom is the Excel model, which fits a spreadsheet but not a continuously-positioned graph.

Worth a lesson of its own (#2 below).

## What went well

- **Observation → ship in a single day.** The 8-observation format (one-line concern, no spec) worked because every item was narrow enough that the triage itself produced the design. Nothing needed a second design pass; everything had a reviewable diff within an hour of the decision to ship it.
- **Three-layer cancel fix landed cleanly.** Process group kill (Unix), bounded pipe drain, dispatcher drain deadline — each layer added independently, each independently testable. No coupling. Cancel hang on a worker with MCP grandchildren is the kind of bug that would have recurred across Phase 4 retries; getting it right once closes a whole class.
- **Heartbeat instead of full log streaming.** Item 2 could have been plumbing `log_tx` through every `AgentImpl::plan` implementation (estimate: 300 LOC across 4 adapters). Instead, `lifecycle.rs` emits a `MasterLog` tick every 10s showing elapsed seconds. Fast Claude plans (~4s) emit nothing; slow Gemini plans (~230s) emit ~23 heartbeats. Same UX outcome as full streaming, ~30 LOC. Phase 3.5 shouldn't have been the place to re-architect agent adapters.
- **Per-subtask diff event ordering invariant was easy to lock in.** The apply path emits `SubtaskDiff` per done worker *before* folding into the aggregate `DiffReady`. One orchestration test snapshots events and asserts the order — covers the entire contract. That pattern (emit-before-aggregate + order-invariant test) should carry into Phase 4 for any new multi-step event.
- **Gemini benchmark was a measurement spike with a fork, not a fix-it-or-bust.** The decision up front was "1-line fix lands in 3.5; otherwise it goes to KNOWN_ISSUES with mitigations enumerated." The benchmark found TTFB == total, so no 1-line fix exists, so it went to KNOWN_ISSUES with three mitigations and a workaround. Cheap discovery, no sunk cost.
- **CI pnpm fix discovered proactively.** Nobody would have seen the broken Frontend CI job until a PR hit it. The catch came from routine `gh pr view` during Phase 3 closeout — worth continuing that habit.

## Lessons for Phase 4

1. **Hit-test density changes the right default.** Commit 4 assumed "scroll=zoom, drag=pan" was safe because React Flow supports both. It is safe only when the canvas has reliable empty space. Defaults that work on a sparse graph can be wrong on a dense one; the tell is "can the user complete this gesture when the plan has 6 subtasks?" If the answer requires aiming for gaps, the default is wrong. Record this in the UX flows doc before Phase 4 starts.
2. **"Matches tool X" is not a rationale — "matches tool X in context Y" is.** The scroll-to-zoom flip was sold to itself as "Figma does this." Figma does this *with Cmd*. Excel does naked scroll-to-zoom on a spreadsheet. A graph canvas is closer to Miro/Maps/Google Maps (scroll pans, Cmd+scroll zooms) than to Figma. Always qualify the comparison with what the comparison tool actually does in the analogous case.
3. **Measurement spikes with a fork are the right shape for upstream-vendor concerns.** Item 3 (Gemini) was the only observation that couldn't be fixed in a WhaleCode commit. Framing it as "spike + fork" prevented the natural pull to "just add a timeout / a retry / a caching layer" — none of which change the 230s steady state. Apply the same pattern next time an observation smells like "the provider is slow / flaky": benchmark, enumerate mitigations, pick, or defer with rationale.
4. **A review cycle is worth two commits, not a whole revision branch.** PR #5 and PR #6 each landed a first pass, then a follow-up commit addressing Copilot findings (`c1fce19`, `cf37416`). Both follow-ups were short (≤ 40 LOC, ≤ 3 files) and caught real bugs that tests missed — bubble-phase click ordering, JSDOM `var(...)` shorthand parsing, missing `role="dialog"`. Don't skip the review pass; it paid back its ~20-min cost twice this phase.
5. **Even short patch phases warrant a retro.** This phase was 10 commits in one day, and still accumulated five lessons worth writing down. The cost of the retro is 30 minutes; the cost of not writing it is Phase 4 re-discovering lesson #1 via a second pan regression.

## Open debt carried into Phase 4

Tracked in `docs/KNOWN_ISSUES.md`:

- Gemini CLI too slow to use as master (benchmarked; three mitigation paths enumerated; decision deferred to Phase 4)
- Windows cancel cleanup — process-group kill is Unix-only; Windows needs a Job Object (target: v2.5)
- Flaky `replan_lineage_cap_escalates_after_chained_replans` — sibling of the Phase 3 replan flake, same shape (target: monitor)
- All Phase 3 debt items remain (conflict resolution UX, base-branch dirty helper, interactive Q&A, worker card expand, worktree path inspection) — none regressed, none shipped in 3.5

## Scoreboard

- 8 / 8 observations triaged: 7 fixed, 1 deferred with written rationale
- Frontend tests: **522 / 522** (+30 over Phase 3's 492)
- Rust tests: **295 / 295** (+5 over Phase 3's 290) — `detection::tests::version_parse_falls_back_when_stdout_has_no_semver` still flakes at 3s timeout under parallel load; single-threaded clean
- `tsc --noEmit`, `eslint`, `cargo clippy -- -D warnings`: **clean**
- CI: both jobs green on every PR in this phase
- Self-inflicted regression caught + fixed before closing: **1** (commit 4 scroll direction → pan fix #8)

Phase 3.5 closes. Phase 4 kickoff next.
