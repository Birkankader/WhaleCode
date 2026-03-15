# Changelog

All notable changes to WhaleCode will be documented in this file.

## [1.0.0] - 2026-03-15

### Added
- **Orchestration engine** — multi-agent task decomposition, wave-based execution, and DAG dependency tracking
- **Kanban working view** — real-time task board with status columns (pending, running, completed, failed)
- **Task approval workflow** — review and approve/reject decomposed sub-tasks before execution
- **Code review view** — inspect diffs and summaries after orchestration completes
- **Git view** — browse repository state and changes from within the app
- **Code view** — integrated code browser for project files
- **Usage view** — track token and API usage across agents
- **Terminal panel** — collapsible bottom panel with live orchestration output
- **Session history** — sidebar panel to browse and restore past sessions
- **Notification center** — in-app alerts for task completion, failures, and agent questions
- **Quick task popover** — rapid task entry without leaving the current view
- **Settings page** — API key management and developer mode toggle
- **Auto-approve mode** — optionally skip manual approval for decomposed tasks
- **Heartbeat reconciliation** — frontend/backend process state sync every 5 seconds
- **Lucide icons** — consistent icon system across sidebar and header navigation
- **Dark theme** — custom dark UI with accent color system (`wc-*` design tokens)
- **Error boundaries** — graceful fallback UI for every major view
- **Session naming** — label orchestration sessions for easy identification
