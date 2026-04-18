# Phase 2: Agent integration

**Goal:** Replace `mockOrchestration.ts` with a real orchestration engine that spawns Claude Code, Codex CLI, and Gemini CLI as subprocesses, manages git worktrees per subtask, streams their output into the existing graph UI, and implements the master-centric + shared notes communication model from `docs/architecture.md` section 2.

**Duration estimate:** 2-3 weeks

**Success criteria:**
- User submits a real task on a real git repo
- Master (default: Claude Code, fallback chain applies) analyzes the repo, produces real subtasks
- User approves, worker agents run in real subprocesses, each isolated in its own git worktree
- Streaming output flows from subprocess stdout/stderr into the node log blocks already built in Phase 1
- Subtasks complete, final node shows a real aggregate diff
- Apply merges worktrees into the source branch; Discard cleans them up
- No worktree leaks on any exit path (crash, cancel, error, normal completion)

## What this phase does NOT include

Defer these to later phases:
- Progressive retry logic (Phase 3) — for now, any failure goes straight to user
- Subtask editing (Phase 3)
- Mono-repo awareness in planning (Phase 4)
- Config files / templates (Phase 5)
- Cost tracking (Phase 6)
- Auto-approve / safety gates (Phase 7)

Keep the UX surface identical to Phase 1. This phase is almost entirely backend. The only visible changes: real content instead of mocks, and one new startup-time surface (onboarding when no agents detected).

## Prerequisites

Before starting, confirm Phase 1 is actually shipped: all three responsive states verified via screenshot, 61+ tests passing, gates green on main. Phase 2 cannot proceed on top of broken visual foundation.

## Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│  React frontend (Phase 1 UI)                                 │
│  - GraphCanvas, nodes, approval bar, empty state             │
│  - Zustand graphStore (reads only — actions delegate to IPC) │
└──────────────────────────────┬──────────────────────────────┘
                               │ Tauri IPC (commands + events)
┌──────────────────────────────┴──────────────────────────────┐
│  Rust backend (new in Phase 2)                              │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  detector   │  │ orchestrator│  │  agent adapters     │ │
│  │  - which    │  │  - plan     │  │  - claude-code      │ │
│  │    agents?  │  │  - dispatch │  │  - codex-cli        │ │
│  │  - PATH     │  │  - collect  │  │  - gemini-cli       │ │
│  │    scan     │  │             │  │  (trait: AgentImpl) │ │
│  └─────────────┘  └──────┬──────┘  └──────────┬──────────┘ │
│                          │                     │             │
│                   ┌──────┴──────┐        ┌────┴────┐        │
│                   │  worktree   │        │ streaming│        │
│                   │  - create   │        │  - stdout│        │
│                   │  - cleanup  │        │  - stderr│        │
│                   │  - merge    │        │  - chunk │        │
│                   └─────────────┘        └─────────┘        │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  storage (SQLite via tauri-plugin-sql)               │  │
│  │  runs, subtasks, logs (append-only), run_cost_logs   │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

The React side's `graphStore` becomes a thin mirror of backend state. Actions (submitTask, approveSubtasks, etc.) invoke Tauri commands. The backend pushes state updates via events, which the store applies.

## Step-by-step tasks

### Step 1: Tauri IPC scaffolding and event contract

Before any real subprocess code, design the wire protocol between frontend and backend.

**Commands (frontend → backend):**
- `submit_task(input: String, repo_path: String) -> Result<RunId, String>`
- `approve_subtasks(run_id: RunId, subtask_ids: Vec<String>) -> Result<(), String>`
- `reject_run(run_id: RunId) -> Result<(), String>`
- `apply_run(run_id: RunId) -> Result<(), String>`
- `discard_run(run_id: RunId) -> Result<(), String>`
- `cancel_run(run_id: RunId) -> Result<(), String>`
- `detect_agents() -> AgentDetectionResult`
- `set_master_agent(agent: AgentKind) -> Result<(), String>`

**Events (backend → frontend):**
- `run:status_changed { run_id, status }`
- `run:master_log { run_id, line }`
- `run:subtasks_proposed { run_id, subtasks: Vec<SubtaskData> }`
- `run:subtask_state_changed { run_id, subtask_id, state }`
- `run:subtask_log { run_id, subtask_id, line }`
- `run:diff_ready { run_id, files: Vec<FileDiff> }`
- `run:completed { run_id, summary: RunSummary }`
- `run:failed { run_id, error: String }`

