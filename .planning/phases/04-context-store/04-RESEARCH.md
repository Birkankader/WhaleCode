# Phase 4: Context Store - Research

**Researched:** 2026-03-06
**Domain:** SQLite persistent storage, event logging, context injection in Tauri v2 / Rust
**Confidence:** HIGH

## Summary

Phase 4 adds a persistent, queryable context store to WhaleCode that records every file change and task decision across tool invocations. The store must survive app restarts (SQLite-backed) and automatically inject relevant context into tools before they start tasks. This is a pure backend feature with IPC commands exposing structured data to the frontend.

The standard approach for SQLite in a Tauri v2 Rust app is **rusqlite** with the `bundled` feature (compiles SQLite into the binary -- zero system deps) and **rusqlite_migration** for schema versioning. The database file lives in Tauri's `app_data_dir` (`~/Library/Application Support/com.whalecode.app/` on macOS). WAL mode enables concurrent reads from multiple IPC commands without blocking writes from the process completion handler.

**Primary recommendation:** Use rusqlite (bundled) + rusqlite_migration with WAL mode. Create a `ContextStore` struct wrapping `Mutex<Connection>` managed as Tauri state. Record events from the process manager's waiter task on completion. Inject context by building a prompt preamble from recent events before spawning tools.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CTXT-01 | App maintains a persistent project context store (code structure, files, past decisions) | rusqlite with bundled SQLite, ContextStore struct in AppState, schema with events + file_changes tables |
| CTXT-02 | Project context is automatically injected into each tool before it starts a task | Query recent events/changes, build prompt preamble string, prepend to tool prompt in adapter layer |
| CTXT-03 | App records every file change made by every tool in a structured event log | Parse Claude result event for changed files, insert into file_changes table on task completion |
| CTXT-04 | Each tool can read the event log to know what other tools have changed | IPC command `get_recent_changes` queries file_changes table, filtered by tool/time/file path |
| CTXT-05 | Context persists across app restarts (SQLite-backed) | SQLite file in app_data_dir, WAL mode, rusqlite_migration for schema versioning |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| rusqlite | 0.38 | SQLite bindings for Rust | De facto standard (40M+ downloads), ergonomic API, type-safe params |
| rusqlite (bundled feature) | 0.38 | Compile SQLite into binary | Zero system dependency, consistent SQLite version across machines |
| rusqlite_migration | 2.4 | Schema versioning | Uses SQLite user_version (no metadata tables), pairs with rusqlite |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| chrono | 0.4 | Timestamp serialization | Already common in Rust ecosystem; ISO 8601 strings for event timestamps |
| serde_json | 1 | JSON metadata storage | Already a dependency; store structured metadata as JSON text columns |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| rusqlite | tauri-plugin-sql (sqlx) | Official plugin but adds sqlx async complexity; overkill for single-file SQLite with Mutex |
| rusqlite | sqlx | Async pool is better for server apps; desktop app with Mutex is simpler |
| rusqlite_migration | refinery | Refinery creates metadata tables; rusqlite_migration uses user_version (lighter) |

**Installation:**
```toml
# src-tauri/Cargo.toml
rusqlite = { version = "0.38", features = ["bundled"] }
rusqlite_migration = "2.4"
chrono = { version = "0.4", features = ["serde"] }
```

## Architecture Patterns

### Recommended Project Structure
```
src-tauri/src/
├── context/
│   ├── mod.rs           # pub mod store, queries, migrations, injection
│   ├── store.rs         # ContextStore struct, init, Connection wrapper
│   ├── models.rs        # ContextEvent, FileChange, TaskSummary structs
│   ├── migrations.rs    # Schema migrations array
│   ├── queries.rs       # Insert/select functions
│   └── injection.rs     # Build context preamble for tool prompts
├── commands/
│   ├── context.rs       # IPC commands: record_task_completion, get_recent_changes, get_context_summary
│   └── ...
├── adapters/
│   ├── claude.rs        # Modified: inject context into prompt before build_command
│   └── ...
└── ...
```

### Pattern 1: ContextStore as Managed State
**What:** Wrap `rusqlite::Connection` in a `Mutex` and register as Tauri managed state, alongside existing `AppState`.
**When to use:** Always -- this is the standard Tauri pattern for shared resources.
**Example:**
```rust
// Source: Tauri v2 state management docs + rusqlite patterns
use rusqlite::Connection;
use std::sync::Mutex;

pub struct ContextStore {
    conn: Mutex<Connection>,
}

impl ContextStore {
    pub fn new(db_path: &std::path::Path) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(db_path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(Self { conn: Mutex::new(conn) })
    }
}

// In lib.rs setup:
// app.manage(ContextStore::new(&db_path)?);
```

