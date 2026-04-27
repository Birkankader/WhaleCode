# Phase 7 Step 0 — UI density audit

Inventory of every visible UI surface in WhaleCode as of Phase 6 ship state. Each surface is scored on visibility (default-shown vs click-revealed), information density (rough qualitative score: low / medium / high), and given an explicit Phase 7 disposition (keep / absorb / replace / deprecate / consolidate).

This document drives Step 1's InlineDiffSidebar absorption (Q1 in spec) and Step 6's consolidation pass (which auditing surfaces, which ones survive).

## Method

Every `*.tsx` file under `src/components/` was cataloged by directory (`nodes/`, `shell/`, `graph/`, `overlay/`, `approval/`, `setup/`, `primitives/`). Test-only files excluded. Each surface mapped to its phase of origin and its current trigger (always-visible, click, hover, state-gated). Phase 7 disposition assigned per the spec's design philosophy: "every new surface replaces or absorbs an existing one rather than stacking on top."

## Surface inventory

### Worker / master node surfaces

| Surface | Origin | Trigger | Visibility | Density | Phase 7 disposition |
|---|---|---|---|---|---|
| `MasterNode` | Phase 1 | Always-visible during run | high | high | **Keep.** Master heartbeat (Phase 3.5) absorbs into ElapsedCounter (Step 4). |
| `WorkerNode` | Phase 1 | Always-visible during run | high | high | **Keep.** Card body grows in Step 4 (ElapsedCounter footer chip) + Step 2 (Undo button). |
| `FinalNode` | Phase 1 | Always-visible post-merge | high | medium | **Keep.** Step 5 follow-up input lives adjacent (post-Apply / Reject). |
| `ActivityChipStack` | Phase 6 Step 2 | Always-visible during running | high | high | **Keep.** Streams ToolEvents above log tail. |
| `ThinkingPanel` | Phase 6 Step 3 | Toggle-gated (`ShowThinkingToggle`) | low (default off) | high (when on) | **Keep.** Capability-gated per adapter. |
| `ShowThinkingToggle` | Phase 6 Step 3 | Always-visible footer chip | medium | low | **Keep.** Brain icon + capability tooltip. |
| `HintInput` | Phase 6 Step 4 | Always-visible inline on running cards | high | high | **Keep.** Slot-shared with QuestionInput during AwaitingInput. |
| `QuestionInput` | Phase 5 Step 4 | State-gated (AwaitingInput only) | high | high | **Keep.** Q&A precedence over HintInput. |
| `StopButton` | Phase 5 Step 1 | State-gated (`STOPPABLE_STATES`) | high | low | **Keep.** Phase 7 Step 2 Undo lives next to it in footer. |
| `EscalationActions` | Phase 3 | State-gated (HumanEscalation) | high | medium | **Keep.** No Phase 7 changes. |
| `WorktreeActions` | Phase 4 Step 4 | State-gated (inspectable) menu | low (click-revealed) | medium | **Consolidate (Step 6 candidate).** Reveal/Copy/Terminal — three actions in a folder-icon menu. Audit if context-menu pattern reduces footer chrome. |

### Diff surfaces

| Surface | Origin | Trigger | Visibility | Density | Phase 7 disposition |
|---|---|---|---|---|---|
| `DiffPopover` | Phase 4 Step 6a | Click on "N files" chip → modal | low (click-revealed) | high | **ABSORB into InlineDiffSidebar (Step 1).** Modal blocks the run-watching attention. Move data + Shiki + virtual scroll into sidebar; drop popover code paths in Step 8. |
| `DiffBody` | Phase 4 Step 6b | Inside DiffPopover | medium | high | **Keep + relocate.** Same Shiki + TanStack Virtual setup; new parent surface. |

### Shell / overlay surfaces