**Implementation:**
- Types shared between Rust and TS via manual mirroring (serde + Zod). Don't introduce `specta` or code-gen yet — too much ceremony for Phase 2.
- Create `src/lib/ipc.ts` with typed wrappers around `invoke()` and typed event listeners using `listen()`.
- Create `src-tauri/src/ipc/mod.rs` with command handlers as stubs that return `todo!()` for now.
- Register commands in `lib.rs` via `.invoke_handler(generate_handler![...])`.
- Verify: from frontend, call `invoke('submit_task', {...})` — it reaches the stub, returns mock RunId.

**Tests:**
- Unit test the Zod schemas for each event/command payload.
- Integration test: subscribe to an event, emit it from Rust manually, verify frontend receives it.

### Step 2: Agent detection

**File:** `src-tauri/src/detection/mod.rs`

Detect which of Claude Code, Codex CLI, Gemini CLI are installed and usable.

**Detection logic:**
- Check `PATH` for binaries: `claude`, `codex`, `gemini` (actual binary names to confirm during implementation — may differ per tool).
- For each found binary, attempt a version check: `claude --version`, `codex --version`, `gemini --version`. Capture output with 3s timeout.
- If version check succeeds, mark agent as `available`. Capture version string for telemetry.
- If binary exists but version check fails (permission error, crash), mark as `broken` with error message.
- Return:
  ```rust
  struct AgentDetectionResult {
      claude: AgentStatus,  // Available { version } | Broken { error } | NotInstalled
      codex: AgentStatus,
      gemini: AgentStatus,
      recommended_master: Option<AgentKind>,  // First Available in fallback order
  }
  ```

**Frontend flow:**
- App calls `detect_agents` on mount.
- If `recommended_master` is `Some`, store it as default in `selectedMasterAgent`.
- If `recommended_master` is `None` (all agents missing/broken), replace EmptyState with a new `AgentSetupState` component:
  - Title: "Install an AI agent to get started"
  - Three cards (Claude Code, Codex, Gemini) with install command and status badge
  - After install, user clicks "Recheck" to re-run detection
- User can change master via the existing top-bar chip. Clicking it opens a dropdown of Available agents only. Broken/NotInstalled agents appear disabled with a tooltip explaining why.

**Tests:**
- Unit test the detection logic with fake `PATH` and mocked `Command::output`.
- Snapshot test on `AgentDetectionResult` JSON shape.

### Step 3: Agent adapter trait and implementations

**File:** `src-tauri/src/agents/mod.rs` (trait) + `src-tauri/src/agents/{claude,codex,gemini}.rs`

The adapter abstracts "spawn this agent, feed it a prompt, get streaming output back."

**Trait:**
```rust
#[async_trait]
pub trait AgentImpl: Send + Sync {
    fn kind(&self) -> AgentKind;
    fn version(&self) -> &str;

    /// Run the agent in "plan" mode: given a task description and repo context,
    /// produce a structured plan. Master role.
    async fn plan(
        &self,
        task: &str,
        context: PlanningContext,
    ) -> Result<Plan, AgentError>;

    /// Run the agent in "execute" mode: given a subtask, execute it in the
    /// given worktree. Emit log lines via the provided channel.
    async fn execute(
        &self,
        subtask: &Subtask,
        worktree_path: &Path,
        shared_notes: &str,
        log_tx: tokio::sync::mpsc::Sender<String>,
    ) -> Result<ExecutionResult, AgentError>;
}
```

**Planning context:**
- Repo root path
- Brief directory tree (first 2 levels, ignoring `node_modules`, `target`, `dist`, `.git`)
- Presence of `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` (read contents if present)
- Recent git log (last 10 commits on current branch)

**Execution output parsing:**
Each adapter needs to parse its agent's output format. Claude Code, Codex, and Gemini all have different streaming formats. For Phase 2 keep this minimal:
- Capture raw stdout/stderr lines
- Emit each line as-is via `log_tx` with a prefix character inference (✓, →, ⚠, ✗)
- Detect "task completed" and "task failed" from output heuristics (regex matching common phrases)