### Pattern 2: Migration on Startup
**What:** Run schema migrations in the Tauri `setup` hook before any commands execute.
**When to use:** Every app launch -- migrations are idempotent (no-op if already at latest).
**Example:**
```rust
// Source: rusqlite_migration docs
use rusqlite_migration::{Migrations, M};

const MIGRATIONS: &[M] = &[
    M::up("CREATE TABLE context_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        event_type TEXT NOT NULL,
        summary TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );"),
    M::up("CREATE TABLE file_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL REFERENCES context_events(id),
        file_path TEXT NOT NULL,
        change_type TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_file_changes_path ON file_changes(file_path);
    CREATE INDEX idx_file_changes_event ON file_changes(event_id);"),
];

pub fn run_migrations(conn: &mut Connection) -> Result<(), rusqlite_migration::Error> {
    Migrations::new(MIGRATIONS.to_vec()).to_latest(conn)
}
```

### Pattern 3: Event Recording on Task Completion
**What:** After a tool process exits, parse its output for file changes and record a context event.
**When to use:** In the process manager's waiter task, after exit status is determined.
**Example:**
```rust
// In the waiter task (process/manager.rs), after child.wait():
// 1. Parse Claude result event for file changes (tool_use events with Write/Edit)
// 2. Call context_store.record_task_completion(task_id, tool_name, summary, files_changed)
```

### Pattern 4: Context Injection Before Tool Spawn
**What:** Before spawning a tool, query recent context and prepend it to the prompt.
**When to use:** In `spawn_claude_task` (and future tool adapters) before calling `build_command`.
**Example:**
```rust
// In commands/claude.rs spawn_claude_task:
let context_preamble = context_store.build_preamble(&project_dir, 10)?;
let full_prompt = if context_preamble.is_empty() {
    prompt
} else {
    format!("{}\n\n---\nUser task:\n{}", context_preamble, prompt)
};
let cmd = build_command(&full_prompt, &project_dir, &api_key);
```

### Pattern 5: Per-Project Database Isolation
**What:** Each project gets its own SQLite database file, keyed by project directory path.
**When to use:** Always -- prevents cross-project context pollution.
**Example:**
```rust
// Database path: {app_data_dir}/contexts/{project_hash}.db
// where project_hash = sha256(canonical_project_path)[..16]
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

fn db_path_for_project(app_data_dir: &Path, project_dir: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    project_dir.hash(&mut hasher);
    let hash = format!("{:x}", hasher.finish());
    app_data_dir.join("contexts").join(format!("{}.db", hash))
}
```

### Anti-Patterns to Avoid
- **Single global database for all projects:** Context from project A leaks into project B prompts. Use per-project databases.
- **Storing full file contents in the event log:** Bloats the database. Store only file paths and change types (created/modified/deleted).
- **Querying the database from the frontend directly:** Bypasses Rust type safety. All queries go through IPC commands that return typed structs.
- **Holding the Mutex across async `.await` points:** Use `std::sync::Mutex` (already established project decision) and do all DB work synchronously within the lock, then release.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Schema versioning | Custom version tracking with metadata tables | rusqlite_migration | Handles user_version, idempotent migrations, rollback support |
| SQLite compilation | System SQLite dependency | rusqlite `bundled` feature | Consistent version, no install requirement, statically linked |
| Database file path | Hardcoded path or home directory | `app_handle.path().app_data_dir()` | Tauri API gives correct macOS Application Support path |
| Timestamp handling | Manual string formatting | `chrono::Utc::now().to_rfc3339()` | ISO 8601 standard, timezone-aware, sortable |
| Concurrent access | Read/write locks, connection pool | WAL mode + single Mutex<Connection> | WAL allows concurrent reads; single connection is sufficient for desktop app |

**Key insight:** For a desktop app with one user, a single `Mutex<Connection>` with WAL mode is the optimal pattern. Connection pools and async database layers (sqlx) add complexity without benefit -- there is no concurrent multi-user access pattern.

## Common Pitfalls

