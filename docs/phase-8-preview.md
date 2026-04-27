# Phase 8 preview — Multi-agent comparison + adaptive task shape

**Status:** Preview. Not a spec yet. Living document until Phase 7 ships and real-usage data on Phase 7 surfaces drives concrete decisions.

**Theme:** *Two agents, one truth.* Phase 7 ships information density on a single execution. Phase 8 ships information density across multiple competing executions — and adapts the UI to single-vs-multi-agent task shape.

## Two big features

### Feature A: Multi-agent same-task comparison

For a single subtask (or for a whole run), execute two agents in parallel on the same input. Surface both diffs side-by-side. User picks the better diff before Apply.

**Sketch (subject to Phase 7 learnings):**

- Per-subtask: optional "Run with two agents" toggle in plan approval. Default off.
- When on: subtask spawns two workers, each in its own worktree, with the same prompt + extra_context.
- Both workers run to completion in parallel.
- ApplySummaryOverlay (or its Phase 7 successor) shows both diffs with attribution. User selects winner per subtask.
- Selected diffs go into Apply; unselected diffs are discarded (worktrees swept).

**Open questions for Phase 8 spec time:**

- Same agent kind on both, or always two different (e.g., Claude + Codex)? Phase 7 follow-up diagnostic informs.
- Cost surface: comparison doubles the LLM cost per subtask. Phase 9 cost-aware suite handles cost surface; Phase 8 should warn but not block.
- UI: side-by-side diff in InlineDiffSidebar (Phase 7) vs new modal? Likely sidebar with split-pane mode.

### Feature B: Adaptive single-vs-multi-agent task shape

Master agent analyzes task complexity. If task is small (e.g., single-file rename, one-function change), runs as a single-agent chat-style flow without graph. If task is large (multi-file, multi-step), runs as multi-agent graph.

**Sketch (subject to Phase 7 learnings):**

- Master agent extends with a complexity-decision step: post-parsing, before planning, output `task_shape: Single | Multi`.
- Single shape: master spawns one worker, no plan/approval gate, no subtask graph. Frontend shows a chat-style flow (modeled on Cursor screenshots from Phase 7 reference).
- Multi shape: existing flow (plan → approve → multi-worker → diff → apply).
- User can override master's decision before kickoff (toggle: "Force multi-agent").

**Open questions for Phase 8 spec time:**

- How does master agent decide complexity? Heuristic on prompt length / keyword detection / explicit LLM call? Phase 8 spike needed.
- Single-shape UI: replaces graph entirely or shows minimal graph (1 node)? Likely entirely — chat-flow is its own paradigm within the same lifecycle.
- Approval in single-shape: still required before execute? Recommend yes (preserves Tech Lead modu commitment); shape is about UI density, not autonomy.

## Lifecycle implications

Phase 7's lifecycle (plan → approve → multi-worker → diff → apply → follow-up) is shape-aware in Phase 8 but otherwise preserved. Single-shape lifecycle: plan-implicit → approve (simplified) → single-worker → diff (inline) → apply → follow-up.

Phase 8 does NOT introduce:

- Conversational mode without approval
- Auto-iterate on review failure
- True multi-turn chat across runs (still per-run lifecycle)

These are v2.5+ if ever.

## Estimated scope (rough)

Feature A: 4-5 implementation steps, ~2 weeks spec budget.
Feature B: 5-6 implementation steps, ~2.5 weeks spec budget.

Combined Phase 8: ~25-30 days spec / 8-12 days realistic floor (by Phase 5-7 evidence, actual lands at ~30-40% of spec).

## Dependencies on Phase 7

Phase 7 must ship before Phase 8 starts. Specifically:

- InlineDiffSidebar (Step 1) is the substrate for side-by-side comparison diff
- ElapsedCounter (Step 4) supports comparison "which agent finished first" awareness
- Follow-up runs (Step 5) compose with both Phase 8 features (comparison can re-spawn losers; adaptive task shape decides follow-up's shape)
- Consolidation pass (Step 6) ensures Phase 8 doesn't add UI on top of fragmented Phase 7 surfaces

## Items explicitly NOT in Phase 8

Per user preference (geçen gece konuşması):

- Auto-iterate on review failure (PM modu sınırı)
- True conversational mode without approval gates (v2.5+)
- Three-or-more agent comparison (start with two, expand later)

## Decision log

- Phase 8 will use the term "task shape" (single vs multi) rather than "modes" to keep the lifecycle unified.
- Comparison feature defaults off — opt-in per subtask. Master doesn't auto-comparison.
- Adaptive task shape is the master's call by default but always user-overridable.