**Plan format (what `plan()` returns):**
```rust
struct Plan {
    reasoning: String,            // Master's overall reasoning ("I broke this down because...")
    subtasks: Vec<PlannedSubtask>,
}

struct PlannedSubtask {
    title: String,
    why: String,                  // Short explanation ("This step is needed because...")
    assigned_worker: AgentKind,   // Master chooses based on... heuristics for now
    dependencies: Vec<usize>,     // Indices of other subtasks that must complete first
}
```

Master must emit a structured plan. Use a well-specified prompt that asks for JSON output. Each agent adapter handles its own prompt template in `src-tauri/src/agents/prompts/master_{agent}.md`.

**Tests:**
- Unit test prompt rendering (given a task + context, prompt text is correct)
- Integration test with a fake binary (shell script that echoes canned output) to verify output parsing end-to-end
- Don't test with real Claude/Gemini/Codex in CI — too flaky, too expensive

### Step 4: Git worktree lifecycle

**File:** `src-tauri/src/worktree/mod.rs`

Each subtask runs in its own git worktree. The worktree is an implementation detail — user never sees it.

**API:**
```rust
pub struct WorktreeManager {
    repo_root: PathBuf,
    base_branch: String,
    worktrees_dir: PathBuf,  // $REPO_ROOT/.whalecode-worktrees (gitignored)
}

impl WorktreeManager {
    pub async fn create(&self, subtask_id: &str) -> Result<PathBuf>;
    pub async fn list(&self) -> Result<Vec<WorktreeInfo>>;
    pub async fn diff(&self, subtask_id: &str) -> Result<Vec<FileDiff>>;
    pub async fn merge_all(&self, subtask_ids: &[String]) -> Result<MergeResult>;
    pub async fn cleanup(&self, subtask_id: &str) -> Result<()>;
    pub async fn cleanup_all(&self) -> Result<()>;
}
```

**Lifecycle per subtask:**
1. `create(subtask_id)` runs `git worktree add .whalecode-worktrees/{subtask_id} -b whalecode/{run_id}/{subtask_id} {base_branch}`
2. Worker executes in that worktree
3. On completion, compute diff vs base branch
4. On Apply: merge all subtask branches into base branch in order (respecting dependencies)
5. Always cleanup: `git worktree remove` + delete branch

**Conflict handling:**
- If two subtasks edit the same file: attempt three-way merge via `git merge-file`
- If merge-file fails: emit `run:conflict { files }` event — frontend shows conflict UI (Phase 4; Phase 2 just fails loudly)
- For Phase 2: if merge fails, abort the Apply, leave worktrees in place, surface error

**Critical: cleanup on every exit path:**
- Normal completion after Apply → cleanup
- User Discards → cleanup
- User cancels mid-run → cleanup
- Crash / panic → orphan worktrees possible; detect and clean up on next app start (scan `.whalecode-worktrees`, remove anything not referenced by an active run in SQLite)
- Add `cleanup_orphans_on_startup()` to app initialization

**Tests:**
- Integration tests against a temp git repo
- Verify worktree creation, diff computation, merge ordering with dependencies
- Verify cleanup under every exit condition
- Test orphan detection and cleanup

### Step 5: Shared notes implementation

**File:** `src-tauri/src/orchestration/notes.rs`

The `.whalecode/notes.md` mechanism from architecture.md section 2.

**Responsibilities:**
- Create `.whalecode/notes.md` at task start with master's initial entries (project structure summary, relevant API contracts, design decisions)
- Provide read-only access to workers before they start
- Accept append-only writes from workers after they finish
- Master periodically consolidates when notes grow past a threshold (e.g., 8KB)
- Clear at task end

**File format (markdown, append-friendly):**
```markdown
# Task: {user_input}
# Run: {run_id}

## Initial context (master)
{master's initial notes}

## Subtask 1: Add ThemeContext provider (claude-code)
{worker appends its summary here when done}

## Subtask 2: Build toggle UI (gemini-cli)
{worker appends its summary here when done}

---
```