### Pitfall 1: Database File Not Created on First Launch
**What goes wrong:** App crashes because the database directory doesn't exist.
**Why it happens:** `app_data_dir` returns the path but doesn't create it. `Connection::open` creates the file but not parent directories.
**How to avoid:** Call `std::fs::create_dir_all` on the database parent directory in the Tauri `setup` hook before opening the connection.
**Warning signs:** "No such file or directory" errors on first launch.

### Pitfall 2: Blocking the Tauri Event Loop with DB Operations
**What goes wrong:** UI freezes while a large query runs.
**Why it happens:** IPC commands run on the Tauri async runtime. If the Mutex is held for a long DB operation, other commands queue up.
**How to avoid:** Keep queries fast (indexed columns, LIMIT clauses). For the context preamble query, limit to last N events (e.g., 20). Use `tokio::task::spawn_blocking` for any potentially slow DB operations.
**Warning signs:** UI becomes unresponsive after many task completions.

### Pitfall 3: File Change Detection Relies on Tool Output Parsing
**What goes wrong:** Changed files are not recorded because the tool output format varies.
**Why it happens:** Claude Code's NDJSON includes `tool_use` events with file operations, but the exact format may differ between CLI versions.
**How to avoid:** Use a two-pronged approach: (1) Parse tool_use events for file paths from the NDJSON stream, (2) As a fallback, run `git diff --name-only` on the project directory after task completion to detect all changes regardless of tool output format.
**Warning signs:** Context store shows zero file changes for tasks that clearly modified files.

### Pitfall 4: SQLite Database Locked on App Crash
**What goes wrong:** On restart after crash, "database is locked" error.
**Why it happens:** WAL mode can leave journal files if the process is killed mid-write.
**How to avoid:** WAL mode actually handles this well -- SQLite automatically recovers from WAL journal files on next connection open. No special handling needed beyond opening the connection normally.
**Warning signs:** This is a non-issue with WAL mode, but would be a problem with DELETE journal mode.

### Pitfall 5: Context Preamble Grows Unbounded
**What goes wrong:** After many tasks, the injected context becomes so large it uses significant tokens.
**Why it happens:** Naively including all historical context in every prompt.
**How to avoid:** Limit context injection to: (a) last N task summaries (e.g., 5), (b) file changes from last N tasks that overlap with the current project directory, (c) total character limit (e.g., 2000 chars). Make these configurable.
**Warning signs:** Token costs increase over time, or tool responses degrade because context dominates the prompt.

### Pitfall 6: Mutex Poisoning on Panic
**What goes wrong:** After one failed DB operation panics, all subsequent DB access fails with "poisoned lock" error.
**Why it happens:** `std::sync::Mutex` becomes poisoned when a thread panics while holding the lock.
**How to avoid:** Never `unwrap()` inside the Mutex lock scope. Use `?` operator and proper error handling. If poisoning does occur, use `lock().unwrap_or_else(|e| e.into_inner())` to recover.
**Warning signs:** "PoisonError" in logs after any DB error.

## Code Examples

### Schema Definition
```sql
-- Migration 1: Core tables
CREATE TABLE context_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,           -- 'claude', 'gemini', etc.
    event_type TEXT NOT NULL,          -- 'task_completed', 'task_failed', 'decision'
    prompt TEXT,                       -- original user prompt
    summary TEXT,                      -- tool's result summary
    project_dir TEXT NOT NULL,         -- which project this relates to
    metadata TEXT,                     -- JSON blob for extensibility
    duration_ms INTEGER,
    cost_usd REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE file_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES context_events(id),
    file_path TEXT NOT NULL,           -- relative to project root
    change_type TEXT NOT NULL,         -- 'created', 'modified', 'deleted'
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_events_project ON context_events(project_dir);
CREATE INDEX idx_events_created ON context_events(created_at);
CREATE INDEX idx_file_changes_path ON file_changes(file_path);
CREATE INDEX idx_file_changes_event ON file_changes(event_id);
```

