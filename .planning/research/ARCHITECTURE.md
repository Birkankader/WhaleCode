# Architecture Research

**Domain:** AI coding tool orchestration desktop app (Tauri v2)
**Researched:** 2026-03-05
**Confidence:** HIGH (Tauri v2 patterns), MEDIUM (orchestration-specific patterns)

## Standard Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        WEB FRONTEND (WebView)                        │
│                                                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│  │  Dashboard   │  │  Task Panel  │  │ Output View  │               │
│  │   (status,   │  │  (submit,    │  │  (streaming  │               │
│  │  controls)   │  │   route)     │  │   console)   │               │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘               │
│         │                 │                  │                        │
│         └────────────┬────┘                  │                        │
│              invoke() │  ← → listen()        │                        │
└────────────────────────┼─────────────────────┼────────────────────────┘
                         │ IPC (JSON messages)  │ Events/Channels
┌────────────────────────┼─────────────────────┼────────────────────────┐
│                   RUST BACKEND (Tauri Core)   │                        │
│                         │                    │                        │
│  ┌──────────────────────▼──────────────────┐ │                        │
│  │              Command Layer              │ │                        │
│  │  submit_task | get_status | kill_tool  │ │                        │
│  └──────────────────────┬──────────────────┘ │                        │
│                         │                    │                        │
│  ┌──────────────┐  ┌────▼─────────┐  ┌──────▼──────────────────┐    │
│  │ Context Store│  │ Task Router  │  │    Process Manager       │    │
│  │              │←→│              │→ │                          │    │
│  │ project mem  │  │ assigns tool │  │  spawns/tracks/kills     │    │
│  │ file index   │  │ distributes  │  │  CLI processes per tool  │    │
│  │ change log   │  │ work         │  │                          │    │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘    │
│                         │                    │                        │
│  ┌──────────────┐  ┌────▼─────────┐  ┌──────▼──────────────────┐    │
│  │Prompt Engine │  │ Conflict     │  │  Output Multiplexer      │    │
│  │              │  │ Resolver     │  │                          │    │
│  │ optimizes    │  │              │  │  fan-out stdout/stderr   │    │
│  │ prompt per   │  │ git-diff     │  │  per tool → frontend     │    │
│  │ tool         │  │ overlap      │  │  channels                │    │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘    │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                   Shared App State (Mutex)                    │    │
│  │  tool_registry | active_tasks | file_locks | context_db      │    │
│  └──────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────────┘
                         │
┌────────────────────────┼───────────────────────────────────────────────┐
│                EXTERNAL PROCESSES (spawned via tokio::process)         │
│                                                                         │
│  ┌────────────────────┐       ┌────────────────────┐                   │
│  │   Claude Code CLI  │       │    Gemini CLI       │                   │
│  │                    │       │                     │                   │
│  │  stdin: prompt     │       │  stdin: prompt      │                   │
│  │  stdout: NDJSON    │       │  stdout: text/JSON  │                   │
│  │  stderr: errors    │       │  stderr: errors     │                   │
│  └────────────────────┘       └────────────────────┘                   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| Command Layer | Exposes Rust functions to JS via `#[tauri::command]` | Tagged Rust async fns registered at startup |
| Task Router | Decides which tool gets which task based on type/load | Rule engine + heuristics in Rust; v2 can add ML scoring |
| Context Store | Maintains shared project memory (files, decisions, history) | SQLite via `rusqlite` or `sled` embedded KV store |
| Process Manager | Spawns, tracks, kills tool CLI subprocesses | `tokio::process::Command` with stored `Child` handles |
| Prompt Engine | Rewrites user prompt into tool-specific format | Template system per tool in Rust |
| Conflict Resolver | Detects file-level edit conflicts between concurrent tools | Git diff comparison + file lock registry |
| Output Multiplexer | Routes stdout/stderr per tool to the correct frontend channel | One `tauri::Channel` per active tool process |
| Shared App State | Single source of truth for all runtime state | `Mutex<AppState>` registered via `app.manage()` |

## Recommended Project Structure