**API:**
```rust
pub struct SharedNotes {
    path: PathBuf,  // {repo_root}/.whalecode/notes.md
}

impl SharedNotes {
    pub async fn init(&self, run: &Run) -> Result<()>;
    pub async fn read(&self) -> Result<String>;
    pub async fn append_subtask_summary(&self, subtask_id: &str, summary: &str) -> Result<()>;
    pub async fn consolidate(&self, master: &dyn AgentImpl) -> Result<()>;  // Master re-summarizes if too long
    pub async fn clear(&self) -> Result<()>;
}
```

**Concurrency:** Workers only append (their own section). Race-free since sections are keyed by subtask_id. Master is the only one that rewrites structure, and only when workers are not actively writing.

**Tests:**
- Unit test file operations on temp dir
- Concurrent append test (multiple workers appending simultaneously)
- Consolidation test (synthetic long notes → master prompt → shorter notes)

### Step 6: Orchestrator — the heart

**File:** `src-tauri/src/orchestration/mod.rs`

This replaces `mockOrchestration.ts`. The orchestrator owns a run's lifecycle end-to-end.

**State machine (mirrors Phase 1 graph store semantics):**

```
Idle → Planning → AwaitingApproval → Running → Merging → Done
                        ↓
                    Rejected → Idle
                        ↓
                    Failed → Idle (user resets)
```

**Run state (kept in memory + persisted to SQLite):**
```rust
pub struct Run {
    id: RunId,
    task: String,
    repo_path: PathBuf,
    master: AgentKind,
    status: RunStatus,
    subtasks: Vec<SubtaskRuntime>,
    started_at: DateTime<Utc>,
    worktree_mgr: Arc<WorktreeManager>,
    notes: Arc<SharedNotes>,
    // ...
}

pub struct SubtaskRuntime {
    id: String,
    data: PlannedSubtask,
    state: SubtaskState,  // Proposed, Running, Done, Failed, Skipped, Waiting
    worktree_path: Option<PathBuf>,
    logs: Vec<String>,    // Also streamed live via events
    started_at: Option<DateTime<Utc>>,
    finished_at: Option<DateTime<Utc>>,
}
```

**Flow:**

1. `submit_task` → spawn async task for the run
2. Master plans:
   - Build `PlanningContext` from repo scan
   - Call `master.plan(task, context)` — streams log lines via `run:master_log` events
   - On plan complete: emit `run:subtasks_proposed` with the subtask data
   - Transition to `AwaitingApproval`
3. User approves (or rejects):
   - Approve: transition to `Running`, dispatch workers (see below)
   - Reject: transition to `Idle`, cleanup any worktrees created
4. Dispatch workers:
   - For each approved subtask: respect dependencies. A subtask with dependencies waits (`Waiting` state) until its parents complete.
   - Workers run in parallel where possible.
   - Each worker:
     - Gets its worktree from `worktree_mgr.create(subtask_id)`
     - Reads shared notes
     - Calls `agent.execute(subtask, worktree_path, notes, log_tx)`
     - Streams log lines via `run:subtask_log` events
     - On completion: compute diff, append summary to shared notes, transition to `Done`
     - On failure: transition to `Failed` (Phase 3 will add retry/re-plan; for Phase 2 this fails the whole run)
5. All subtasks done → `Merging`:
   - Compute aggregate diff: `worktree_mgr` across all subtasks
   - Emit `run:diff_ready`
   - Transition to final node "awaiting user action"
6. User clicks Apply:
   - `worktree_mgr.merge_all(subtask_ids)` in dependency order
   - On success: cleanup worktrees, clear notes, emit `run:completed`, transition to `Done`
   - On conflict: emit error, leave worktrees for inspection (Phase 4 handles this properly)
7. User clicks Discard:
   - `worktree_mgr.cleanup_all()`, clear notes, transition to `Idle`

**Cancellation:**
- `cancel_run` → signal all active worker tasks via `tokio::sync::watch` or cancel tokens
- Workers must honor cancellation within 2s (subprocess kill)
- After all workers stopped: cleanup worktrees, clear notes, transition to `Idle`

**Tests:**
- Integration tests with fake agent adapters (shell scripts)
- Happy path end-to-end: plan → approve → execute → merge → apply
- Reject path: plan → reject → cleanup verified
- Cancel path: start running → cancel → all state cleared, no worktree leaks
- Dependency ordering: A → B where B depends on A; B waits, then runs

