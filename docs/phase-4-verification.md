# Phase 4 verification

**Verified:** 2026-04-23
**Goal:** *Build trust through visibility.*
**Branch:** `main`
**Head at verification:** `56f5925 fix(phase-4): content-fit expanded worker card height`

## Goal-backward success criteria

Six success criteria were declared in `docs/phase-4-spec.md` (Goal section). Each is restated here with a pass/fail mark derived from the shipped code, not from step completion.

| # | Criterion | Verdict | Evidence |
|---|-----------|---------|----------|
| 1 | After Apply, the graph remains visible with a summary overlay (files changed count, branch, commit SHA, per-worker contribution). | **PASS** | `ApplySummaryOverlay` mounted in `GraphCanvas`; `App.tsx` routes `status === 'applied'` through the canvas (previously fell through to `EmptyState`); `run:apply_summary` event emits after `status_changed(Applied)`. Integration test `apply_summary_event_ordering` pins the event sequence. |
| 2 | Each done worker exposes per-file diff previews inline — syntax-highlighted, collapse/expand, no modal. | **PASS** | `DiffPopover` + lazy `DiffBody` render `FileDiff.unifiedDiff` via Shiki `dark-plus`, with per-file expand state and `@tanstack/virtual` windowing. `run:subtask_diff` payload carries `unifiedDiff` per file (-U10 context). No modal — popover is inline to the chip. |
| 3 | Agent subprocess crashes (non-zero exit with no output, stdout hang, malformed JSON) produce a distinct state, a crash event, and an ErrorBanner variant, and route into the existing Layer 1 retry ladder. | **PASS with scope change** | Shipped as event-field branch (Step 5 decision): `SubtaskStateChanged` carries `errorCategory: 'process-crashed' \| 'task-failed' \| 'parse-failed' \| 'timeout' \| 'spawn-failed' \| 'orchestrator-panic'`; ErrorBanner and worker caption render per-category copy. No new `Crashed` `SubtaskState` variant. Layer 1/2 routing is unchanged — the discriminant is *surface-only* — per the spec's explicit "does not change routing" scope. |
| 4 | Worker cards expand to show full log output on click, reflow the graph via dagre, and collapse on second click. | **PASS with adjusted ceiling** | `EXPANDABLE_STATES` gates the toggle; `workerExpanded` set in `graphStore`; `GraphCanvas.buildGraph` promotes expanded ids to the content-fit height tier (floor 200, ceiling 340, grows per log-line count); `layoutGraph` row-max alignment re-flows the grid. Ceiling lowered 560 → 420 → 340 across two post-ship rounds after user reported off-viewport overflow on a 14" laptop. |
| 5 | Done / failed / escalated workers expose Reveal / Copy path / Open terminal affordances on the worktree path — the first UI surface of a path previously treated as implementation detail. | **PASS** | `WorktreeActions` folder-icon menu on `INSPECTABLE_STATES` (done / failed / human_escalation / cancelled). Three backend IPC commands (`reveal_worktree`, `get_subtask_worktree_path`, `open_terminal_at`) with structured-argument safety. Clipboard fallback on no-terminal. CLAUDE.md "Things to NEVER do" updated with the explicit carve-out. |
| 6 | Gemini CLI is restricted to worker-only; the master picker does not offer it, and selected-master persistence migrates anyone currently configured to Gemini-as-master. | **PASS** | `AgentKind::supports_master()` returns `false` for Gemini; `detection::RECOMMENDED_ORDER` reduced to `[Claude, Codex]`; TopBar master dropdown filters to master-capable; `AgentSetupState` tags the Gemini card "Worker-only"; `settings::migrate` rewrites `masterAgent: "gemini"` on boot and surfaces a one-shot notice via `consume_migration_notices`. Worker use remains untouched. |

**Result: 6 / 6 PASS.**

## Per-step acceptance walk

Each step's acceptance criteria from the spec:

### Step 0 — crash-shape diagnostic
- Integration test file `src-tauri/src/agents/tests/crash_shapes.rs` with per-category tests: **PASS** (cargo test green; file exists with the five fake-agent fixtures).
- Written taxonomy in `docs/phase-4-crash-diagnostic.md`: **PASS**.
- Taxonomy drove Step 5 scope (event-field branch, not `Crashed` state): **PASS**.

### Step 1 — Gemini worker-only
- TopBar master dropdown hides Gemini: **PASS**.
- `AgentSetupState` labels Gemini worker-only: **PASS**.
- `recommended_master` returns `None` when only Gemini installed: **PASS** (unit test in `detection::tests`).
- Settings migration test — boot with `masterAgent: "gemini"` + Claude available → migrated to Claude, notice surfaced: **PASS** (`settings::migration_tests`).
- Existing Gemini worker integration tests still green: **PASS** (325 Rust tests, 0 failures).
- KNOWN_ISSUES.md + CLAUDE.md updates landed in the same commit (`137bb99`): **PASS**.

### Step 2 — Apply summary overlay
- Graph stays visible post-Apply with overlay showing commit SHA, branch, files changed, per-worker breakdown: **PASS**.
- Clicking a worker row centers the graph on that node via `setCenter` with preserved zoom: **PASS**.
- Dismiss resets to Idle: **PASS**.
- Event ordering `run:diff_ready → run:status_changed(Applied) → run:apply_summary`: **PASS** (integration test).
- Discard path unchanged: **PASS**.