```
src-tauri/
├── src/
│   ├── main.rs                 # Tauri builder, plugin registration
│   ├── lib.rs                  # Command registration, state setup
│   ├── state/
│   │   ├── mod.rs              # AppState struct definition
│   │   ├── context_store.rs    # Project memory, file index, change log
│   │   └── task_registry.rs    # Active task tracking
│   ├── commands/
│   │   ├── mod.rs              # Re-exports all commands
│   │   ├── tasks.rs            # submit_task, cancel_task, list_tasks
│   │   ├── tools.rs            # list_tools, get_tool_status
│   │   └── context.rs          # get_context, update_context
│   ├── orchestrator/
│   │   ├── mod.rs
│   │   ├── task_router.rs      # Tool selection logic
│   │   ├── process_manager.rs  # Spawn/kill/track CLI processes
│   │   ├── output_mux.rs       # Fan stdout → frontend channels
│   │   └── conflict_resolver.rs # File overlap detection
│   ├── tools/
│   │   ├── mod.rs              # Tool trait definition
│   │   ├── claude_code.rs      # Claude Code adapter (NDJSON protocol)
│   │   └── gemini_cli.rs       # Gemini CLI adapter
│   └── prompt/
│       ├── mod.rs
│       └── engine.rs           # Per-tool prompt transformation
src/                            # Web frontend (e.g. React + Vite)
├── components/
│   ├── Dashboard/
│   ├── TaskPanel/
│   └── OutputConsole/
├── stores/                     # Frontend state (Zustand or Nanostores)
│   ├── tasks.ts
│   └── tools.ts
├── lib/
│   └── tauri.ts                # Typed wrappers around invoke/listen
└── main.tsx
```

### Structure Rationale

- **orchestrator/:** Core business logic isolated from Tauri glue — easier to test in isolation and extend with new tools
- **tools/:** Each AI tool has its own adapter implementing a common `Tool` trait; adding a third tool means adding one file
- **commands/:** Thin command handlers that delegate to orchestrator — keeps IPC surface clean
- **state/:** All mutable state in one place; `Mutex<AppState>` makes thread safety explicit and auditable

## Architectural Patterns

### Pattern 1: Tauri Channel per Tool Process (Streaming Output)

**What:** Each spawned CLI process gets its own `tauri::Channel<OutputEvent>` passed from the frontend at spawn time. The Rust side writes stdout lines to that channel; the frontend receives ordered, buffered updates.

**When to use:** Any time you need real-time, ordered output from a background process. Channels are Tauri's recommended mechanism for streaming (used internally for download progress and WebSocket messages).

**Trade-offs:** Channels require the frontend to pass the channel handle at task creation time. Events are simpler to set up but are JSON-only and not suited to high throughput.

**Example:**
```rust
// Rust command
#[tauri::command]
async fn start_tool(
    tool_id: String,
    prompt: String,
    output: tauri::Channel<OutputEvent>,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<String, String> {
    let task_id = uuid::Uuid::new_v4().to_string();
    tauri::async_runtime::spawn(async move {
        let mut child = tokio::process::Command::new("claude")
            .args(["--output-format", "stream-json", "--print", &prompt])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("failed to spawn claude");

        let stdout = child.stdout.take().unwrap();
        let mut reader = tokio::io::BufReader::new(stdout).lines();
        while let Some(line) = reader.next_line().await.unwrap() {
            output.send(OutputEvent { task_id: task_id.clone(), line }).unwrap();
        }
    });
    Ok(task_id)
}
```

```typescript
// Frontend
import { Channel } from "@tauri-apps/api/core";

const channel = new Channel<OutputEvent>();
channel.onmessage = (event) => appendToConsole(event.line);
await invoke("start_tool", { toolId: "claude", prompt, output: channel });
```

### Pattern 2: Tokio MPSC for Internal Orchestration

**What:** Inside the Rust backend, use `tokio::sync::mpsc` channels to decouple the Process Manager from the Conflict Resolver and Context Store. The Process Manager publishes file-change events; other components subscribe.

**When to use:** Any internal async pipeline where components produce and consume events without needing to block.