### Step 7: Frontend IPC wiring

The Zustand `graphStore` from Phase 1 needs to be updated to source its state from backend events rather than drive orchestration itself.

**Changes to `src/state/graphStore.ts`:**

- Remove direct calls to `mockOrchestration`. Instead, `submitTask` invokes `ipc.submitTask()`.
- Add event listeners on store initialization:
  - `run:status_changed` → update `status`
  - `run:master_log` → append to master node's logs
  - `run:subtasks_proposed` → create subtask nodes in `proposed` state
  - `run:subtask_state_changed` → dispatch XState event on the matching actor
  - `run:subtask_log` → append to nodeLogs for that subtask
  - `run:diff_ready` → populate final node's `files`
  - `run:completed` → transition final node to done
  - `run:failed` → transition run status to failed
- Actions like `approveSubtasks`, `rejectAll`, `applyRun`, `reset` become IPC calls instead of direct state mutations. The state update comes back via events.

**File: `src/lib/ipc.ts`:**

Thin typed wrapper:
```typescript
export const ipc = {
  async submitTask(input: string): Promise<RunId> {
    const repoPath = await getCurrentRepoPath(); // from some config hook
    return invoke('submit_task', { input, repoPath });
  },
  async approveSubtasks(runId: RunId, subtaskIds: string[]): Promise<void> {
    return invoke('approve_subtasks', { runId, subtaskIds });
  },
  // ... etc
};

export function listenRunEvents(runId: RunId, handlers: RunEventHandlers): Unsubscribe {
  // Wire up listen() calls for each event, return combined unsubscribe
}
```

**Test updates:**
- Existing integration test (`mockOrchestration` driving) becomes obsolete. Replace with a new test that mocks IPC and fires fake events.
- The store's reducer logic (how it handles each event) becomes the primary test target.

### Step 8: Repo path selection

Phase 1 doesn't ask for a repo — everything was mock. Phase 2 needs a real repo path.

**Options:**
- **A)** First-launch flow: "Choose a project folder" dialog using `tauri-plugin-dialog`.
- **B)** Start with current working directory if it's a git repo; otherwise prompt.
- **C)** Remember last-used repo via a settings file, reopen automatically.

**Recommended:** A + C. On first launch, prompt for repo. On subsequent launches, remember the last-used repo and reopen it. User can switch repos via a top-bar menu (Cmd+O).

**Implementation:**
- Settings file at OS-standard app data location: `~/.config/whalecode/settings.json` (Linux), `~/Library/Application Support/whalecode/settings.json` (macOS), `%APPDATA%/whalecode/settings.json` (Windows). Use `tauri::api::path::app_config_dir`.
- Schema: `{ lastRepo: string, masterAgent: AgentKind, ...future }`
- Validate repo on load: must be a directory, must contain `.git`. If invalid, clear and prompt.

**UI changes:**
- TopBar's repo label ("apps/web" in Phase 1 was mock) becomes the actual repo folder name
- Add repo picker affordance: click the label to change repo (Phase 2 minimum: keyboard shortcut Cmd+O)

### Step 9: SQLite persistence

**File:** `src-tauri/src/storage/mod.rs`

Persist runs and their outcomes for the run history feature (used in Phase 6, but the schema goes in now).

**Schema:**
```sql
CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    task TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    master_agent TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error TEXT
);

CREATE TABLE subtasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    title TEXT NOT NULL,
    why TEXT,
    assigned_worker TEXT NOT NULL,
    state TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    error TEXT,
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE subtask_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subtask_id TEXT NOT NULL,
    line TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (subtask_id) REFERENCES subtasks(id) ON DELETE CASCADE
);

CREATE TABLE subtask_dependencies (
    subtask_id TEXT NOT NULL,
    depends_on_id TEXT NOT NULL,
    PRIMARY KEY (subtask_id, depends_on_id),
    FOREIGN KEY (subtask_id) REFERENCES subtasks(id) ON DELETE CASCADE,
    FOREIGN KEY (depends_on_id) REFERENCES subtasks(id) ON DELETE CASCADE
);
```

Logs are append-only. Phase 6 will add cost tracking tables.

**Use `tauri-plugin-sql`** — handles migrations, connection pooling.

### Step 10: Error surface

