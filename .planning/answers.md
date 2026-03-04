# WhaleCode — Autonomous Decisions Log

**Date:** 2026-03-05
**Context:** User left for a meeting, delegated all remaining decisions.

## Requirements Scoping Decisions

### v1 — All of these are in scope

**Process Management (all 4):**
- Git worktree isolation per agent — mandatory for safe parallel execution
- Parallel execution (Claude Code + Gemini CLI) — core value proposition
- Cancel/pause per agent — safety control
- Per-tool output log — debugging and transparency

**Context & Intelligence (all 4):**
- Shared project context — eliminates re-explaining context to each tool
- Task history event log — Tool A knows what Tool B changed
- Automatic prompt optimization per tool — key differentiator, user selected this
- Intelligent task routing — user selected this

**Review & Safety (all 3 table stakes):**
- Diff review before commit — essential safety gate
- Conflict detection — must have before parallel execution
- Live agent status panel — user confidence during parallel runs

### v2 — Deferred

- Bounded autonomy controls (file allowlist/denylist) — nice but not critical for v1
- Task decomposition assistant — needs routing to be stable first
- AI conflict resolution suggestions — needs strong diff infrastructure first
- Codex CLI adapter (3rd tool) — add after 2-tool architecture is proven

### Out of Scope

- Built-in code editor — WhaleCode orchestrates, doesn't replace IDE
- Real-time agent-to-agent communication — research shows this hurts throughput
- Fully autonomous unattended operation — METR research shows it backfires
- Auto push to remote — safety risk
- More than 3 tools in v1 — scope control
- Windows/Linux — macOS first

## Workflow Config

- Mode: YOLO
- Granularity: Fine (8-12 phases)
- Parallelization: Yes
- Git tracking: Yes
- Research: Yes (per phase)
- Plan check: Yes
- Verifier: Yes
- Model profile: Quality (Opus for research/roadmap)

## Rationale

I included all table stakes + all user-selected differentiators (prompt optimization, task routing) in v1. This is ambitious but aligned with the user's "hepsi olacak" (all of them) response and explicit selection of all 4 context features. The research strongly supports this ordering — prompt optimization and task routing are the primary differentiators that no competitor offers.

---
*Written autonomously while user is in meeting*
