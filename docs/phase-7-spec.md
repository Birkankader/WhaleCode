# Phase 7: Information density without UI weight

> **Phase 7 shipped 2026-05-04** at the Step 8 close-out commit. First Phase 7 commit `5ebbff4` (2026-05-03). 5/5 goal criteria PASS, 33/33 step-level acceptance PASS — see `docs/phase-7-verification.md` and `docs/retrospectives/phase-7.md`.

**Goal:** Bring conversational-AI UI patterns (Cursor / OpenCode style) into WhaleCode's multi-agent graph paradigm. The user must see more about what each worker is doing — at any moment in the run lifecycle — without adding new panels, modals, or chrome. Every new surface in this phase replaces or absorbs an existing one rather than stacking on top.

**Theme:** *Information density without UI weight.* Phase 4 shipped visibility as new surfaces (overlay, popover, footer menu). Phase 5 shipped unblock as new affordances (banner action, input fields). Phase 6 shipped real-time partnership as inline panels (chip stack, thinking, hint input). Phase 7 inverts the direction: take what Cursor / OpenCode get right about information density (always-visible diffs, per-action affordances, checklist progress, elapsed counters, conversational follow-up) and adapt them into WhaleCode without growing the UI footprint.

**Design philosophy — read this before any implementation choice:**

The Cursor/OpenCode reference UI works because every pixel earns its place. There are no decorative containers, no panels-around-panels, no modals when an inline element would do. Every new surface in Phase 7 must answer two questions:

1. **What existing surface does this replace or absorb?** If it adds without removing, reject the design.
2. **Is the information visible by default, or behind a click?** Information that the user actively wants should be visible. Information that exists for completeness should be click-revealed.

Phase 7 ships zero new modal dialogs. Phase 7 removes at least one existing modal (DiffPopover) by absorbing it into a different surface. Phase 7 does not add any new persistent panels, overlays, or sidebars unless they replace something.

**Duration estimate:** 18-22 days spec budget. Realistic floor 6-9 active working days based on Phase 3-6 evidence. Phase 7 is the largest spec since Phase 2 by step count and feature surface. Step 0 spike pattern still applies but cannot trim Phase 7 to Phase 5/6 cadence — there are five distinct features here, each with its own design + integration cost.

**Success criteria:**

- The user sees the unified diff for any worker's changes without opening a modal. Diff is inline-accessible from the worker card and persistent during the run, not click-only.
- A worker that has produced changes can have those changes reverted (cancel + worktree reset to base) with one click, without cancelling the run or affecting other workers.
- The master agent's plan renders as a checklist alongside the graph. Each subtask has a checkbox state (proposed → running → done / failed / cancelled) reflecting live status. The checklist is the authoritative summary; the graph is the authoritative spatial view. Both stay in sync.
- Every running worker card shows an elapsed timer (HH:MM:SS) starting from the running-state transition. Master node also shows elapsed during planning (extension of Phase 3.5 heartbeat). Cancelled / failed / done workers show final elapsed time captured at terminal-state transition.
- After a run reaches Applied or Rejected, the user can submit a follow-up task that builds on the current branch state without starting a new top-level run. Follow-up runs as an incremental sub-run, inheriting the parent run's branch + worktree base.

## Why this matters

Real-usage observations during Phase 4-6 surface the gap between "what the user wants to see" and "what WhaleCode shows by default":

- **DiffPopover is a modal** because Phase 4 Step 6 was scoped that way. Real usage shows the user wants to read the diff while the run continues — the modal blocks attention. Cursor inlines it; WhaleCode should too.
- **Cancel is the only undo.** A worker produces 30 lines of bad code; the user can stop the worker but the worktree still has those edits. The next attempt builds on dirty state. Real Cursor pattern: inline "Undo" per change-batch, surgical revert.
- **The graph is great for spatial reasoning, terrible for "what am I tracking?"** With 6 workers running, the graph is busy. A vertical checklist answers "what's done, what's pending" at a glance. Cursor's progress checklist is exactly this.
- **Elapsed time is invisible** outside the master heartbeat. Workers running for 5 minutes look identical to workers running for 30 seconds. Cursor's "Working for 1m 24s" counter is the right primitive.
- **Run termination is final.** After Apply, the user must start a new run for any follow-up. Cursor's "Ask for follow-up changes" inline input lets the conversation continue. WhaleCode's plan-approve-execute lifecycle should accommodate incremental follow-up without losing the audit trail.