### Recording a Task Completion
```rust
// Source: rusqlite docs + project patterns
pub fn record_task_completion(
    conn: &Connection,
    task_id: &str,
    tool_name: &str,
    event_type: &str,
    prompt: &str,
    summary: &str,
    project_dir: &str,
    duration_ms: Option<u64>,
    cost_usd: Option<f64>,
    files_changed: &[(String, String)], // (path, change_type)
) -> Result<(), rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;

    tx.execute(
        "INSERT INTO context_events (task_id, tool_name, event_type, prompt, summary, project_dir, duration_ms, cost_usd)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![task_id, tool_name, event_type, prompt, summary, project_dir, duration_ms, cost_usd],
    )?;

    let event_id = tx.last_insert_rowid();

    for (path, change_type) in files_changed {
        tx.execute(
            "INSERT INTO file_changes (event_id, file_path, change_type) VALUES (?1, ?2, ?3)",
            rusqlite::params![event_id, path, change_type],
        )?;
    }

    tx.commit()?;
    Ok(())
}
```

### Querying Recent Changes
```rust
pub fn get_recent_file_changes(
    conn: &Connection,
    project_dir: &str,
    limit: u32,
) -> Result<Vec<FileChangeRecord>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT fc.file_path, fc.change_type, ce.tool_name, ce.summary, ce.created_at
         FROM file_changes fc
         JOIN context_events ce ON fc.event_id = ce.id
         WHERE ce.project_dir = ?1
         ORDER BY fc.created_at DESC
         LIMIT ?2"
    )?;

    let rows = stmt.query_map(rusqlite::params![project_dir, limit], |row| {
        Ok(FileChangeRecord {
            file_path: row.get(0)?,
            change_type: row.get(1)?,
            tool_name: row.get(2)?,
            summary: row.get(3)?,
            created_at: row.get(4)?,
        })
    })?;

    rows.collect()
}
```

### Building Context Preamble
```rust
pub fn build_context_preamble(
    conn: &Connection,
    project_dir: &str,
    max_events: u32,
    max_chars: usize,
) -> Result<String, rusqlite::Error> {
    let events = get_recent_events(conn, project_dir, max_events)?;
    if events.is_empty() {
        return Ok(String::new());
    }

    let mut preamble = String::from("## Recent Project Context\n\n");
    for event in &events {
        let entry = format!(
            "- [{}] {} ({}): {}\n  Files: {}\n",
            event.created_at, event.tool_name, event.event_type,
            event.summary.as_deref().unwrap_or("no summary"),
            event.files.join(", ")
        );
        if preamble.len() + entry.len() > max_chars {
            break;
        }
        preamble.push_str(&entry);
    }

    Ok(preamble)
}
```

