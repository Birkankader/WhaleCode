# WhaleCode Three-Phase Improvement Design

**Date:** 2026-03-13
**Status:** Approved
**Based on:** Panel Review Report (2026-03-13)
**Approach:** Stability first, then usability, then quality

---

## Phase 1: Stability (Priority: Critical)

### 1.1 Error Boundary + Toast Notification
- React Error Boundary wrapping each view in routes/index.tsx
- Fallback UI with "Something went wrong" + retry button
- Toast system using `sonner` library (lightweight, headless)
- Toast categories: success (green), error (red), warning (amber), info (blue)
- All IPC calls wrapped with try-catch, failures show toast

### 1.2 Confirmation Dialogs
- `useConfirmDialog` hook returning `{confirm, ConfirmDialog}`
- Triggers: merge branch, cancel task, retry task, clear session
- Modal overlay with description, cancel + confirm buttons
- Destructive actions use red confirm button

### 1.3 Process Timeout
- Master: 10 min default timeout
- Worker: 5 min default timeout
- Rust: `tokio::time::timeout()` wrapping `wait_for_turn_complete()` and worker wait
- On timeout: kill process, mark task as failed, emit timeout error event
- Frontend: show "Task timed out" status with retry option

### 1.4 Rate Limit Retry
- Wire `detect_rate_limit()` results into retry logic in orchestrator
- On rate limit: exponential backoff (5s, 10s, 20s base)
- Emit `[orchestrator] Rate limited: waiting Xs...` message
- Frontend: show countdown in task card status pill
- Max 3 rate-limit retries before marking as failed

### 1.5 Plan Cleanup
- After orchestration completes/fails, set 60s cleanup timer
- Remove plan from `orchestration_plans` HashMap after timer
- Also clean up associated process entries
- Frontend: plan data already captured in store, no loss

### 1.6 Remove Auto-PR Toggle
- Remove `autoPr` from uiStore
- Remove toggle from SetupPanel settings
- Keep code path in backend for future use (just disconnect UI)

### 1.7 Centralize Agent Config
- Create `src/lib/agents.ts` with AGENTS constant
- Contains: label, letter, gradient, color, model for each agent
- All components import from this single source
- Remove duplicate AGENT_ICON, AGENT_LABEL from 5+ files

---

## Phase 2: Usability

### 2.1 Structured JSON Events (Backend)
- Replace free-text orchestrator messages with typed JSON
- Event types: task_assigned, task_completed, task_failed, phase_changed, wave_progress, rate_limited, question_asked, skip, retry, fallback
- Frontend: single event handler with switch/case on type
- Remove all regex parsing from useTaskDispatch

### 2.2 Loading & Empty States
- Skeleton loader for Kanban cards during load
- Empty state illustrations for each view
- Loading spinners for IPC calls (merge, retry, detect)
- Progress indicator for long operations

### 2.3 Keyboard Shortcuts
- Cmd+K: Quick Task, Cmd+1-5: Tab switch
- Cmd+Enter: Run/Approve, Escape: Close panel
- Global useHotkeys hook

### 2.4 Session Persistence
- Zustand persist middleware for critical state
- Resume dialog on app launch
- Last 5 session history

### 2.5 Task Approval Screen
- Phase 1 completion shows editable task list
- Drag-drop reorder, agent reassign, add/remove tasks
- Approve & Start button

### 2.6 Terminal Redesign
- Two modes: orchestration (attached to master) and standalone (new interactive process)
- Auto-switch on orchestration completion

### 2.7 Config File + Question Relay
- `config.toml` for timeouts, retries, limits
- Complete worker question -> master relay -> user notification chain

---

## Phase 3: Quality

### 3.1 Error Type Hierarchy
- `thiserror` based WhaleError enum
- Structured error codes for frontend handling

### 3.2 Code Splitting
- useTaskDispatch -> 3 files
- TaskDetail -> 4 components
- SetupPanel -> 3 step components

### 3.3 Integration
- Context DB stats tracking
- Conflict detection at merge time
- Integration tests for orchestration flow

### 3.4 CSS Migration
- Inline styles -> Tailwind/CSS modules
- Consistent design token usage
