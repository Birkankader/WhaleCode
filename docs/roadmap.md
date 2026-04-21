# Roadmap

Compact overview of all phases. Use this to plan your session. Read the corresponding `phase-N-spec.md` for detailed specs of the phase you're currently working on.

## v2.0 target: ~10-13 weeks full-time

### Phase 1 — Graph foundation (1-2 weeks)

Visual layer on mock data. No real agents yet.

- Project scaffolding (Tauri, React, Tailwind, Zustand, XState, React Flow)
- Node state machine
- Master, Worker, Final node components
- Empty state, top bar, approval bar
- Mock orchestration demo flow
- **Deliverable:** End-to-end visual demo with all node states and transitions working

### Phase 2 — Agent integration (2-3 weeks)

Wire the graph to actual agent processes.

- Smart default master selection (fallback chain detection)
- Agent adapters: Claude Code, Codex CLI, Gemini CLI
- Real streaming log rendering
- Git worktree lifecycle (hidden from user)
- Shared notes implementation (`.whalecode/notes.md`)
- IPC layer (Tauri commands + events)
- **Deliverable:** Real agents executing real tasks, rendered as graph

### Phase 3 — Approval flow and progressive retry (2 weeks)

Human-in-the-loop and fail recovery.

- Subtask proposal UI with "Why?" explanations
- Approval bar interactions (individual checkboxes, reject, approve)
- Layer 1: Worker retry with error context
- Layer 2: Master re-plan with loop protection
- Layer 3: Human escalation UI
- **Deliverable:** Full HITL and fail recovery working on real agents

### Phase 4 — Mono-repo awareness and final merge (1-2 weeks)

Make it useful in real-world repos.

- Mono-repo detector (pnpm, turbo, nx, cargo, go.work signals)
- Package-aware planning by master
- Package chips in subtask nodes
- Aggregate diff preview
- Conflict resolution UI (inline for simple, external for complex)
- Apply / Discard actions
- Run summary bar
- **Deliverable:** Can run WhaleCode on a real mono-repo end-to-end

### Phase 5 — Config system and templates (1 week)

Config-as-code.

- `.whalecode/config.yaml` reading/writing
- `.whalecode/templates/*.yaml` template system
- Template application via `⌘K → Apply template`
- Template export/import via clipboard
- Auto-integration of CLAUDE.md, AGENTS.md, GEMINI.md into master context
- **Deliverable:** Projects can commit their WhaleCode config; teams can share templates via Git

### Phase 6 — Cost tracking and polish (1-2 weeks)

Transparency layer.

- Per-provider tokenizer integration
- Pricing config (editable YAML)
- Run-summary cost bar
- Optional live cost counter (settings toggle)
- Soft budget warnings
- Command palette (`⌘K`)
- Run history
- Full keyboard shortcut system
- **Deliverable:** Feature-complete v2.0

### Phase 7 — Auto-approve and background mode (1 week)

The overnight use case.

- Auto-approve toggle with warning modal
- Safety gates (destructive commands, .env writes, credential egress, budget)
- Budget cap enforcement
- macOS background mode (dock hidden, menu bar icon)
- Native notifications (task complete, failed, budget exceeded)
- Optional caffeinate integration
- **Deliverable:** Can start a run, close the laptop lid (with caffeinate), wake up to completed work

### Phase 8 — Launch prep (1 week)

Ship it.

- Landing page redesign (graph-centric)
- 60-second demo video
- README rewrite
- Show HN / Product Hunt / Twitter prep
- **Deliverable:** v2.0.0 release

## Post-v2 track

### v2.1 (Fast follow)

Hard budget enforcement. Improved telemetry. Bug fixes from v2.0 launch.

### v2.5 — WhaleCode Server

Separate release: headless execution.

- `whalecode-server` Rust binary + Docker image
- Remote connect from desktop app
- SSH key-based auth
- Mobile web UI (read-only + approve buttons)
- Push notifications (ntfy.sh, Telegram)

### v3 — Team platform

- Cloud backend (auth, workspaces, billing)
- Full real-time collaboration
- Template marketplace
- Multi-repo workspace support
- Usage dashboards
- Task-based intelligent routing (master auto-selection)

## When starting a new phase

1. Read this file to remember context.
2. Read `docs/phase-N-spec.md` for the specific phase.
3. Check dependencies — don't start Phase 3 if Phase 2 isn't functional.
4. Open a git branch: `phase-N-feature-name`.
5. Work in small commits. One feature per commit.