**Trade-offs:** Adds abstraction; worth it once you have 3+ internal components that need to react to the same events.

**Example:**
```rust
// In setup, create internal channels
let (fs_tx, mut fs_rx) = tokio::sync::mpsc::channel::<FileChangeEvent>(256);

// Process manager sends after each tool completes
fs_tx.send(FileChangeEvent { tool_id, changed_files }).await.unwrap();

// Conflict resolver listens
tauri::async_runtime::spawn(async move {
    while let Some(event) = fs_rx.recv().await {
        check_for_overlaps(&event).await;
    }
});
```

### Pattern 3: Shared AppState with std::sync::Mutex

**What:** All runtime state (active tasks, tool statuses, file locks, context snapshot) lives in a single `Mutex<AppState>` registered with `app.manage()`. Commands access it as `State<'_, Mutex<AppState>>`.

**When to use:** Any data that multiple commands need to read or mutate. Tauri wraps it in Arc internally so no manual Arc wrapping is needed.

**Trade-offs:** `std::sync::Mutex` is preferred over `tokio::sync::Mutex` unless you need to hold the lock across `.await` points. The standard mutex is faster and simpler for short critical sections.

**Example:**
```rust
#[derive(Default)]
struct AppState {
    active_tasks: HashMap<String, TaskStatus>,
    file_locks: HashMap<PathBuf, String>, // path → tool_id holding lock
    context: ProjectContext,
}

// In setup:
app.manage(Mutex::new(AppState::default()));

// In a command:
#[tauri::command]
fn get_active_tasks(state: State<'_, Mutex<AppState>>) -> Vec<TaskSummary> {
    let state = state.lock().unwrap();
    state.active_tasks.values().map(|t| t.into()).collect()
}
```

### Pattern 4: Tool Trait for Adapter Abstraction

**What:** Define a `Tool` trait with `spawn(prompt, channel) -> TaskHandle` and `capabilities() -> ToolCapabilities`. Each AI tool is an adapter implementing this trait.

**When to use:** From day one. This is what makes adding a third tool (Codex) low-effort in v2.

**Trade-offs:** Slight upfront abstraction cost; pays for itself the moment you add a second tool.

**Example:**
```rust
#[async_trait]
pub trait Tool: Send + Sync {
    fn id(&self) -> &str;
    fn capabilities(&self) -> ToolCapabilities;
    async fn spawn(
        &self,
        prompt: &str,
        channel: tauri::Channel<OutputEvent>,
    ) -> Result<TaskHandle, ToolError>;
    async fn kill(&self, handle: &TaskHandle) -> Result<(), ToolError>;
}
```

## Data Flow

### Task Submission Flow (Happy Path)

```
User types task in frontend
    ↓
invoke("submit_task", { task, projectPath })
    ↓
[Command Layer] validates input
    ↓
[Prompt Engine] transforms prompt → tool-optimized variant
    ↓
[Task Router] selects tool based on task type + current load
    ↓
[Conflict Resolver] checks file lock registry — no conflicts
    ↓
[Process Manager] spawns CLI subprocess via tokio::process::Command
    │   registers Child handle in AppState.active_tasks
    │   acquires file locks in AppState.file_locks
    ↓
[Output Multiplexer] reads stdout line by line
    ↓
channel.send(OutputEvent { line, task_id }) → frontend
    ↓
Output console renders line in real time
    ↓
[Process completes]
    ↓
[Context Store] updates with changed files, decision log entry
    ↓
[File locks released] in AppState.file_locks
    ↓
emit("task_complete", { task_id, summary }) → frontend
```

### Conflict Detection Flow

```
Tool A completes, writes to files [src/api.rs, src/models.rs]
    ↓
Process Manager sends FileChangeEvent over internal MPSC
    ↓
Conflict Resolver receives event
    ↓
Checks AppState.file_locks: are any of these files locked by Tool B?
    ↓
YES → emit("conflict_detected", { files, tool_a, tool_b }) → frontend
         Frontend shows conflict resolution UI
         User resolves or Resolver proposes 3-way merge
NO  → Context Store records changes
      File locks updated/released
```

