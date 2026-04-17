# WhaleCode

> Your AI team, orchestrated visually.

WhaleCode is an AI orchestration platform. User writes a task, a master agent breaks it into subtasks, worker agents execute in parallel, user approves at critical moments. All visualized as a live execution graph.

This is **v2** — a full redesign from the original multi-agent tool into a focused orchestration platform.

## Core differentiator

> OpenCode is for talking to one agent. Claude Code is for managing one agent. WhaleCode is for running an AI team.

## Tech stack

- **Shell:** Tauri v2 (Rust core + WebView frontend)
- **Frontend:** React 18 + TypeScript + Vite
- **Styling:** Tailwind CSS (custom config — **no shadcn**, write custom minimal components)
- **State:** Zustand (app state) + XState (graph/node state machines)
- **Graph:** React Flow (xyflow) with custom nodes and Dagre auto-layout
- **Animation:** Framer Motion (spring-based)
- **Icons:** Lucide (used minimally)
- **Storage:** SQLite (via Tauri SQL plugin) for runs, templates, cost logs
- **Config:** YAML files under `.whalecode/` in the target repo

## The 7 architectural decisions

These define the product. Do not deviate without discussion.

| # | Decision | Choice |
|---|----------|--------|
| 1 | Master agent | User-selectable, smart default via fallback chain: Claude Code → Codex CLI → Gemini CLI |
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
│   ├── phase-1-spec.md          # Current phase spec
│   └── roadmap.md               # All 8 phases + v2.5/v3 track
├── src-tauri/                   # Rust backend
│   ├── src/
│   │   ├── agents/              # Agent process management (Claude Code, Gemini, Codex adapters)
│   │   ├── orchestration/       # Master/worker coordination, shared notes, retry logic
│   │   ├── worktree/            # Git worktree lifecycle (hidden from user)
│   │   ├── storage/             # SQLite schema, run history, cost logs
│   │   ├── detection/           # Mono-repo detector (pnpm, turbo, nx, cargo, go.work)
│   │   ├── safety/              # Destructive command gates, budget enforcement
│   │   └── tokenizer/           # Per-provider token counting + pricing
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

- Do not add a sidebar. The graph is the navigation.
- Do not use shadcn/ui. Write custom minimal components.
- Do not add tabs or multi-page routing. One canvas, one flow.
- Do not use modals for approval. Use the sticky bottom bar.
- Do not use gradients, glows, or shadows beyond what `docs/design-system.md` specifies.
- Do not add 600 or 700 font-weights. Only 400 and 500 (labeled "semibold").
- Do not hard-code colors. Use Tailwind config tokens.
- Do not use `unwrap()` or `.expect()` in Rust production paths.
- Do not expose worktree paths in UI. They are an implementation detail.

## When you (Claude Code) start a session

1. You already have this file. Don't re-read it unless I say so.
2. For any specific area, read the matching `docs/` file. Don't read all of them.
3. If the task is in a specific phase, read `docs/phase-1-spec.md` (or current phase) first.
4. When in doubt about design decisions, check `docs/architecture.md` section 11.
5. For UI specifics (colors, spacing, animation timing), check `docs/design-system.md`.

## Current status

**Active phase:** Phase 1 — Graph Foundation
**Target:** Working demo of mock master-worker orchestration rendered as execution graph

See `docs/phase-1-spec.md` for the actionable spec.

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