## What this phase does NOT include

Defer to Phase 8:

- **Multi-agent same-task comparison.** Run two adapters on the same subtask, surface both diffs side-by-side, user picks winner. Phase 8 scope.
- **Adaptive single-vs-multi-agent execution.** Master decides task complexity, picks single-worker chat flow OR multi-worker graph flow. Phase 8 scope. Phase 7 keeps multi-agent graph as the default; Phase 8 introduces the adaptive layer.

Defer to Phase 9+:

- **Cost-aware feature suite.** Per-worker outcome summaries, diff content explanations, cost dashboard, Claude pause-resume pilot. Originally Phase 7 cluster — pushed to Phase 9 because Phase 7's UI density work needs to ship before any LLM-cost user actions get added. Order matters: density first, paid features second.
- **Mono-repo planning awareness.** Architecture-shaping; deserves its own phase.
- **Programmatic visual regression.** Carried since Phase 3 retro #4.
- **Auto-iterate on review failure.** PM-mode territory. Tech Lead modu commitment from earlier conversations precludes this.

Defer to v2.5+:

- **Chat / agent mode as separate paradigm.** Phase 8 will *adapt* the UI to single-agent task shape, but it remains the same lifecycle (plan → approve → execute → apply). True conversational mode without plan/approve gates is v2.5.
- **Continuous-interaction UI.** Phase 7's follow-up input is per-run, not persistent across runs. True continuous thread is v2.5+.
- **Background mode.** Headless server.
- **PR creation and management.**

## Prerequisites

Phase 6 shipped and stable. Specifically:

- `forward_logs` parser tee + ToolEvent enum (Phase 6 Step 2). Phase 7's elapsed timer extends the same per-worker streaming surface. Phase 7's inline diff reads from the same SubtaskDiff payloads Phase 4 Step 6 already exposes.
- `restart_with_extra` shared helper (Phase 6 Step 4). Phase 7's follow-up run reuses the appended-prompt restart pattern but scoped to a new run-level lifecycle.
- `SubtaskState::Cancelled` (Phase 5 Step 1). Phase 7's per-worker undo extends Cancelled with worktree-revert semantics.
- `ApplySummaryOverlay` (Phase 4 Step 2). Phase 7's follow-up input lives inline within or adjacent to this surface, not as a new overlay.
- `ConflictResolverPopover` (Phase 5 Step 3). Phase 7's design philosophy obligates examining whether this popover should collapse into the inline diff sidebar — see Step 4 below.

Phase 7 introduces no new SubtaskState variant. Plan checklist is a re-projection of existing subtask states; per-worker undo extends Cancelled; follow-up runs are new top-level Run records with parent_run_id reference.

## Architecture changes

Larger backend surface than Phase 6 — three new IPC commands, two new events, one schema change (new `parent_run_id` field on Run), and the ApplySummaryOverlay sees its first major rework since Phase 4. Frontend gets four new components plus the absorption of DiffPopover into a sidebar pattern.

```
Existing (Phase 6)                          Added (Phase 7)
──────────────────                          ──────────────────
Run schema                                  + parent_run_id: Option<RunId>
                                            + base_commit_sha (already exists,
                                              now read for follow-ups)

Events                                      + run:elapsed_tick
                                              (per-worker, periodic during
                                              running state)
                                            + run:followup_started
                                              (new run with parent_run_id set)
                                            + run:worktree_reverted
                                              (per-worker undo confirmation)

IPC commands                                + revert_subtask_changes(
                                                run_id, subtask_id)
                                            + start_followup_run(
                                                parent_run_id, prompt)
                                            + (follow-up reuses submit_run
                                               internals; this is a thin
                                               wrapper)

Adapter trait                               (no changes — Phase 7 is
                                             UI density work, not adapter
                                             divergence)

Frontend                                    + InlineDiffSidebar (replaces
                                              DiffPopover modal — same data,
                                              new placement)
                                            + UndoButton per worker
                                              (footer, replaces nothing,
                                              gated on hasChanges + terminal)
                                            + PlanChecklist (alongside
                                              GraphCanvas, syncs from same
                                              graphStore state)
                                            + ElapsedCounter component
                                              (per-worker, per-master)
                                            + FollowupInput (inline within
                                              ApplySummaryOverlay or
                                              successor surface)
```