### Step 3 — Worker log expand
- Click card body → grows, `layoutGraph` reflows: **PASS**.
- Second click collapses: **PASS**.
- Keyboard Enter / Space toggles: **PASS**.
- Multi-expand respects row-max: **PASS**.
- Chip / button clicks don't toggle expand: **PASS** (`stopPropagation` on chip + WorktreeActions + cancel).
- `aria-expanded` on worker card: **PASS**.
- All `EXPANDABLE_STATES` stream / render into the expanded surface: **PASS**.
- **Adjusted:** height ceiling moved 560 → 420 → 340 post-ship; also converted from fixed to content-fit `[200, 340]`. Spec's "560px" line is superseded (see Step 3 entry in retro).

### Step 4 — Worktree inspection affordances
- Done/failed/human_escalation/cancelled cards show the folder icon: **PASS**.
- Reveal opens the worktree in the file manager: **PASS** (macOS manual; unit tests cover spawn argv).
- Copy path writes to clipboard with success toast: **PASS**.
- Open terminal launches the default terminal; clipboard fallback on miss: **PASS**.
- Running / proposed cards do not render the affordance: **PASS**.
- Layer 3 "Manual fix" continues to work: **PASS**.
- CLAUDE.md update in the same commit: **PASS**.

### Step 5 — Crash surface (event-field branch)
- Each of six `ErrorCategory` values round-trips to UI copy: **PASS** (one integration test per category).
- Legacy payloads without `errorCategory` render generic fallback: **PASS** (Zod `.optional()` path + parser test).
- `classify_nonzero` heuristic documented in KNOWN_ISSUES: **PASS** (already there pre-Step-5; cross-ref in-line).
- Snapshot coverage for copy variants including a11y labels: **PASS**.

### Step 6 — Diff content preview (B-lite)
- Each file collapsed by default with `+N / −M` stat; click expands with syntax highlighting: **PASS**.
- Shiki lazy-loaded — main bundle +2.44 kB raw / +0.98 kB gzipped, under the 5KB budget: **PASS** (build output verified).
- 10k-line synthetic fixture renders with virtual scroll, does not block main thread > 100ms: **PASS** (benchmark test in `DiffPopover.test.tsx`).
- Language coverage: TS, JS, TSX, JSX, Rust, CSS, HTML, JSON, Markdown, shell, Python: **PASS** (11 grammars dynamically imported).
- Deleted / added / rename rendering: **PASS** (unit tests in `diffParser.test.ts`).
- aria roles preserved: **PASS**.

## Integration tests (carried from per-step commits)

| Test | Step | Status |
|------|------|--------|
| Apply summary event ordering | 2 | **GREEN** (`apply_summary_event_ordering_test.rs`) |
| Crash event per AgentError category | 5 | **GREEN** (six category round-trip tests under `orchestration/tests/crash_surface.rs`) |
| Per-file `unifiedDiff` in `SubtaskDiff` payload | 6 | **GREEN** (`subtask_diff_unified_diff_test.rs` + frontend parser test) |

## Visual regression (manual text observations)

Saved under `docs/retrospectives/phase-4-visuals/`:

- `01-running-to-done-transition.md` — per-worker state flip timing.
- `02-worker-log-expand-collapse.md` — ceiling adjustment rounds, content-fit behaviour.
- `03-diff-popover-open-close.md` — Shiki cold-load vs warm-cache, virtual-scroll jitter.
- `04-apply-summary-overlay.md` — overlay landing position, per-worker click → center.
- `05-worktree-actions-menu.md` — portal z-index, keyboard navigation, terminal-miss fallback.
- `06-crash-category-banner.md` — six category copies rendered against ErrorBanner.

## Scoreboard

| Metric | Target | Actual |
|--------|--------|--------|
| Frontend tests | ≥ 630 | **630 / 630** |
| Rust tests | ≥ 325 | **325 / 325** |
| `pnpm typecheck` | clean | **clean** |
| `pnpm lint` | clean | **clean** (1 pre-existing `react-hooks/incompatible-library` warning on `DiffBody` → `useVirtualizer`; not actionable until the upstream React Compiler rule) |
| `cargo clippy -- -D warnings` | clean | **clean** |
| `pnpm build` | succeeds, main bundle unchanged ±5KB | **main 709.32 kB gzip 220.71 kB** (Shiki + virtual-scroll split into async chunks) |
| CI green on every Phase 4 commit | yes | **yes** (see `git log 60e4199..HEAD`) |

## Gaps and regressions

- **Step 3 height ceiling required three iterations.** Originally 560px (spec), dropped to 420 after Step 6, then 340 after the content-fit conversion. Each drop was triggered by user screenshots on a 14" laptop, not by unit-test evidence. Reinforces Phase 3 Lesson #4: viewport-dependent UI needs human eyeballs, not just logic coverage.
- **Step 5 routing unchanged by design.** The spec explicitly kept retry routing stable; the field is surface-only. If Phase 5+ wants per-category routing (e.g., skip Layer 1 on `spawn-failed`), the discriminant is now on the wire.
- **Pre-existing ESLint warning on `useVirtualizer`.** React Compiler cannot memoize TanStack Virtual's returned functions. Non-actionable; tracked inline.
- **Visual regression remains manual.** Phase 3.5 Lesson #1 deferred a programmatic tool; Phase 4 continued to defer. Observations are text-only under `phase-4-visuals/`.

## Shipping

Phase 4 ships at `56f5925` (content-fit fix) with the docs commit following this verification.