### Context Sharing Flow

```
Tool A completes task (adds auth middleware)
    ↓
Context Store: write entry {
  timestamp, tool_id: "claude",
  files_changed: ["src/middleware/auth.rs"],
  summary: "added JWT middleware",
  git_diff: <diff>
}
    ↓
Before Tool B runs next task:
    ↓
[Prompt Engine] fetches recent context entries
    ↓
Injects as preamble: "Claude Code recently added JWT auth middleware
                      in src/middleware/auth.rs. Consider this context."
    ↓
Tool B's prompt includes Tool A's work — no duplicate effort
```

### Frontend State Flow

```
Frontend (Zustand store)
    ↑ listen("task_status_changed")
    ↑ channel.onmessage (streaming output)
    ↑ listen("conflict_detected")

Zustand store updates → React re-renders dashboard, console, conflict UI
```

## Component Build Order

Build in this sequence — each layer depends on the previous:

| Build Phase | Component | Why This Order |
|-------------|-----------|----------------|
| 1 | Shared AppState + basic Tauri scaffold | Everything else reads/writes state |
| 2 | Tool trait + Claude Code adapter | Validates the adapter abstraction works end-to-end |
| 3 | Process Manager + Output Multiplexer | Get live streaming working before building routing on top |
| 4 | Frontend output console + channel wiring | Proves the streaming pipeline before adding orchestration |
| 5 | Context Store (SQLite or sled) | Needed by Prompt Engine and Conflict Resolver |
| 6 | Prompt Engine | Requires Context Store to inject prior context |
| 7 | Task Router (basic rules) | Routes between tools; needs at least 2 tool adapters |
| 8 | Gemini CLI adapter | Second tool; validates Task Router works with multiple tools |
| 9 | Conflict Resolver | Requires file lock registry in AppState + ≥2 concurrent tools |
| 10 | Frontend dashboard (full) | Polish after core pipeline is proven |

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Claude Code CLI | Subprocess via `tokio::process::Command` + NDJSON streaming (`--output-format stream-json`) | Supports stdin prompt injection; stream-json gives per-token events |
| Gemini CLI | Subprocess + line-buffered stdout; JSON mode via `--output_format json` if available | May need `--no-interactive` flag; output buffering requires flush |
| macOS File System (FSEvents) | `notify` Rust crate (wraps FSEvents on macOS) | For detecting when tool writes files without being told |
| SQLite (Context Store) | `rusqlite` crate, managed as part of AppState | Embedded, no server needed; sled is alternative for simpler KV |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Frontend ↔ Command Layer | `invoke()` / `listen()` over Tauri IPC | JSON serialized; define shared types in TypeScript + Rust |
| Command Layer ↔ Orchestrator | Direct Rust function calls | Same process, no serialization overhead |
| Orchestrator ↔ Spawned CLIs | `tokio::process` stdin/stdout pipes | One OS process per tool run; tracked via `Child` handle |
| Process Manager ↔ Conflict Resolver | `tokio::sync::mpsc` channel | Async, non-blocking; decouples components |
| Process Manager ↔ Frontend | `tauri::Channel<OutputEvent>` | One channel handle per task; frontend creates and passes it |
| Context Store ↔ Prompt Engine | Direct Rust function call | Prompt Engine queries Context Store before every tool invocation |

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 2 tools, 1 task at a time | Current design is sufficient; no queuing needed |
| 2 tools, multiple parallel tasks | Add task queue with concurrency limit per tool (e.g., max 2 tasks/tool); already supported by tokio |
| 3+ tools | Add third tool adapter; Task Router needs capability scoring beyond simple rules |
| Complex context (large codebases) | Replace in-memory context snapshot with SQLite FTS; chunk and summarize before injecting into prompts |

### Scaling Priorities

1. **First bottleneck:** Context Store growth — large codebases generate too much diff history to inject wholesale. Fix: summarization pass + relevance ranking before prompt injection.
2. **Second bottleneck:** Concurrent task conflicts — as parallelism increases, file lock contention rises. Fix: worktree-per-task pattern (each tool works in a git worktree, merge at completion).

