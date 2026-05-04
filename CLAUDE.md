# WhaleCode

> Your AI team, orchestrated visually.

WhaleCode is an AI orchestration platform. User writes a task, a master agent breaks it into subtasks, worker agents execute in parallel, user approves at critical moments. All visualized as a live execution graph.

This is **v2** — a full redesign from the original multi-agent tool into a focused orchestration platform.

## Core differentiator

> OpenCode is for talking to one agent. Claude Code is for managing one agent. WhaleCode is for running an AI team.

## Tech stack

- **Shell:** Tauri v2 (Rust core + WebView frontend), `tauri-plugin-dialog` for native pickers, `tauri-plugin-opener` for revealing paths, `tauri-plugin-sql` for frontend SQLite access
- **Frontend:** React 19 + TypeScript + Vite
- **Styling:** Tailwind CSS v4 (tokens declared via `@theme` CSS directive — **no shadcn**, write custom minimal components)
- **State:** Zustand (app state) + XState (graph/node state machines)
- **Graph:** React Flow (`@xyflow/react`) with custom nodes and Dagre (`@dagrejs/dagre`) auto-layout
- **Animation:** Framer Motion (spring-based)
- **Icons:** Lucide (used minimally)
- **Storage:** SQLite via `tauri-plugin-sql` + a Rust-side `sqlx` pool against the same DB file. Schema migrations live in `src-tauri/src/storage/migrations.rs`.
- **IDs:** `ulid` for run/subtask identifiers (sortable, URL-safe). `uuid` is pulled in for Tauri plumbing only — do not use `uuid` for domain ids.
- **Config:** YAML files under `.whalecode/` in the target repo; app-level settings as JSON at `app_config_dir/settings.json`.
- **Package manager:** pnpm (single source of truth; npm/yarn lockfiles must not be committed)

## The 7 architectural decisions

These define the product. Do not deviate without discussion.

| # | Decision | Choice |
|---|----------|--------|
| 1 | Master agent | User-selectable, smart default via fallback chain: Claude Code → Codex CLI. (Gemini is worker-only — too slow to plan with, usable on subtasks.) |
| 2 | Worker communication | Master-centric + shared notes (`.whalecode/notes.md`). No peer-to-peer. |
| 3 | Fail handling | Progressive: worker retry (max 1) → master re-plan (max 2) → human |
| 4 | Repo support | Single repo + mono-repo awareness. Multi-repo deferred to v3. |
| 5 | Cost tracking | Summary default (end-of-run bar), optional live counter toggle |
| 6 | Team collab | Solo v2 + config export/import via YAML. Cloud sync deferred to v3. |
| 7 | Headless | Auto-approve mode in v2. Dedicated server in v2.5. |

Details: `docs/architecture.md`

## Design language

- **Dark mode only.** Near-black background (`#0A0A0A`), off-white foreground (`#E8E8E8`).
- **One font family:** JetBrains Mono for everything. Inter only for long prose (help, release notes).
- **Minimal chrome.** No sidebar, no tabs, no toolbar. One canvas: the execution graph.
- **Whitespace over borders.** Spacing scale: 4, 8, 16, 24, 48 px. Nothing else.
- **Animation carries meaning.** No decorative motion. Every transition signals a state change.
- **Sentence case always.** No ALL CAPS, no Title Case.
- **Each agent gets a color** (amber for master, cyan/purple/green for workers). This is both aesthetic and functional.

Full design tokens: `docs/design-system.md`

## Directory structure

