# Phase 4 retrospective — build trust through visibility

**Shipped:** 2026-04-23 at `56f5925 fix(phase-4): content-fit expanded worker card height`
**Started:** 2026-04-21 at `60e4199 docs(phase-4): spec draft`

## Duration vs estimate

| | Estimate | Actual |
|---|---|---|
| Calendar | 2 weeks (~16 days UI-only Step 5 path) | ~2.5 days (2026-04-21 → 2026-04-23) |
| Active wall time | — | ~4 hours across three working sessions |
| Commits on `main` | — | 12 between `60e4199..56f5925` |

The spec cost estimates were **significantly over**. A fair read: most steps landed in ~25-50% of the budgeted days. Step 6 (budgeted large, 4-5 days) landed in two commits inside a 25-minute window. Step 7 (verification, budgeted 1.5 days) landed in one afternoon. Two plausible reasons:

- The phase was heavily UI / additive. No migrations, no new `SubtaskState` variant, no XState refactor. The spec over-weighted "medium" and "large" because Phase 3's medium steps (retry ladders, machine rewrites) were genuinely that size; Phase 4's surfaces weren't.
- Step 5 picked the event-field branch from the Step 0 diagnostic, which shrank the spec's "full" 3-day estimate to a ~1-day reality. Step 0's 2-day cap would have trimmed the estimate to 16 days even without this collapse; with it, the real ceiling was closer to 10 days and came in at 3.

## Step-by-step timing

| Step | Description | End commit | Completed (local) | Duration |
|---|---|---|---|---|
| 0 | Crash-shape diagnostic + fake-agent fixtures | `d58c72c` | 2026-04-21 20:22 | — |
| 1 | Gemini worker-only restrict | `137bb99` | 2026-04-21 20:42 | 20 min |
| 2 | Apply summary overlay | `4d01691` | 2026-04-21 21:15 | 33 min |
| 3 | Worker log expand | `3c14aa7` | 2026-04-21 21:32 | 17 min |
| 4 | Worktree inspection affordances | `cc4272f` | 2026-04-21 21:56 | 24 min |
| 5 | Crash surface (event-field branch) | `cd902b7` | 2026-04-22 15:53 | (overnight break) |
| 6a | `FileDiff` wire extension (status + unifiedDiff) | `7c0abdd` | 2026-04-22 16:01 | 8 min |
| 6b | DiffPopover + Shiki + virtual scroll | `6494276` | 2026-04-22 16:16 | 15 min |
| Fix 1 | log expand height, worktree menu z-index, diff context | `787ed01` | 2026-04-23 01:00 | (overnight break) |
| Fix 2 | expanded worker height 420 → 340 | `5f42b74` | 2026-04-23 01:08 | 8 min |
| Fix 3 | content-fit expanded height | `56f5925` | 2026-04-23 01:16 | 8 min |
| 7 | Verification + retrospective + close-out | (this commit) | 2026-04-23 | — |

Three visible clusters: initial burst (Steps 0-4, 2026-04-21), Step 5-6 pair (2026-04-22), closeout fixes (2026-04-23 early-morning). The middle break between Step 4 and Step 5 was the Step 0 diagnostic's payoff — the event-field branch decision had already been baked in, so Step 5 was mostly a wire-contract extension + copy table.

## Bug clusters surfaced during Step 7 and post-ship

Phase 4 had fewer closeout bugs than Phase 3's six-cluster tail, and the cluster shape was different — less "logic gap" and more "viewport math."

### 1. Expanded worker card too tall — **viewport math, three rounds**

**Symptom rounds:**
- Round 1: spec shipped 560px; user reported card past the viewport on a 14" laptop (~800px usable).
- Round 2: dropped to 420; still pushed the merge/final node off-screen, user sent screenshots.
- Round 3: dropped to 340; still felt empty on "Waiting for output…" cards.

**Fixes:** `787ed01` → 420, `5f42b74` → 340, `56f5925` → content-fit `[200, 340]` based on actual log-line count subscribed from `nodeLogs`.

**Root cause:** the spec's Open Questions had locked "560 does NOT scale to viewport" without also locking a viewport budget. The stack math (marginy + master + ranksep + card + ranksep + final + marginy) was never written out until the verification pass; once it was, the ceiling fell out trivially. The content-fit conversion closed the other end — a ceiling-only rule paints a dead log area when the worker hasn't produced output yet.