## Anti-Patterns

### Anti-Pattern 1: Using Tauri Events for High-Throughput Output Streaming

**What people do:** Emit a Tauri global event for every stdout line from every tool, assuming events are equivalent to channels.

**Why it's wrong:** Tauri events evaluate JavaScript under the hood and are explicitly documented as "not designed for low latency or high throughput." With 3 tools each generating many lines/second, this causes UI jank and dropped messages.

**Do this instead:** Use `tauri::Channel` (one per tool task). Channels are designed for ordered, high-throughput streaming and are what Tauri uses internally for subprocess output.

### Anti-Pattern 2: Shared Mutable State Without Mutex (Global Statics)

**What people do:** Use `lazy_static!` or `OnceCell` with a `HashMap` for task tracking, bypassing Tauri's state management.

**Why it's wrong:** Race conditions. Multiple tokio tasks reading/writing the same HashMap without synchronization causes data corruption or panics in Rust's async runtime.

**Do this instead:** Put all shared state in `Mutex<AppState>` registered via `app.manage()`. Access via `State<'_, Mutex<AppState>>` in commands; via `app_handle.state()` in spawned tasks.

### Anti-Pattern 3: Blocking the Async Runtime in Commands

**What people do:** Spawn a CLI subprocess and `.await` its completion inside a `#[tauri::command]` function, blocking until the tool finishes.

**Why it's wrong:** Blocks the async executor thread for the duration of the tool run (could be minutes). Other commands can't be processed during this time.

**Do this instead:** Spawn a `tauri::async_runtime::spawn` task that runs the process. The command returns a `task_id` immediately. Progress and completion come through channels/events.

### Anti-Pattern 4: No File Lock Registry (Letting Tools Clobber Each Other)

**What people do:** Launch multiple tools on the same files simultaneously without tracking which tool is writing where.

**Why it's wrong:** Two tools editing `src/api.rs` at the same time produces conflicting writes. The last writer wins; earlier work is silently lost.

**Do this instead:** Maintain `file_locks: HashMap<PathBuf, ToolId>` in AppState. Conflict Resolver checks this before letting a tool start. If locked, queue the task or warn the user.

### Anti-Pattern 5: Monolithic Context Blob

**What people do:** Dump the entire project file tree + all past decisions into every tool prompt.

**Why it's wrong:** Context windows are finite. Large context = higher latency + higher cost + lower quality (models lose focus in very long contexts).

**Do this instead:** Context Store stores structured entries. Prompt Engine retrieves only relevant context (recent + related to current task) and summarizes it before injection. Keep injected context under ~2000 tokens unless the task explicitly requires more.

## Sources

- [Tauri v2 Architecture Overview](https://v2.tauri.app/concept/architecture/) — HIGH confidence, official docs
- [Calling the Frontend from Rust (Channels vs Events)](https://v2.tauri.app/develop/calling-frontend/) — HIGH confidence, official docs
- [Tauri v2 State Management](https://v2.tauri.app/develop/state-management/) — HIGH confidence, official docs
- [Tauri v2 Shell Plugin](https://v2.tauri.app/plugin/shell/) — HIGH confidence, official docs
- [Tauri + Async Rust Process Pattern](https://rfdonnelly.github.io/posts/tauri-async-rust-process/) — MEDIUM confidence, well-regarded community article
- [Long-running async tasks in Tauri v2](https://sneakycrow.dev/blog/2024-05-12-running-async-tasks-in-tauri-v2) — MEDIUM confidence, community blog
- [Claude Code SDK — NDJSON streaming protocol](https://code.claude.com/docs/en/cli-reference) — HIGH confidence, official Anthropic docs
- [Clash — conflict detection for parallel AI agent worktrees](https://github.com/clash-sh/clash) — MEDIUM confidence, relevant open source project
- [tokio::process — async subprocess management](https://docs.rs/tokio/latest/tokio/process/) — HIGH confidence, official tokio docs

---
*Architecture research for: AI coding tool orchestration desktop app (WhaleCode / Tauri v2)*
*Researched: 2026-03-05*
