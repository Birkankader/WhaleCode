# WhaleCode

## What This Is

WhaleCode is a macOS desktop application that orchestrates multiple AI coding tools (Claude Code, Gemini CLI, Codex CLI) from a single interface. It intelligently distributes tasks across tools, maintains shared project context so each tool knows what the others have done, and automatically optimizes prompts for each tool's strengths — enabling parallel AI-assisted development without coordination overhead.

## Core Value

Multiple AI coding tools working in parallel on the same project, fully aware of each other's changes and sharing a unified context, so the developer gets faster and more coherent results than using any tool alone.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Intelligent task distribution across AI coding tools
- [ ] Shared project memory (code structure, files, past decisions)
- [ ] Task history awareness (Tool A knows what Tool B changed)
- [ ] Automatic prompt optimization per tool
- [ ] Parallel task execution with conflict detection
- [ ] Unified interface for monitoring and controlling all tools

### Out of Scope

- Windows/Linux support — macOS first, cross-platform later
- More than 3 tools in v1 — start with Claude Code + one other, expand later
- Real-time collaboration between tools — async coordination is sufficient for v1
- Built-in code editor — WhaleCode orchestrates, doesn't replace the IDE

## Context

- AI coding tools (Claude Code, Gemini CLI, Codex CLI) each have different APIs, CLIs, and strengths
- Currently no way to share context between them — each runs in isolation
- When running tools in parallel, they can make conflicting changes to the same files
- Each tool has different prompt formats and conventions for best results
- The developer currently spends significant time re-explaining context to each tool and manually resolving conflicts
- Tauri (Rust backend + web frontend) chosen for lightweight native macOS experience

## Constraints

- **Tech stack**: Tauri v2 with Rust backend and web frontend — lightweight, native macOS feel
- **Integration**: Hybrid approach — use APIs where available, fall back to CLI wrapping
- **v1 scope**: Claude Code + one other tool (likely Gemini CLI), with architecture ready for more
- **Platform**: macOS only for v1

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Tauri over Electron/Swift | Lightweight + web frontend flexibility + Rust performance | — Pending |
| Hybrid API/CLI integration | Maximum compatibility — API when possible, CLI fallback | — Pending |
| 2 tools for v1 | Reduce scope, validate core orchestration concept first | — Pending |
| Automatic prompt optimization | Key differentiator — user writes once, each tool gets optimized version | — Pending |
| Task distributor model | App decides which tool handles what, rather than manual assignment | — Pending |

---
*Last updated: 2026-03-05 after initialization*