Phase 1 had no real errors to show. Phase 2 does: network failures, agent crashes, bad responses, git errors, worktree conflicts, disk full.

**Taxonomy:**
- **AgentError**: spawn failed, timeout, non-zero exit, parse error on plan output
- **WorktreeError**: git command failed, merge conflict, disk error
- **OrchestrationError**: invalid state transition, dependency cycle, cancelled
- **IpcError**: malformed request, run not found, already completed

**Surface:**
- Each node knows about its own error (failed state → expand node shows error)
- Run-level errors (orchestrator failures) appear in a dismissible banner above the graph
- Every error has: short summary (one line), details (expandable), suggested action if any

**Phase 2 scope:** just surface errors honestly. Progressive retry comes in Phase 3.

### Step 11: Polish and verification

- Performance: streaming 100 log lines/sec across 5 subtasks simultaneously should not drop frames. Use `requestAnimationFrame` batching on the frontend for log appends.
- Cancellation latency: cancel click → all workers stopped ≤ 2s
- Worktree leaks: run a stress test (start 20 runs, cancel randomly) and verify `.whalecode-worktrees/` is clean after.
- Error recovery: crash the app mid-run, restart, verify orphan worktrees are cleaned up on startup.

## Acceptance criteria

Phase 2 ships when:

1. App detects installed agents on launch
2. User picks a git repo (first launch asks, subsequent launches remember)
3. User types a real task, submits
4. Master analyzes the repo and proposes real subtasks with real explanations
5. User approves some subtasks
6. Workers run in real subprocesses, streaming real output into node log blocks
7. Subtasks complete, final node shows actual git diff from worktrees
8. Apply merges changes into the working branch successfully
9. Discard cleans up all worktrees
10. Cancel mid-run stops workers within 2s and cleans up
11. Crash recovery: kill the app mid-run, restart, no orphan worktrees
12. No regressions on Phase 1's visual/responsive behavior

## What you'll create

Approximate file list:

```
src-tauri/src/
├── detection/mod.rs                  (+ tests)
├── agents/
│   ├── mod.rs                        (trait)
│   ├── claude.rs                     (+ prompt template)
│   ├── codex.rs                      (+ prompt template)
│   ├── gemini.rs                     (+ prompt template)
│   └── prompts/master_{agent}.md
├── worktree/mod.rs                   (+ integration tests)
├── orchestration/
│   ├── mod.rs                        (+ integration tests)
│   └── notes.rs                      (+ tests)
├── storage/mod.rs                    (+ migrations)
├── ipc/mod.rs                        (commands)
└── lib.rs                            (wire everything together)

src/
├── lib/ipc.ts                        (+ tests on schema validation)
├── state/graphStore.ts               (updated: event-driven)
├── hooks/useRepoPath.ts              (new)
├── components/shell/
│   ├── AgentSetupState.tsx           (new)
│   └── RepoPicker.tsx                (new, keyboard-only in Phase 2)
```

Estimated LOC: ~3500 Rust, ~800 TypeScript. Most of the work is Rust.

## Common pitfalls

- **Subprocess cleanup.** Orphaned subprocesses are the easiest way to screw up this phase. Always use `tokio::process::Command` with `kill_on_drop(true)`. Every spawn needs a cancellation path.
- **Event flooding.** 100 log lines/sec per subtask × 5 subtasks = 500 events/sec. Frontend will drop frames if each event triggers a React render. Batch log appends via `requestAnimationFrame` on the frontend.
- **Plan JSON parsing.** Agents don't always emit clean JSON. Expect malformed output, prefix text, trailing explanations. Use a forgiving JSON extractor (find first `{`, balance braces, parse the extracted substring). Surface parse failures as `AgentError::ParseFailed` with the raw output.
- **Git worktree edge cases.** Worktree creation fails if the branch name already exists, if the target directory exists, if uncommitted changes exist on HEAD, if disk is full. Test all of these.
- **macOS sandbox issues.** Tauri's default sandbox blocks subprocess spawning unless capabilities are configured. Rewrite `src-tauri/capabilities/` from scratch with the required permissions.
- **Do not retry failures in Phase 2.** Phase 3 handles that. A failure = user sees it = user decides. Don't sneak retry logic in early.
