# WhaleCode

> **v2 redesign in progress.** The content below describes v1 and is preserved for reference only. The product is being rebuilt around a single live execution graph — see [CLAUDE.md](./CLAUDE.md) and [docs/phase-1-spec.md](./docs/phase-1-spec.md) for the current scope. This README will be rewritten at launch prep (Phase 8). Build and run instructions below are not guaranteed to work during the v2 rewrite.

---

A native desktop app that orchestrates multiple CLI-based AI coding agents on shared projects. Built with Tauri v2 (Rust) and React.

## Supported Agents

| Agent | CLI | Mode |
|-------|-----|------|
| **Claude Code** | `claude` | `--output-format stream-json --verbose` |
| **Gemini CLI** | `gemini` | `--output-format stream-json --yolo` |
| **Codex CLI** | `codex` | `--output-format stream-json --full-auto` |

## Features

- **Multi-agent orchestration** — Run multiple AI agents on the same task simultaneously with split/tabbed output views
- **Git worktree isolation** — Each agent task runs in its own worktree under `.whalecode-worktrees/`, keeping work isolated
- **Smart routing** — Keyword-based heuristics suggest the best agent for your prompt
- **Real-time streaming** — NDJSON stream parsing with live terminal output via xterm.js
- **Diff review** — Review agent-generated changes with an inline diff viewer before merging
- **Secure credential storage** — API keys stored in macOS Keychain, never passed as CLI arguments
- **Prompt context engine** — Enriches prompts with project context from a local SQLite store

## Tech Stack

- **Backend**: Rust, Tauri v2, tokio, serde, rusqlite, keyring
- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS 4, Zustand, shadcn/ui
- **IPC**: tauri-specta for type-safe auto-generated TypeScript bindings

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)
- At least one of: `claude`, `gemini`, or `codex` CLI installed

### Install & Run

```bash
# Install frontend dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

### API Keys

Configure API keys through the in-app settings (stored in macOS Keychain):

- **Claude Code** → `ANTHROPIC_API_KEY`
- **Gemini CLI** → `GEMINI_API_KEY`
- **Codex CLI** → `OPENAI_API_KEY`

## Project Structure

```
src/                        # React frontend
├── components/
│   ├── layout/             # AppShell, Sidebar
│   ├── terminal/           # ProcessPanel, OutputConsole
│   ├── orchestration/      # AgentSelector, MultiAgentOutput
│   └── review/             # DiffReview
├── hooks/                  # useTaskDispatch, useProcess, useWorktree
├── stores/                 # Zustand stores
└── lib/                    # Event formatters (claude, gemini, codex)

src-tauri/src/              # Rust backend
├── adapters/               # ToolAdapter trait + per-agent implementations
├── commands/               # Tauri IPC command handlers
├── credentials/            # Keychain integration
├── process/                # Subprocess manager with streaming
├── prompt/                 # Prompt engine & templates
├── router/                 # Task router & orchestrator
├── worktree/               # Git worktree lifecycle & conflict detection
└── context/                # SQLite-backed project context store
```

## License

MIT