```
whalecode/
├── CLAUDE.md                    # This file — read automatically
├── docs/                        # Reference docs — read on demand
│   ├── architecture.md          # 7 decisions in depth
│   ├── design-system.md         # Colors, typography, spacing, animation
│   ├── ux-flows.md              # User journeys, approval moment, fail handling
│   ├── phase-1-spec.md          # Phase 1 (shipped)
│   ├── phase-2-spec.md          # Phase 2 (shipped)
│   ├── phase-3-spec.md          # Phase 3 (shipped)
│   ├── phase-3-spec-review.md   # Concerns flagged after Phase 2
│   ├── phase-4-spec.md          # Phase 4 (shipped)
│   ├── phase-4-verification.md  # Phase 4 goal-backward verification
│   ├── phase-4-crash-diagnostic.md # Phase 4 Step 0 diagnostic output
│   ├── phase-5-spec.md          # Phase 5 (shipped)
│   ├── phase-5-verification.md  # Phase 5 goal-backward verification
│   ├── phase-5-qa-diagnostic.md # Phase 5 Step 0 Q&A capability diagnostic
│   ├── phase-6-spec.md          # Phase 6 (shipped)
│   ├── phase-6-verification.md  # Phase 6 goal-backward verification
│   ├── phase-6-toolparsing-diagnostic.md # Phase 6 Step 0 tool-use parsing diagnostic
│   ├── phase-7-spec.md          # Phase 7 (shipped)
│   ├── phase-7-verification.md  # Phase 7 goal-backward verification
│   ├── phase-7-density-audit.md # Phase 7 Step 0 UI density audit
│   ├── phase-7-followup-diagnostic.md # Phase 7 Step 0 follow-up adapter diagnostic
│   ├── phase-8-preview.md       # Phase 8 candidates (multi-agent comparison + adaptive shape)
│   ├── KNOWN_ISSUES.md          # Debt ledger — deferred items + target phase + severity
│   ├── retrospectives/          # Post-phase retros
│   └── roadmap.md               # All 8 phases + v2.5/v3 track
├── src-tauri/                   # Rust backend
│   ├── src/
│   │   ├── agents/              # Agent adapters (claude/codex/gemini) + trait, prompts/, plan_parser, process spawn
│   │   ├── orchestration/       # Orchestrator, lifecycle task, dispatcher, registry, run state, shared notes, events
│   │   ├── worktree/            # Git worktree lifecycle (hidden from user)
│   │   ├── storage/             # SQLite schema + migrations, runs/subtasks/logs/parent_run_id tables (cost tables land in the Phase 9+ cost-aware suite)
│   │   ├── detection/           # CLI agent detector (PATH scan + version probe for claude/codex/gemini)
│   │   ├── settings.rs          # App-level settings (lastRepo, masterAgent, binary paths)
│   │   ├── repo.rs              # Repo picker + validation
│   │   ├── gitignore.rs         # `.whalecode/` gitignore helper
│   │   ├── ipc/                 # Command handlers + event contract mirror
│   │   └── lib.rs               # Tauri setup, plugin init, handler registration
│   └── Cargo.toml
├── src/                         # React frontend
│   ├── components/
│   │   ├── graph/               # React Flow canvas, custom nodes, edges
│   │   ├── nodes/               # MasterNode, WorkerNode, FinalNode variants
│   │   ├── approval/            # Approval bar, subtask proposal UI
│   │   ├── shell/               # TopBar (master chip), empty state, footer
│   │   └── primitives/          # Button, Input, Chip — custom, no shadcn
│   ├── state/                   # Zustand stores + XState machines
│   ├── hooks/                   # useAgentStream, useShortcuts, etc.
│   ├── lib/                     # IPC, formatters, cost helpers
│   └── App.tsx
└── .whalecode/                  # Project-level config (committed to target repos, not this one)
    ├── config.yaml
    └── templates/
```

## Code conventions

- **TypeScript strict mode.** No `any`. Use `unknown` + narrowing.
- **Rust**: `clippy` clean, `rustfmt`. Error types with `thiserror`, no `unwrap()` in non-test code.
- **Components**: Function components only. Hooks at the top. No class components.
- **Props**: Destructure in signature, not in body. Type with `type` not `interface` unless extending.
- **State**: Zustand for global UI state (graph nodes, current run). XState for node lifecycle. React state (`useState`) only for ephemeral UI (hover, expanded).
- **Naming**: `PascalCase` components, `camelCase` functions/variables, `SCREAMING_SNAKE` constants, `kebab-case` file names for non-components.
- **No default exports** except for pages/routes.
- **Imports**: External → absolute internal → relative. Blank line between groups.
- **Comments**: Explain *why*, not *what*. Code should be self-documenting for *what*.

## Things to NEVER do

