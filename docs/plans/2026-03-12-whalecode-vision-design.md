# WhaleCode Vision Design

**Date:** 2026-03-12
**Status:** Active

## Overview

WhaleCode is a multi-platform desktop application that orchestrates multiple AI CLI agents (Claude Code, Gemini CLI, Codex CLI) on shared coding projects. Users configure a master agent (orchestra conductor) and workers, then assign tasks via a visual UI.

## Core Workflow

```
Scan CLIs → Select Master + Workers → Submit Task
  → Master Decomposes → User Approves Task List (Kanban)
  → Workers Execute in Worktrees → Completion Signals
  → Master Code Review → User Code Review (optional)
  → Auto-PR per Worktree → Auto-Merge (if enabled)
```

## Feature Specifications

### 1. CLI Detection & Login Scanning

**Goal:** Auto-detect installed AI CLIs and their auth status.

**Implementation:**
- Run `which claude`, `which gemini`, `which codex` to detect installed CLIs
- Check login status:
  - Claude: `claude auth status` or check `~/.claude/` config
  - Gemini: Check `~/.config/gemini/` or environment variable
  - Codex: Check `OPENAI_API_KEY` in keychain/env
- Backend: New `detect_agents` Tauri command returns `Vec<DetectedAgent>`
- Frontend: Agents without auth shown as disabled with "Need Auth" badge
- Re-scan on app launch and on-demand refresh button

**Types:**
```rust
struct DetectedAgent {
    tool_name: String,
    installed: bool,
    binary_path: Option<String>,
    version: Option<String>,
    auth_status: AuthStatus,
}

enum AuthStatus {
    Authenticated,
    NeedsAuth,
    Unknown,
}
```

### 2. Task Decomposition Approval

**Goal:** After master decomposes, show task list for user approval before execution.

**Flow:**
1. Master returns `DecompositionResult` (already exists)
2. New `OrchestrationPhase::AwaitingApproval` phase
3. Frontend renders editable task list
4. User can: modify task descriptions, reassign agents, add/remove tasks
5. User clicks "Approve" → execution begins
6. User clicks "Reject" → sends feedback to master for re-decomposition

**Backend changes:**
- Add `approve_decomposition(plan_id, modified_tasks)` command
- Add `reject_decomposition(plan_id, feedback)` command
- Pause orchestration between decompose and execute phases

### 3. Kanban Board

**Goal:** Visual task tracking with drag-and-drop.

**Columns:**
- **Backlog** — Tasks from decomposition, not yet started
- **In Progress** — Workers actively executing
- **Review** — Worker completed, awaiting code review
- **Merge Waiting** — Code review passed, awaiting merge
- **Done** — Merged successfully

**Card contents:**
- Task title/description
- Assigned agent (with color indicator)
- Status badge
- Elapsed time
- Worker output preview (expandable)

**Interactions:**
- Drag cards between columns (only during approval phase for reassignment)
- Click card → expand to see full output
- Agent avatar with status indicator

### 4. Code Review Flow

**Goal:** Master reviews all worker output, then user optionally reviews.

**Flow:**
1. All workers complete → phase becomes `Reviewing`
2. Master agent receives review prompt with all worker results and diffs
3. Master outputs structured review: approvals, concerns, suggestions
4. Frontend shows review summary with per-file feedback
5. User can:
   - Accept master's review → proceed to PR
   - Add comments → sends to master for re-review
   - Override and approve/reject specific files

**Backend:**
- `submit_review_feedback(plan_id, feedback)` command
- `accept_review(plan_id)` command
- Master receives user feedback in interactive stdin

### 5. Auto-PR and Merge

**Goal:** Each completed worktree creates a PR, optionally auto-merged.

**Flow:**
1. After review approval, for each worktree:
   - Create commit with descriptive message (task description + agent info)
   - Push branch to remote
   - Create PR via `gh pr create` with body including master's review
2. Settings: `auto_merge: bool` (default false)
3. If auto_merge enabled: `gh pr merge --squash` after PR creation
4. If not: PR stays open for manual merge

**Backend:**
- `create_pull_request(plan_id, worktree_branch)` command
- `merge_pull_request(plan_id, pr_number)` command
- Settings stored in app config

### 6. Developer Mode

**Goal:** Direct terminal access to each agent for power users.

**Toggle:** Settings → Developer Mode (default: off)

**When enabled:**
- Each agent card in Kanban/output view gets "Terminal" button
- Clicking opens full xterm terminal for that agent's process
- User can type commands directly to agent's stdin
- All user input shown in messenger panel as `UserIntervention` message type
- Agent responses shown in real-time

**Implementation:**
- Reuse existing `send_to_process()` IPC command
- New `DeveloperTerminal` component wrapping `OutputConsole` with input
- Track user interventions as `MessengerMessage` events

### 7. Quota & Usage Tracking

**Goal:** Show per-agent token usage and remaining quota.

**Data sources:**
- Parse `total_cost_usd`, token counts from agent result events
- Track cumulative usage per session and per task

**UI:**
- Dedicated "Usage" tab in sidebar
- Per-agent breakdown: tokens used, estimated cost, rate limit status
- Session totals
- Visual bars showing usage relative to known limits
- Rate limit warnings with cooldown timer

**Types:**
```rust
struct AgentUsage {
    tool_name: String,
    session_tokens_in: u64,
    session_tokens_out: u64,
    session_cost_usd: f64,
    task_count: u32,
    last_rate_limit: Option<RateLimitInfo>,
}
```

### 8. UI Design (Conductor-inspired)

**Layout:**
- Left sidebar: Logo, nav (Orchestrator, Kanban, Usage, Worktrees, Settings)
- Main area: Adaptive based on current phase
  - Setup → Agent selector + prompt input
  - Approval → Kanban board (editable)
  - Execution → Kanban board (live updates) + split terminal output
  - Review → Diff viewer + review comments
  - Merge → PR status list

**Theme:**
- Dark mode default (already implemented)
- Agent color coding: Claude=violet, Gemini=blue, Codex=emerald
- Gradient accents on active elements
- Smooth transitions between phases

## Implementation Priority

1. CLI Detection & Login Scanning (foundation for agent selection)
2. Task Approval Step (required before Kanban)
3. Kanban Board (visual task management)
4. Code Review Flow (post-execution workflow)
5. Auto-PR & Merge (completion workflow)
6. Developer Mode (power user feature)
7. Quota Tracking (monitoring)
8. UI Polish (ongoing)