Three architectural questions answered up front:

**Q1: DiffPopover modal stays, or absorbed into sidebar?**

Absorbed. The design philosophy ("zero new modals, remove at least one") is binding. DiffPopover becomes InlineDiffSidebar — same data, same lazy-load Shiki + virtual scroll, new placement. Sidebar lives on the right side of GraphCanvas, collapsible (default open during run, default collapsed after Apply). Click on a worker card's "N files" chip selects that worker's diff in the sidebar. Multi-select supported (Cmd-click to add another worker's diff to the sidebar; sidebar shows union with worker-attribution headers).

ConflictResolverPopover modal stays for now — it has modal-appropriate semantics (conflict resolution is a blocking flow, not browse-while-running). Phase 7 does not absorb it. If real usage suggests otherwise, Phase 8 candidate.

**Q2: PlanChecklist replaces graph, or coexists?**

Coexists. Graph remains the spatial view of subtask topology + dependencies. Checklist is the linear progress view. They share the same source of truth (graphStore subtask state map). User toggles between them OR sees both side-by-side depending on viewport width — wider than 1400px shows both, narrower stacks graph above checklist with a divider. Step 3 below details.

**Q3: Follow-up runs are new Run records or appended to parent?**

New Run records with `parent_run_id` foreign key. This preserves the run-history audit trail (every Run is still a discrete unit) while allowing the lineage to be traced. Visual treatment: follow-up runs render in a "thread" within the run list, indented under their parent. Parent's branch + final worktree state become the follow-up's base.

Database: new `parent_run_id` column on `runs` table, nullable, indexed for parent-lookup. Migration is additive (no schema break for Phase 6 data).

## Step-by-step tasks

Phase 7 is large. 7 implementation steps + diagnostic + verification = 9 total. Follows the established pattern: Step 0 diagnostic, Steps 1-7 features, Step 8 verification. (Phase 6 skipped Step 1 by convention; Phase 7 uses Step 1 for the biggest UI restructure to keep the numbering aligned with effort.)

**Step ordering rationale:** Frontend-heavy steps front-loaded because they're independent. Backend-touching steps (follow-up runs, undo) middle. Cross-cutting integration (checklist sync, sidebar absorption) last before verification.

---

### Step 0: UI density audit + adapter follow-up survey

Two-part diagnostic. The first part is a UI inventory: every existing surface (overlay, modal, popover, panel, chip, button) gets cataloged with its current information density score and its Phase 7 disposition (keep, absorb, replace, deprecate). The second part surveys whether agents support follow-up turns within the same conversation context (relevant for Step 5 follow-up runs — does the master agent benefit from prior conversation context, or is each follow-up a clean prompt?).

**Scope:**

- Catalog every visible UI element in WhaleCode as of Phase 6 ship state. Score each on:
  - Visibility (default-shown vs click-revealed)
  - Information per pixel (rough density score)
  - Phase 7 disposition (keep, absorb into X, replace with Y, deprecate)
- Document audit findings in `docs/phase-7-density-audit.md`. Output: a table mapping every current surface to its Phase 7 fate.
- Survey three adapters for follow-up turn semantics: does Claude / Codex / Gemini benefit from "previous context" prompts? Are there token-cost implications (resending vs caching)?
- Build fixtures in `src-tauri/src/agents/tests/followup_fixtures/` simulating follow-up turns with and without prior context, baseline tests.
- Write `docs/phase-7-followup-diagnostic.md` with per-adapter recommendation: "follow-up should resend full context" vs "follow-up is a fresh prompt referencing the prior commit SHA".

**Acceptance:**

- Density audit document with full surface table
- Follow-up diagnostic with per-adapter recommendation
- Fixtures + baseline tests committed
- Two-paragraph summary recommendations driving Steps 1-7 design choices

**Estimated complexity:** small-to-medium (2-2.5 days). Two-part diagnostic so larger than typical Step 0.

---

### Step 1: InlineDiffSidebar — absorbing DiffPopover

The largest UI restructure since Phase 4. Move all DiffPopover functionality into a right-side sidebar that's part of the main GraphCanvas layout. Sidebar persists across the run (does not modal-block) and supports multi-worker diff aggregation.

**Scope:**

- New `InlineDiffSidebar` component on the right edge of GraphCanvas. Width: 480px default, resizable via drag handle (range 320-720px). Persists user-set width to settings.
- Open/closed state per-run (default open during running state, default closed during proposed/applied/rejected). User toggle via collapse button at sidebar header.
- Clicking a worker card's "N files" chip selects that worker's diff in the sidebar. Multi-select via Cmd-click adds another worker (sidebar shows union with worker-attribution section headers).
- File list at sidebar top (collapsible per-worker section), selected file diff body below using the existing Shiki + TanStack Virtual setup from Phase 4 Step 6.
- Empty state when no worker selected: "Click 'N files' on a worker to view changes."
- Backwards-compat: DiffPopover deprecation phased in. Phase 7 Step 1 ships with both surfaces wired to the same data; Step 1 ends with DiffPopover marked deprecated and InlineDiffSidebar default. Step 8 verification removes DiffPopover code paths.
- GraphCanvas layout: when sidebar open, graph viewport shrinks by sidebar width. ReactFlow `fitView` behavior must respect the new viewport bounds.

**Scope (NOT):**

- Does not introduce new diff-rendering capabilities. Same unified diff format, same syntax highlighting, same virtual scroll. Re-placement only.
- Does not change ConflictResolverPopover (modal still appropriate for blocking conflict flow).

**Acceptance:**

- Sidebar opens / closes, width drag works, persists per-user
- Worker chip click selects diff
- Multi-worker selection shows union
- DiffPopover removed by Step 8 (both surfaces in Step 1, deprecation in Step 1, removal in Step 8)
- GraphCanvas viewport reflows on sidebar toggle
- 30+ tests covering sidebar component + GraphCanvas integration

**Open questions:**

- Mobile / narrow viewport: sidebar collapses to bottom-sheet? Defer to Step 8 — desktop-first, narrow handling Phase 7.5 if needed.
- Diff search / filter: not in this step. Add to KNOWN_ISSUES if user wants it.

**Estimated complexity:** large (3.5-4 days). Layout reflow is the main risk.

---

### Step 2: Per-worker undo (revert worktree changes)

A worker that has produced changes (any state where `hasUnappliedChanges == true`) gets an "Undo" affordance in its footer. Click → cancel worker if running + git reset worktree to base commit. Distinct from Stop (which leaves worktree modified). Distinct from cancel-run (which sweeps everything).

**Scope:**

- New IPC command `revert_subtask_changes(run_id, subtask_id)`:
  - Validates subtask is in a state where changes exist (Done / Failed-with-edits / Cancelled / AwaitingInput / Running with progress)
  - If running: signals graceful cancel first (Phase 5 Step 1 pattern)
  - Runs `git reset --hard <base_commit_sha>` in subtask worktree
  - Runs `git clean -fd` to remove untracked files
  - Emits `RunEvent::WorktreeReverted { run_id, subtask_id, files_cleared: u32 }`
  - Sets subtask state to Cancelled with new sub-flag `revert_intent: bool` (preserves user intent — did they just stop or did they undo?)
- New event `run:worktree_reverted` with files_cleared count
- New worker card footer button "Undo" (lucide RotateCcw icon)
  - Visible only when subtaskHasUnappliedChanges
  - Hidden during awaiting_input (QuestionInput precedence — Phase 6 Step 4 pattern)
  - Confirmation: inline "Are you sure?" with 2s revert countdown (gives user time to abort)

**Scope (NOT):**

- Does not affect other workers
- Does not affect Apply lifecycle (run continues post-undo if other workers still running)
- Does not preserve undo history beyond the immediate revert (no multi-step undo)

**Acceptance:**

- Undo button visible on workers with changes
- Click → confirmation → 2s countdown → revert
- Worktree clean post-revert (verified by git status check)
- Subtask state Cancelled with revert_intent=true
- Other workers unaffected
- Run continues
- 15+ tests covering revert IPC + UI flow

**Open questions:**

- Multiple Undo clicks in rapid succession: rate-limit to 1 per 3s per subtask
- Undo on master: not supported in Phase 7 (master changes are plan only, no worktree)

**Estimated complexity:** medium (2.5-3 days).

---

### Step 3: PlanChecklist alongside graph

The master agent's plan renders as a vertical checklist alongside the graph, providing a linear progress view. Both share state from graphStore.

**Scope:**

- New `PlanChecklist` component, placed to the right of GraphCanvas (or below, depending on viewport — see Q2 in Architecture section)
- Each subtask renders as a checklist row:
  - Checkbox state: empty (proposed) / spinner (running) / check (done) / X (failed/cancelled)
  - Subtask title (truncated to one line)
  - Compact secondary line: agent kind + elapsed time (Step 4 integration)
- Click on a row centers the graph on that subtask (existing setCenter logic from Phase 4 Step 2)
- Layout responsive:
  - Wider than 1400px: graph + checklist side-by-side, checklist 280px fixed width
  - 1000-1400px: graph + checklist tabs (user toggles)
  - Narrower than 1000px: graph + checklist tabs (user toggles)
- View toggle: explicit button when narrow, automatic side-by-side when wide
- Checklist persists scroll position when subtask states change (no jumping to top on every event)

**Scope (NOT):**

- Does not replace graph
- Does not introduce new state — re-projection of existing graphStore data
- Does not allow editing subtasks from checklist (still graph-only via inline edit Phase 3)

**Acceptance:**

- Checklist renders all proposed/running/terminal subtasks
- State changes reflect within 100ms of event
- Click centers graph
- Responsive layout tested at 800/1200/1600px viewport widths
- 25+ tests covering component + responsive behavior + state sync

**Open questions:**

- Master node in checklist: top row, distinct treatment (italic? badge?). Recommend explicit "Master plan" label with elapsed during planning.
- Cancelled run: checklist freezes in last-known state, no unmount mid-run

**Estimated complexity:** medium-to-large (3-3.5 days). Responsive layout + scroll preservation are the risks.

---

### Step 4: ElapsedCounter components

Per-worker and per-master elapsed time counters. Visual: "3m 24s" format, monospace, muted color. Updates every second via store-level tick subscription, not per-component setInterval (performance: one tick → all consumers re-read).

**Scope:**

- Backend: extend `forward_logs` to also emit a periodic `RunEvent::ElapsedTick { run_id, subtask_id, elapsed_ms }` event every 1s during running state. Emits stop on terminal transition with final elapsed.
  - Master node also emits during PlanningInProgress / ReplanInProgress states
- Frontend: store-level `subtaskElapsed: Map<SubtaskId, number>` + `masterElapsed: number`, updated by tick events
- New `ElapsedCounter` component, takes elapsed-ms prop, renders formatted time
- Worker card: ElapsedCounter in footer, top-right
- Master node: ElapsedCounter in master card during planning
- Checklist row (Step 3 integration): ElapsedCounter in secondary line
- Final elapsed captured on terminal transition, persists in graphStore for post-run display

**Scope (NOT):**

- Does not introduce per-subtask backend timer state (memo from start_at + now)
- Does not survive app restart (in-memory, mid-run cleanup)

**Acceptance:**

- Counters tick every second during running
- Counters stop and freeze on terminal state
- Master + worker + checklist counters all sync
- Performance: 10 concurrent counters, <2% CPU overhead
- 12+ tests covering ElapsedCounter component + tick subscription

**Open questions:**

- Backend tick frequency: 1s feels right for users; backend cost is one event per worker per second, capped. Acceptable.
- Pre-running elapsed: counter starts at 0:00 in Proposed/Waiting states (not running yet). Recommend hide counter pre-running.

**Estimated complexity:** medium (2-2.5 days).

---

### Step 5: Follow-up runs (parent_run_id)

After a run reaches Applied or Rejected, the user can submit a follow-up task that builds on the current branch state. Follow-up renders as a child run threaded under its parent.

**Scope:**

- Schema: add `parent_run_id: Option<RunId>` to `runs` table. Migration: ALTER TABLE additive. Index on parent_run_id for child lookup.
- New IPC command `start_followup_run(parent_run_id, prompt)`:
  - Reads parent run's `final_branch` and `commit_sha`
  - Creates new Run with parent_run_id set
  - Submits via existing submit_run pipeline
  - Master agent receives prior-context prompt prefix per Step 0 diagnostic recommendation
- New event `run:followup_started { parent_run_id, child_run_id }`
- ApplySummaryOverlay rework (or successor surface):
  - Inline FollowupInput component below summary
  - Single-line input, "Ask for follow-up changes..." placeholder
  - Submit triggers start_followup_run IPC
  - On submit, overlay transitions: collapses summary, expands to show new run starting
- Run history view (run list sidebar) shows follow-up runs as threaded children under their parent (indented, with "↳" prefix or visual lineage indicator)

**Scope (NOT):**

- Does not pre-populate the follow-up prompt with anything from the parent run (clean text input)
- Does not allow editing the master agent's interpretation before kickoff (same lifecycle as fresh run — plan, approve, execute, apply)
- Does not chain follow-ups infinitely; track lineage but no cap (could become Phase 8 concern if abuse appears)

**Acceptance:**

- Follow-up input visible after Applied/Rejected
- Submit creates child run with parent_run_id set
- Child run inherits parent's branch + commit base
- Run history shows threaded view
- Master agent receives appropriate prior-context prefix
- 20+ tests covering IPC + schema + UI flow

**Open questions:**

- Apply behavior on follow-up: child commits go to same branch? Recommend yes — follow-up is "incremental work on this feature branch."
- Concurrent follow-ups: can user start follow-up A and follow-up B from same parent before A applies? Reject second until A reaches terminal. Defer to Step 8 if it becomes ambiguous.
- Parent run deletion: cascades to children? Recommend no cascade — preserve audit trail. Children orphan but remain navigable.

**Estimated complexity:** large (4-5 days). Schema migration + overlay rework + history view are the biggest pieces.

---

### Step 6: Information consolidation pass

A pass that takes all surfaces from Phase 4-7 and consolidates where possible. The "remove at least one modal" obligation is fulfilled by Step 1's DiffPopover absorption. Step 6 looks for secondary consolidation opportunities surfaced during Step 0's audit.

**Scope:**

- Audit findings from Step 0 drive specific consolidations. Likely candidates (subject to audit):
  - Worktree action menu (Phase 4 Step 4) — does Reveal/Copy/Terminal stay separate or absorb into a context-menu pattern?
  - StashBanner + ErrorBanner — separate or unified ErrorBanner with action-variant?
  - Toast notifications — review density (notifications that auto-dismiss vs require action)
  - Master heartbeat (Phase 3.5) vs ElapsedCounter (Phase 7 Step 4) — same component? Different?
- Implementation: per-consolidation, scope is small (component refactor or removal). 3-5 consolidations expected.
- No new features. Pure cleanup.

**Scope (NOT):**

- Does not remove any feature, only re-homes them
- Does not reflow GraphCanvas layout (Step 1 already did)

**Acceptance:**

- 3-5 consolidations shipped (specific list comes from Step 0 audit)
- No regression in feature surface
- Test count net non-negative (consolidation may remove tests as it removes code)

**Estimated complexity:** medium (2-3 days).

---

### Step 7: Cross-step integration testing

Phase 7's features touch each other heavily — InlineDiffSidebar + PlanChecklist must coexist within GraphCanvas; ElapsedCounter must update in three places (worker card, checklist row, master node); Undo + Follow-up must compose correctly; PlanChecklist must reflect Undo'd workers correctly.

**Scope:**

- Integration test pass exercising every Phase 7 feature pair:
  - Sidebar + Checklist (concurrent)
  - Undo + Sidebar (sidebar updates on revert)
  - Elapsed + all three surfaces
  - Follow-up + Sidebar (sidebar resets for new run)
  - Follow-up + Checklist (checklist resets for new run)
  - Undo during running + Checklist state update
- Edge cases:
  - Undo while sidebar is showing that worker's diff
  - Sidebar resize during run with active worker
  - Follow-up submitted while sidebar collapsed
  - Multi-monitor / window-resize behavior

**Scope (NOT):**

- Does not add new features
- Does not refactor

**Acceptance:**

- 30+ new integration tests across step pairs
- Every Phase 7 feature pair tested
- No regressions in Phase 4-6 functionality

**Estimated complexity:** small-to-medium (1.5-2 days).

---

### Step 8: Verification + retrospective + close-out

Same shape as Phase 4-6 close-outs.

**Scope:**

- Manual verification on real repo across all 7 features
- DiffPopover code paths fully removed (Step 1 deprecation finalized)
- Integration test additions: covered by Step 7
- Visual observations under `docs/retrospectives/phase-7-visuals/` — 6-8 observations expected (more than Phase 6 since more feature surfaces)
- `docs/phase-7-verification.md` goal-backward
- `docs/retrospectives/phase-7.md`
- KNOWN_ISSUES updates
- CLAUDE.md sync

**Acceptance:**

- All step-level acceptance from Steps 0-7 PASS
- Frontend tests: target +120 over Phase 6's 770 = 890+
- Rust tests: target +30 over Phase 6's 397 = 427+
- All gates clean
- DiffPopover removed (negative LOC delta in this surface)

**Estimated complexity:** medium (2 days).

---

## Estimated total complexity

| Step | Complexity | Days |
|---|---|---|
| 0 — UI density audit + follow-up survey | small-medium | 2-2.5 |
| 1 — InlineDiffSidebar | large | 3.5-4 |
| 2 — Per-worker undo | medium | 2.5-3 |
| 3 — PlanChecklist | medium-large | 3-3.5 |
| 4 — ElapsedCounter | medium | 2-2.5 |
| 5 — Follow-up runs | large | 4-5 |
| 6 — Consolidation pass | medium | 2-3 |
| 7 — Cross-step integration | small-medium | 1.5-2 |
| 8 — Verification | medium | 2 |
| **Total** | | **~22-27 days** |

Larger than the 18-22d header estimate because Steps 1, 3, 5 are the largest single-step efforts since Phase 2. Realistic floor: 7-10 active working days at Phase 5/6 cadence, but with genuine risk of spillover on Steps 1 and 5. If actual lands above 12 days, consider trimming Step 6 (consolidation can be Phase 7.5).

## Architectural questions addressed

(Q1, Q2, Q3 covered in Architecture changes section above.)

**Q4: Tick events scale concern.**

Per-worker per-second tick is bounded — at 10 workers running, that's 10 events/sec, well within Tauri's IPC capacity. Frontend store handles 10 updates/sec without re-render thrashing because ElapsedCounter is the only consumer and it reads atomic ms values. If concurrent worker count exceeds 20 in future phases, revisit.

**Q5: Sidebar default state policy.**

Default open during running, default closed during proposed/applied/rejected. This serves the user's likely intent: while agents are working, the user wants to see diffs as they appear; once Apply is decided, the user moves on. Per-user preference override stored in settings.

## Post-phase deliverables

- `docs/phase-7-spec.md` closed with "Shipped" note
- `docs/phase-7-density-audit.md` (Step 0)
- `docs/phase-7-followup-diagnostic.md` (Step 0)
- `docs/phase-7-verification.md`
- `docs/retrospectives/phase-7.md`
- `docs/retrospectives/phase-7-visuals/` (6-8 observations)
- `docs/KNOWN_ISSUES.md` updated
- `CLAUDE.md` updated
- `docs/phase-8-spec.md` kickoff brief — Phase 8 is multi-agent comparison + adaptive single/multi-agent UI. See `docs/phase-8-preview.md` for current thinking.