**Lesson (reinforces Phase 3 #4):** any height tier whose stack fits inside a known viewport needs the stack math explicit in the spec, not just the per-node pixel choice. And any "fixed height" affordance should be sanity-checked against the empty case before shipping — the floor matters as much as the ceiling.

### 2. WorktreeActions menu clipped by merge card — **stacking context trap**

**Symptom:** Menu items on the far right of the menu overlapped the merge/final card a row below and weren't clickable.

**Fix:** `787ed01` → `createPortal(menu, document.body)` with fixed-position coordinates from a `useLayoutEffect`-computed `triggerRef.getBoundingClientRect()`.

**Root cause:** React Flow wraps every node in a `transform`-ed div, which creates a stacking context. A `z-50` inside that context still paints below sibling nodes' content when the container is also `transform`-ed. Portaling out of the node tree is the only robust fix; raising `z-index` within the node does nothing.

**Lesson:** React Flow's transform-per-node creates a stacking context for every node. Any popover / menu / tooltip that needs to escape a node's bounding rect must portal to `document.body`. Future nodes with their own menus (Phase 5 conflict resolution, for example) should inherit this pattern — don't rediscover it per-menu.

### 3. Diff context too sparse — **one-line flag**

**Symptom:** Single-line changes showed no surrounding context, making it hard to read why the change was there.

**Fix:** `787ed01` → `git diff -U10` instead of the default `-U3`.

**Root cause:** default git-diff context is optimised for terminal review where you can re-run with a different `-U`. In an inline popover that's not an option. `-U10` is cheap (backend already has the full file; `sqlx` payload is unchanged shape).

**Lesson:** when wrapping a CLI tool for a UI, default flags optimised for terminal use are rarely the right UI default. Audit them in the same pass as the UI design.

## What went well

- **Step 0 diagnostic paid for itself.** The "UI-only vs full-branch" decision for Step 5 saved 1-2 days of `SubtaskState` refactor work that would have touched SQLite schema, XState, and every frontend guard. Event-field branch was obvious once the diagnostic was written; shipping without the diagnostic would have nearly certainly chosen the bigger branch.
- **Shiki bundle architecture validated.** The lazy-load pattern (grammar per-language, WASM via `shiki/wasm`, body via `React.lazy`) landed the main bundle at +2.44 kB raw / +0.98 kB gzipped — under the 5 kB budget with margin. No accidental eager imports, no main-bundle bloat. Worth reusing in Phase 5 for any similarly heavy dependency (e.g., a monaco-style editor if conflict resolution needs one).
- **Phase theme proved correct.** "Visibility" wasn't a guess — the Phase 3 retro and Phase 3.5 observations had already pinned the top pains (invisible Apply, truncated logs, inscrutable crashes, hidden worktree paths). Each of the six success criteria matched a real complaint from earlier phases. No scope invented for its own sake.
- **Portal-for-stacking-context discovered early.** The merge card z-index bug surfaced during the post-Step-6 verification pass, which is earlier than Phase 3's equivalent pattern (that one got caught post-release). The fix was one file, one commit.
- **Content-fit height was a user-driven refinement.** The spec locked "fixed 560". Three rounds of user screenshots drove it to content-fit `[200, 340]`. The final shape is better than the spec's original — and the spec explicitly asked for this kind of feedback to override the letter.

## Lessons for Phase 5

1. **Budget viewport math into every height-touching spec.** Write out the full stack: marginy + master + ranksep + *row* + ranksep + final + marginy. Compare against a target 800px usable laptop viewport. If the math doesn't fit, ship content-fit, not fixed.
2. **Every menu / popover on a React Flow node must portal to `document.body`.** Add this to the React Flow notes in CLAUDE.md (or a new `docs/rf-stacking-context.md` snippet). Don't wait for each new menu to rediscover it.
3. **User verification catches what unit tests miss — budget for it.** Three of Phase 4's closeout fixes (expand height, z-index, diff context) were caught by a human on a screen. Unit tests passed through all three. Phase 5 should keep a dedicated "real user on real hardware" slot in the verification step, not just integration test coverage.
4. **Step 0-style diagnostics are cheap and high-leverage.** Phase 3 and Phase 4 both used them; both saw the rest of the phase shrink. Phase 5 (conflict resolution, base-branch dirty helper, interactive Q&A) is a candidate — a diagnostic spike on "what does a conflict look like in the current code path" could preempt a week of design churn.
5. **Spec estimates in days are routinely 2-3× too high for UI-heavy phases.** Phase 4 budgeted 16-18 days; landed in ~2.5. Phase 3 budgeted 2-3 weeks; landed in 2.5 days. Either the spec's cost model is broken for UI work, or Phase 5+ should budget in half-days and pad explicitly for verification — not pad the implementation.
6. **Lazy-load patterns are reusable, not bespoke.** The Shiki chunking approach (dynamic grammar imports + React.lazy'd heavy component + WASM via subpath export) generalises. Document the pattern in `docs/` if Phase 5 needs it — it's too good to re-discover.

## Open debt carried into Phase 5

Tracked in `docs/KNOWN_ISSUES.md`. Phase 5 candidates (not commitments — spec writes after real-usage data):

- **Merge conflict resolution UX** — Phase 4 kept the Phase 3 surface (banner + worktree preserved); no new resolution affordances.
- **Base-branch dirty stash helper** — still all-or-nothing.
- **Interactive agent Q&A channel** — still deferred; workaround remains "frame tasks specifically."
- **Gemini latency fix** — Phase 4 subtracted Gemini from the master picker; upstream latency fix not attempted.
- **Mono-repo awareness in planning** — carried from Phase 3 retro; not touched in Phase 4.
- **Debug-only failure injection** — Phase 3 Lesson #6; still open; would simplify Phase 5+ verification.
- **Programmatic visual regression** — Phase 3.5 Lesson #1; still open. Phase 4's manual-text-observation approach worked but scales poorly.
- **React Compiler warning on `useVirtualizer`** — pre-existing lint warning on Phase 4's `DiffBody`; not actionable until upstream rule change.

None of these block Phase 4 shipping. No Phase 5 scope commitments in this retrospective — spec writes after user runs real work on the shipped Phase 4 surface.

## Scoreboard

- 6 / 6 goal-criteria: **PASS** (see `docs/phase-4-verification.md`)
- 7 / 7 shipped-step acceptance: **PASS**
- Frontend tests: **630 / 630** (target ≥ 630)
- Rust tests: **325 / 325** (target ≥ 325)
- `pnpm typecheck`, `pnpm lint`, `cargo clippy -- -D warnings`: **clean**
- `pnpm build`: **succeeds** — main bundle +2.44 kB raw / +0.98 kB gzipped over Phase 3.5 baseline; Shiki + virtual-scroll deps split into async chunks.
- CI green on every Phase 4 commit: **verified** via `git log 60e4199..HEAD`.
- Apply summary integration test: **GREEN**
- Crash category round-trip integration tests (6 × 1): **GREEN**
- `SubtaskDiff.unifiedDiff` payload test: **GREEN**

Phase 4 ships.
