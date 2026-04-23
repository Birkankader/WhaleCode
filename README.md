# WhaleCode

> Your AI team, orchestrated visually.

WhaleCode is a native desktop app for running an AI team on a shared repo.
Write a task. A master agent breaks it into subtasks. Worker agents execute
in parallel, each in its own git worktree. You approve at critical moments.
The whole run is visualized as a live execution graph — no sidebar, no tabs,
no modals.

**Status:** v2 active development. Phases 1–5 shipped. See
[`CLAUDE.md`](./CLAUDE.md) for current phase + architecture overview and
[`docs/`](./docs/) for phase specs, verification, retrospectives.

## Core differentiator

> OpenCode is for talking to one agent. Claude Code is for managing one agent.
> WhaleCode is for running an AI team.

## What ships today

| Phase | Theme | Status |
|---|---|---|
| 1 | Shell + planning | shipped |
| 2 | Worker dispatch + merge | shipped |
| 3 | Retry ladder + Layer 3 escalation | shipped |
| 3.5 | Cancel cleanup + master heartbeat + zoom controls | shipped |
| 4 | Visibility (apply summary, log expand, worktree affordances, crash categories, inline diffs) | shipped |
| 5 | Unblock the run (per-worker stop, base-branch dirty stash, conflict resolver UX, interactive Q&A) | shipped |
| 6+ | Cost tracking, mono-repo awareness, safety gate policy, headless server | planned |

Full roadmap: [`docs/roadmap.md`](./docs/roadmap.md).

## Architecture — 7 decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Master agent | User-selectable; smart default via Claude Code → Codex CLI fallback chain (Gemini is worker-only — too slow to plan with) |
| 2 | Worker comms | Master-centric + shared notes (`.whalecode/notes.md`). No peer-to-peer |
| 3 | Fail handling | Layer 1 worker retry (max 1) → Layer 2 master re-plan (max 2) → Layer 3 human |
| 4 | Repo support | Single repo + mono-repo awareness (Phase 6). Multi-repo → v3 |
| 5 | Cost tracking | Summary default, optional live counter toggle |
| 6 | Team collab | Solo v2 + config export/import via YAML. Cloud sync → v3 |
| 7 | Headless | Auto-approve mode in v2. Dedicated server in v2.5 |

Details: [`docs/architecture.md`](./docs/architecture.md).

## Supported agents

| Agent | CLI | Role |
|---|---|---|
| Claude Code | `claude` | Master + worker |
| Codex CLI | `codex` | Master + worker |
| Gemini CLI | `gemini` | Worker only (Phase 4 Step 1 — upstream latency makes it impractical as master) |

## Tech stack

- **Shell:** Tauri v2 (Rust core + WebView frontend), `tauri-plugin-dialog`,
  `tauri-plugin-opener`, `tauri-plugin-sql`
- **Frontend:** React 19 + TypeScript + Vite
- **Styling:** Tailwind CSS v4 (tokens via `@theme`). Dark-mode only. No shadcn
- **State:** Zustand (app) + XState (per-node machines)
- **Graph:** React Flow (`@xyflow/react`) + Dagre auto-layout
- **Animation:** Framer Motion
- **Icons:** Lucide (minimal)
- **Storage:** SQLite via `tauri-plugin-sql` (frontend reads) + `sqlx` pool
  (Rust writes) against the same DB file
- **IDs:** `ulid` for run/subtask ids (sortable, URL-safe)
- **Syntax highlighting:** Shiki (lazy-loaded `dark-plus` theme, 11 grammars)
- **Package manager:** pnpm (single source of truth)

## Design language

- Dark mode only. `#0A0A0A` background, `#E8E8E8` foreground.
- One font: JetBrains Mono for everything; Inter only for long prose.
- Minimal chrome. One canvas: the execution graph.
- Whitespace over borders. Spacing scale: 4, 8, 16, 24, 48 px.
- Animation carries meaning — no decorative motion.
- Each agent has a color: amber for master, cyan/purple/green for workers.

Full tokens: [`docs/design-system.md`](./docs/design-system.md).

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [pnpm](https://pnpm.io/) v9+
- [Rust](https://www.rust-lang.org/tools/install) stable
- [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)
- At least one of: `claude`, `codex`, or `gemini` CLI on PATH

### Install + run

```bash
pnpm install

# Full stack dev mode (Tauri shell + Vite HMR)
pnpm tauri dev

# Frontend only (with mock IPC — no Rust rebuild loop)
pnpm dev

# Production build
pnpm tauri build
```

### Credentials

Each supported CLI uses its own auth flow (API key, OAuth, etc.). WhaleCode
doesn't store credentials itself — if the CLI runs from your terminal, it
runs from WhaleCode. Configure via the CLI's own settings.

## Useful commands

```bash
pnpm test                                                  # Frontend (Vitest)
cargo test --manifest-path src-tauri/Cargo.toml            # Rust

pnpm typecheck                                             # tsc --noEmit
pnpm lint                                                  # ESLint
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

## Directory structure

```
whalecode/
├── CLAUDE.md                      # Claude Code's entry point — architecture + current phase
├── README.md                      # This file
├── docs/
│   ├── architecture.md            # The 7 decisions in depth
│   ├── design-system.md           # Colors, typography, spacing, animation
│   ├── ux-flows.md                # User journeys + approval moment + fail handling
│   ├── phase-N-spec.md            # Per-phase specs (1–5 shipped)
│   ├── phase-N-verification.md    # Goal-backward PASS/FAIL verdicts
│   ├── phase-N-*-diagnostic.md    # Step 0 diagnostics (Phase 4 crash, Phase 5 Q&A)
│   ├── KNOWN_ISSUES.md            # Debt ledger — deferred items + severity
│   ├── retrospectives/            # Post-phase retros + text visual observations
│   └── roadmap.md                 # 8 phases + v2.5 / v3 tracks
├── src-tauri/                     # Rust backend
│   ├── src/agents/                # Adapters (claude/codex/gemini) + shared process + prompts
│   ├── src/orchestration/         # Dispatcher + lifecycle + run state + events
│   ├── src/worktree/              # Git worktree lifecycle (hidden from user)
│   ├── src/storage/               # SQLite schema + migrations
│   ├── src/detection/             # CLI PATH scan + version probe
│   └── src/ipc/                   # Tauri command handlers + wire event contract
└── src/                           # React frontend
    ├── components/graph/          # React Flow canvas + edges
    ├── components/nodes/          # MasterNode, WorkerNode, FinalNode variants
    ├── components/approval/       # Sticky approval bar
    ├── components/shell/          # TopBar, ErrorBanner, StashBanner, ConflictResolverPopover
    ├── state/                     # Zustand store + XState per-node machines
    └── lib/                       # IPC wrappers + run subscription + schemas
```

## Things to NEVER do

These are load-bearing design rules, not preferences:

- No sidebar. The graph is the navigation.
- No shadcn/ui. Custom minimal primitives only.
- No modals for approval. Sticky bottom bar.
- No `unwrap()` / `.expect()` in Rust production paths.
- No exposing worktree paths in UI (narrow carve-out: post-run WorktreeActions
  menu on `done` / `failed` / `human_escalation` / `cancelled` states — see
  Phase 4 Step 4).

Full list: [`CLAUDE.md`](./CLAUDE.md) → "Things to NEVER do".

## Contributing

v2 is pre-1.0. Phase 6+ scope locks after real-usage data from Phase 5.
No external contributors yet. Issues + ideas welcome.

## License

MIT