- Do not add a left-edge navigation sidebar. The graph is the navigation. (The right-edge `InlineDiffSidebar` shipped in Phase 7 Step 1 is content, not navigation — it absorbed the DiffPopover modal per the "remove ≥1 modal" obligation. New right-edge surfaces still require the same absorption justification.)
- Do not use shadcn/ui. Write custom minimal components.
- Do not add tabs or multi-page routing. One canvas, one flow.
- Do not use modals for approval. Use the sticky bottom bar.
- Do not use gradients, glows, or shadows beyond what `docs/design-system.md` specifies.
- Do not add 600 or 700 font-weights. Only 400 (regular) and 500 (medium). The token and prop name is `medium`; never use the label "semibold".
- Do not hard-code colors. Use Tailwind config tokens.
- Do not use `unwrap()` or `.expect()` in Rust production paths.
- Do not expose worktree paths in UI. They are an implementation detail. **Carve-out:** paths are exposed on workers in inspectable states (done / failed / human_escalation / cancelled) via the WorktreeActions menu only (Phase 4 Step 4). Running/proposed/waiting cards must never expose them.

## When you (Claude Code) start a session

1. You already have this file. Don't re-read it unless I say so.
2. For any specific area, read the matching `docs/` file. Don't read all of them.
3. If the task is in a specific phase, read the matching `docs/phase-N-spec.md` first (Phase 7 is shipped — see `docs/phase-7-verification.md` and `docs/retrospectives/phase-7.md`; Phase 8 spec is not yet written, candidates previewed at `docs/phase-8-preview.md`).
4. When in doubt about design decisions, check `docs/architecture.md` section 11.
5. For UI specifics (colors, spacing, animation timing), check `docs/design-system.md`.
6. Before starting work, skim `docs/KNOWN_ISSUES.md` so you don't re-open already-triaged debt.

## Current status

**Active phase:** Phase 8 — spec unwritten (awaiting real-usage data from Phase 7 shipment; candidates previewed at `docs/phase-8-preview.md`)
**Last shipped:** Phase 7 — information density without UI weight (Step 8 close-out commit, 2026-05-04; first Phase 7 commit `5ebbff4`, 2026-05-03)
**Phase 8 candidates (not commitments):** *multi-agent same-task comparison* + *adaptive single-vs-multi-agent execution* (Phase 8 preview spec at `docs/phase-8-preview.md`); plus existing candidates carrying over: threaded run history view (parent_run_id schema exists, no UI consumes it yet), WorktreeActions context-menu density, ToastStack auto-dismiss density, Q&A false-positive heuristic calibration, Gemini activity-chip fidelity gap, per-worker hint counter affordance, base-branch terminal affordance in conflict resolver, debug-only failure injection, programmatic visual regression pilot, mono-repo planning awareness, rate-limit classification + backoff. Cost-aware feature suite cluster pushed to Phase 9+. Spec writes after users run real work on the shipped Phase 7 surface; observations collect in `docs/phase-8-observations.md`.

Phase 7 is closed: 5/5 goal-criteria PASS, 33/33 step-level acceptance PASS, frontend 992/992 (Step 7 cross-step coverage at 1007 minus 15 DiffPopover tests removed in Step 8 — net +35 over Step 6 baseline of 957), Rust 423/423 (cargo test at `--test-threads=4`; replan-lineage flake re-confirmed at default threads, monitor-only per KNOWN_ISSUES line 46), typecheck/clippy/build clean, lint clean modulo 2 documented warnings (DiffBody useVirtualizer + ElapsedCounter exports). Verification at `docs/phase-7-verification.md`; retro at `docs/retrospectives/phase-7.md`; seven text visual observations under `docs/retrospectives/phase-7-visuals/`; UI density audit + follow-up adapter diagnostic at `docs/phase-7-density-audit.md` + `docs/phase-7-followup-diagnostic.md` (Step 0 spike). Phase 6 verification + retro remain at `docs/phase-6-verification.md` / `docs/retrospectives/phase-6.md`; Phase 5 at `docs/phase-5-verification.md` / `docs/retrospectives/phase-5.md`; Phase 4 at `docs/phase-4-verification.md` / `docs/retrospectives/phase-4.md`. Phase 3.5 retro at `docs/retrospectives/phase-3.5.md`; Phase 3 retro at `docs/retrospectives/phase-3.md`. Open debt carried into Phase 8 is tracked in `docs/KNOWN_ISSUES.md`; read that first before picking up new work.

## Useful commands

```bash
# Dev
pnpm tauri dev                    # Full stack dev mode
pnpm dev                          # Frontend only (with mock IPC)

# Build
pnpm tauri build                  # Production build

# Test
pnpm test                         # Frontend tests (Vitest)
cargo test --manifest-path src-tauri/Cargo.toml   # Rust tests

# Quality
pnpm lint                         # ESLint
pnpm typecheck                    # tsc --noEmit
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```
