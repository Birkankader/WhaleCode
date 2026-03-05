# Phase 2: Process Core - Research

**Completed:** 2026-03-05
**Discovery Level:** 2 (Standard Research)

## tokio::process Subprocess Management

### Spawning with Process Groups
```rust
use tokio::process::Command;
use std::os::unix::process::CommandExt;

let mut cmd = Command::new("sh");
cmd.arg("-c").arg(&user_command);
cmd.env("NO_COLOR", "1");
cmd.env("TERM", "dumb");
// Create new process group so we can kill the entire tree
unsafe { cmd.pre_exec(|| { libc::setpgid(0, 0); Ok(()) }); }
cmd.stdout(std::process::Stdio::piped());
cmd.stderr(std::process::Stdio::piped());
let child = cmd.spawn().map_err(|e| e.to_string())?;
```

Key points:
- `pre_exec` with `setpgid(0, 0)` makes the child its own process group leader
- All grandchildren inherit the pgid, so one `killpg` kills the entire tree
- Must use `unsafe` block — this is standard practice for Unix process management
- `libc` crate needed: `libc = "0.2"`

### Reading stdout/stderr Streams
```rust
use tokio::io::{AsyncBufReadExt, BufReader};

let stdout = child.stdout.take().unwrap();
let stderr = child.stderr.take().unwrap();
let stdout_reader = BufReader::new(stdout);
let stderr_reader = BufReader::new(stderr);

// Spawn separate tasks for stdout and stderr
tokio::spawn(async move {
    let mut lines = stdout_reader.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        channel.send(OutputEvent::Stdout(line)).ok();
    }
});
```

## Process Group Killing (pgid)

### Cancel: SIGTERM then SIGKILL
```rust
use nix::sys::signal::{killpg, Signal};
use nix::unistd::Pid;

// Graceful: SIGTERM to entire process group
killpg(Pid::from_raw(pgid), Signal::SIGTERM).ok();

// Wait 2 seconds, then force kill
tokio::time::sleep(Duration::from_secs(2)).await;
killpg(Pid::from_raw(pgid), Signal::SIGKILL).ok();
```

Using `nix` crate (not raw libc) for ergonomic signal handling: `nix = { version = "0.29", features = ["signal", "process"] }`

### Pause/Resume: SIGSTOP/SIGCONT
```rust
// Pause entire process group
killpg(Pid::from_raw(pgid), Signal::SIGSTOP).ok();

// Resume entire process group
killpg(Pid::from_raw(pgid), Signal::SIGCONT).ok();
```

SIGSTOP cannot be caught or ignored — guaranteed to pause. SIGCONT resumes.

## Zombie Prevention

### Strategy
1. Every spawned child tracked in `AppState.processes` HashMap keyed by TaskId
2. Store the pgid (i32) alongside the `tokio::process::Child`
3. On `RunEvent::Exit`: iterate all tracked processes, `killpg(SIGKILL)` each pgid
4. On individual process completion: `child.wait()` reaps the zombie automatically
5. tokio::process::Child drops call `waitpid` — but only for direct child. Grandchildren need pgid kill.

### RunEvent::Exit Hook (extending Phase 1)
```rust
.run(|app_handle, event| {
    if let tauri::RunEvent::Exit = event {
        let state = app_handle.state::<AppState>();
        let mut inner = state.lock().unwrap();
        for (_id, proc) in inner.processes.drain() {
            let _ = killpg(Pid::from_raw(proc.pgid), Signal::SIGKILL);
        }
    }
});
```

### Verification
After app exit: `pgrep -P <former_child_pid>` should return nothing. Integration test can spawn `sleep 9999`, quit app, verify no orphans.

## Process Registry Design

```rust
pub struct ProcessEntry {
    pub pgid: i32,
    pub status: ProcessStatus,
    pub child: Option<tokio::process::Child>,  // None after reaped
}

pub enum ProcessStatus {
    Running,
    Paused,
    Completed(i32),  // exit code
    Failed(String),
}

pub struct AppStateInner {
    pub tasks: HashMap<TaskId, TaskInfo>,
    pub processes: HashMap<TaskId, ProcessEntry>,
}
```

## Crate Dependencies Needed

```toml
libc = "0.2"
nix = { version = "0.29", features = ["signal", "process"] }
```

## Output Batching (from Phase 1 research)

Use 100-500ms interval batching on the frontend side. Rust sends individual lines as they arrive via `Channel::send()`. Frontend OutputConsole already handles line-by-line writes to xterm.js efficiently.

## Recommendations

1. **Use `nix` crate** over raw `libc` for signal operations — safer API, better error types
2. **pgid approach is mandatory** — Tauri only kills direct children, not grandchildren
3. **Arc<Mutex<Child>> not needed** — store pgid as i32, use signals directly. Only need Child for `.wait()`
4. **NO_COLOR=1 + TERM=dumb** on all subprocesses for clean output parsing
5. **Process status enum** tracks lifecycle without holding Child reference after completion

---
*Research completed: 2026-03-05*