### Extracting File Changes from Claude NDJSON
```rust
/// Extract file paths from Claude Code tool_use events.
/// Looks for Write, Edit, and similar file-modifying tool uses.
pub fn extract_file_changes_from_events(events: &[ClaudeStreamEvent]) -> Vec<(String, String)> {
    let mut changes = Vec::new();
    for event in events {
        if let ClaudeStreamEvent::ToolUse { name, input, .. } = event {
            let tool_name = name.as_deref().unwrap_or("");
            match tool_name {
                "Write" => {
                    if let Some(path) = input.as_ref().and_then(|i| i.get("file_path")).and_then(|v| v.as_str()) {
                        changes.push((path.to_string(), "created".to_string()));
                    }
                }
                "Edit" => {
                    if let Some(path) = input.as_ref().and_then(|i| i.get("file_path")).and_then(|v| v.as_str()) {
                        changes.push((path.to_string(), "modified".to_string()));
                    }
                }
                _ => {}
            }
        }
    }
    changes
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| tauri-plugin-sql (sqlx) | Direct rusqlite for simple cases | 2024+ | Less complexity for single-connection desktop apps |
| In-memory state only | SQLite-backed persistence | Always standard | Survives crashes and restarts |
| Global event bus | Per-project isolated databases | Best practice | No cross-project context leakage |
| Full ORM (diesel/sea-orm) | rusqlite + raw SQL for small schemas | Situational | ORMs add dep weight for 2-3 tables |

**Deprecated/outdated:**
- `tauri::api::path::app_data_dir()` (Tauri v1 API): Use `app_handle.path().app_data_dir()` in Tauri v2
- `path_resolver()` (Tauri v1): Use `.path()` method from Manager trait in Tauri v2

## Open Questions

1. **File change detection accuracy from Claude NDJSON**
   - What we know: Claude Code emits `tool_use` events with `Write` and `Edit` tool names containing `file_path` in input
   - What's unclear: Whether all file-modifying tools are captured (e.g., Bash commands that create files)
   - Recommendation: Use NDJSON parsing as primary, `git diff --name-only` as fallback/verification. The git approach catches everything.

2. **Per-project vs single database**
   - What we know: Per-project avoids context leakage between projects
   - What's unclear: Whether users will have many projects open simultaneously (which would mean many open connections)
   - Recommendation: Per-project databases, but only open the connection for the active project. Lazy-load on first access.

3. **Context preamble format for different tools**
   - What we know: Claude Code accepts plain text prepended to the prompt
   - What's unclear: Gemini CLI's optimal context format (Phase 6 concern)
   - Recommendation: Build a generic text preamble now. Make the injection point per-adapter so Phase 6 can customize the format.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Rust: `cargo test`, Frontend: vitest 4.0 |
| Config file | src-tauri/Cargo.toml (Rust), vitest.config implicit in package.json |
| Quick run command | `cd src-tauri && cargo test context` |
| Full suite command | `cd src-tauri && cargo test && cd .. && npm test` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CTXT-01 | ContextStore initializes, creates tables, stores events | unit | `cd src-tauri && cargo test context::store` | No - Wave 0 |
| CTXT-02 | Context preamble built and injected into prompt | unit | `cd src-tauri && cargo test context::injection` | No - Wave 0 |
| CTXT-03 | File changes recorded in structured event log | unit | `cd src-tauri && cargo test context::queries::test_record` | No - Wave 0 |
| CTXT-04 | Event log queryable by tool, time, file path | unit | `cd src-tauri && cargo test context::queries::test_query` | No - Wave 0 |
| CTXT-05 | Database persists across connection close/reopen | unit | `cd src-tauri && cargo test context::store::test_persistence` | No - Wave 0 |

### Sampling Rate
- **Per task commit:** `cd src-tauri && cargo test context`
- **Per wave merge:** `cd src-tauri && cargo test && cd .. && npm test`
- **Phase gate:** Full suite green before /gsd:verify-work

### Wave 0 Gaps
- [ ] `src-tauri/src/context/store.rs` -- ContextStore struct + init tests (CTXT-01, CTXT-05)
- [ ] `src-tauri/src/context/queries.rs` -- Insert/query tests (CTXT-03, CTXT-04)
- [ ] `src-tauri/src/context/injection.rs` -- Preamble building tests (CTXT-02)
- [ ] `src-tauri/src/context/migrations.rs` -- Migration definitions
- [ ] `src-tauri/src/context/models.rs` -- Data model structs
- [ ] `src-tauri/src/commands/context.rs` -- IPC command wrappers

## Sources

### Primary (HIGH confidence)
- [rusqlite docs](https://docs.rs/rusqlite/0.38.0/rusqlite/) -- Connection, params!, WAL mode, transactions
- [rusqlite_migration docs](https://docs.rs/rusqlite_migration/latest/rusqlite_migration/) -- Migrations::new, to_latest(), user_version approach
- [Tauri v2 SQL plugin docs](https://v2.tauri.app/plugin/sql/) -- Verified tauri-plugin-sql uses sqlx (not rusqlite), confirmed direct rusqlite is viable alternative
- [Tauri v2 PathResolver](https://docs.rs/tauri/latest/tauri/path/struct.PathResolver.html) -- app_data_dir path resolution

### Secondary (MEDIUM confidence)
- [rusqlite GitHub](https://github.com/rusqlite/rusqlite) -- Version 0.38, bundled feature, 40M+ downloads
- [Tauri SQLite patterns](https://dev.to/randomengy/tauri-sqlite-p3o) -- Mutex<Connection> pattern, WAL mode setup
- [Persistent state in Tauri](https://aptabase.com/blog/persistent-state-tauri-apps) -- app_data_dir usage patterns

### Tertiary (LOW confidence)
- Claude Code NDJSON tool_use event format for file changes -- based on observed behavior in Phase 3, not formally documented

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- rusqlite is the clear choice for Rust + SQLite desktop apps; well-documented, widely used
- Architecture: HIGH -- Mutex<Connection> pattern is established in Tauri apps; schema design follows standard event sourcing
- Pitfalls: HIGH -- well-known SQLite + Tauri patterns; WAL mode, directory creation, Mutex poisoning are documented issues
- File change extraction: MEDIUM -- depends on Claude Code NDJSON format stability; git fallback mitigates risk

**Research date:** 2026-03-06
**Valid until:** 2026-04-06 (stable domain, SQLite patterns rarely change)