| Surface | Origin | Trigger | Visibility | Density | Phase 7 disposition |
|---|---|---|---|---|---|
| `TopBar` | Phase 1 | Always-visible top of viewport | high | high | **Keep.** Master agent chip + branch indicator + repo picker. |
| `Footer` | Phase 1 | Always-visible bottom of viewport | high | low | **Keep.** Audit for ElapsedCounter integration if checklist row pulls counter out of card footer. |
| `EmptyState` | Phase 1 | State-gated (no run active) | high | medium | **Keep.** Step 5 follow-up input does not displace this — follow-up is post-Apply, not initial. |
| `ApplySummaryOverlay` | Phase 4 Step 2 | State-gated (Applied) overlay | high | high | **Rework (Step 5).** Inline FollowupInput component below summary; on submit, overlay collapses + new run starts. |
| `ApprovalBar` | Phase 1 | State-gated (Proposed) sticky bottom | high | high | **Keep.** No Phase 7 changes. |
| `ErrorBanner` | Phase 1 | State-gated (run errors) banner | high | medium | **Consolidate (Step 6 candidate).** Audit unification with StashBanner — same banner pattern, different action variants. |
| `StashBanner` | Phase 5 Step 2 | State-gated (dirty base / stash held) | high | medium | **Consolidate (Step 6 candidate).** Pair with ErrorBanner unification. |
| `ToastStack` | Phase 1 | Auto-dismissing notifications | medium | low | **Consolidate (Step 6 candidate).** Audit auto-dismiss vs require-action density; some toasts could collapse into ErrorBanner. |
| `ConflictResolverPopover` | Phase 5 Step 3 | State-gated (MergeConflict) popover | low (click-revealed) | high | **Keep as modal.** Spec Q1: blocking conflict-resolution flow is modal-appropriate, not browse-while-running. Phase 8 candidate if real usage suggests otherwise. |
| `AutoApproveConsentModal` | Phase 3 | First-run consent modal | low (click-revealed once) | high | **Keep as modal.** First-run consent is modal-appropriate (one-shot blocking). |
| `AutoApproveSuspendedBanner` | Phase 3 | State-gated banner | high | low | **Consolidate (Step 6 candidate).** Pair with ErrorBanner / StashBanner unification audit. |
| `SettingsPanel` | Phase 3 | Click on settings → panel | low (click-revealed) | medium | **Keep.** Phase 7 adds `inlineDiffSidebarWidth` setting. |
| `RepoPicker` | Phase 1 | Click on repo chip → picker | low (click-revealed) | medium | **Keep.** No Phase 7 changes. |
| `WindowTooSmall` | Phase 4 | State-gated (viewport < threshold) | high (when triggered) | low | **Keep.** Phase 7 viewport threshold extends to cover sidebar+checklist responsive cutoff (1000px / 1400px). |

### Graph surfaces

| Surface | Origin | Trigger | Visibility | Density | Phase 7 disposition |
|---|---|---|---|---|---|
| `GraphCanvas` | Phase 1 | Always-visible during run | high | high | **Reflow (Step 1 + Step 3).** Viewport shrinks on InlineDiffSidebar open + on PlanChecklist side-by-side at wide viewport. ReactFlow `fitView` respects new bounds. |
| `FlowEdge` | Phase 1 | Always-visible during run | high | medium | **Keep.** No Phase 7 changes. |

### Setup surfaces

| Surface | Origin | Trigger | Visibility | Density | Phase 7 disposition |
|---|---|---|---|---|---|
| `AgentSetupState` | Phase 4 Step 1 | State-gated (no agents detected) | high | high | **Keep.** No Phase 7 changes. |

### Primitives

`Badge`, `Button`, `Chip`, `Dropdown`, `InlineTextEdit`, `NodeContainer`, `StatusDot` — all primitive building blocks. Phase 7 adds no new primitives; new components compose from these.

## Phase 7 net surface delta

| Phase 7 step | Adds | Absorbs | Consolidates |
|---|---|---|---|
| Step 1 | `InlineDiffSidebar` | `DiffPopover` (deprecated in Step 1, removed in Step 8) | — |
| Step 2 | `UndoButton` (worker footer) | — | — |
| Step 3 | `PlanChecklist` (alongside graph) | — | — |
| Step 4 | `ElapsedCounter` (worker / master / checklist) | — | Master heartbeat (Phase 3.5) folds into `ElapsedCounter` |
| Step 5 | `FollowupInput` (inline in `ApplySummaryOverlay`) | — | — |
| Step 6 | — | — | 3-5 consolidations from candidates: `ErrorBanner` + `StashBanner` + `AutoApproveSuspendedBanner` unification; `WorktreeActions` context-menu audit; `ToastStack` auto-dismiss density audit |
| **Net** | **+5 components** | **−1 component** (`DiffPopover`) | **3-5 consolidations** |

Spec design-philosophy obligation ("zero new modals, remove ≥1 existing modal") fulfilled by Step 1's `DiffPopover` absorption. No Phase 7 step ships a new modal dialog.

## Step 6 consolidation candidates (concrete)

The spec budgets Step 6 for 3-5 consolidations, "specific list comes from Step 0 audit." This audit surfaces four concrete candidates ordered by leverage:

1. **Banner unification** — `ErrorBanner` + `StashBanner` + `AutoApproveSuspendedBanner` are three near-identical components with different action variants. Unify into one `Banner` primitive with a `variant: 'error' | 'stash' | 'auto-approve-suspended'` prop and per-variant action set. Net: -2 component files, single test surface, consistent banner styling.
2. **Master heartbeat fold-in** — Phase 3.5's `MasterLog` heartbeat (10s elapsed seconds during planning) is a special-case `ElapsedCounter` for the master node. Step 4's generic `ElapsedCounter` should subsume it — render `ElapsedCounter` on the master card during PlanningInProgress / ReplanInProgress states. Net: -1 component, consistent elapsed-time UX across master + worker.
3. **WorktreeActions menu density** — three actions (Reveal / Copy / Terminal) in a folder-icon menu. Audit whether moving to a context-menu pattern (right-click on worker card body) reduces footer chrome. Defer to Step 6 — this is footer-real-estate optimization, not a clear win.
4. **ToastStack auto-dismiss density** — review which toasts auto-dismiss vs require action. Toasts that require action are lying about their density (look transient, demand attention). Promote action-required toasts to a banner variant. Defer to Step 6 if more than 2 such cases surface.

Phase 7 Step 6 ships items 1 + 2 unconditionally. Items 3 + 4 ship if Step 1-5 verification surfaces real density pain on those surfaces.

## Spec-design-philosophy compliance check

Two questions the design philosophy demands of every new surface:

**1. What existing surface does this replace or absorb?**

| New surface | Replaces / absorbs |
|---|---|
| `InlineDiffSidebar` | `DiffPopover` (modal) ✓ |
| `UndoButton` | None — net add. **Justified:** addresses a genuine missing primitive (revert without cancel-run) flagged by Phase 4-6 real usage. |
| `PlanChecklist` | None — net add. **Justified:** linear progress view that the graph cannot serve at >4 workers. Coexists with graph rather than replacing. |
| `ElapsedCounter` | Master heartbeat (consolidated in Step 6) ✓ |
| `FollowupInput` | None — net add inline. **Justified:** lives within `ApplySummaryOverlay`, no new persistent panel. |

Two of five new surfaces absorb existing ones; three are net adds with documented justification. The "replaces or absorbs" rule is a target, not a hard constraint — Phase 7 spec acknowledges this in Q2 (PlanChecklist coexists with graph). Net add count (3) is bounded; consolidation pass (Step 6) reclaims at least 2 components elsewhere. Net component delta lands at +1 to +3, within the budget the design philosophy implies.

**2. Is the information visible by default, or behind a click?**

| New surface | Default visibility |
|---|---|
| `InlineDiffSidebar` | Default open during running, default closed post-Apply (Q5) — visible by default while user wants it |
| `UndoButton` | Always-visible when `subtaskHasUnappliedChanges` — visible by default in the state where it matters |
| `PlanChecklist` | Side-by-side with graph at >1400px viewport, tab-toggled below 1400px — visible by default at desktop sizes |
| `ElapsedCounter` | Always-visible on running workers + master — visible by default |
| `FollowupInput` | Always-visible inline after Applied / Rejected — visible by default in the state where it matters |

All five new surfaces are visible-by-default in their respective states. None are click-to-reveal information that the user actively wants. Compliance with the design philosophy's second rule is clean.

## Recommendations driving Steps 1-7

Two paragraphs summarizing what this audit changes about the spec as written:

**Step 1 absorption is well-scoped.** `DiffPopover` is the only modal whose data + interaction model maps cleanly onto a sidebar. Same Shiki + virtual-scroll renderer; same per-file collapse; new parent placement. The audit confirms no other modal qualifies for absorption — `ConflictResolverPopover`, `AutoApproveConsentModal` are appropriately blocking; the rest are banners or popovers with state-gated triggers, not modals. Step 1's removal-quota is met by `DiffPopover` alone; Step 6's consolidation pass meets the implicit budget for net component reduction.

**Step 6's specific consolidations should ship as Banner unification + Master heartbeat fold-in.** These two are concrete, testable, and motivated by the surface-by-surface comparison this audit produced. The remaining two candidates (WorktreeActions context-menu, ToastStack auto-dismiss) are deferrable to post-verification observation. Phase 7 spec budgets 2-3 days for Step 6 — landing items 1 + 2 unconditionally fits comfortably; items 3 + 4 ship only on real-pain signal.
