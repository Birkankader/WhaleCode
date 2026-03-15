use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use uuid::Uuid;

use crate::adapters::ToolCommand;
use crate::ipc::events::OutputEvent;
use crate::process::signals;
use crate::state::{AppState, ProcessEntry, ProcessStatus};

/// Spawn a subprocess with pgid isolation, streaming stdout/stderr via Channel.
/// Returns the task_id for tracking the process.
pub async fn spawn(
    cmd: &str,
    args: &[String],
    cwd: &str,
    channel: Channel<OutputEvent>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    spawn_with_env(cmd, args, cwd, &[], channel, state, None, None).await
}

/// Spawn a subprocess with custom environment variables and pgid isolation,
/// streaming stdout/stderr via Channel. Returns the task_id for tracking.
///
/// SECURITY: env_vars values are never logged or included in error messages
/// as they may contain API keys or other secrets.
pub async fn spawn_with_env(
    cmd: &str,
    args: &[String],
    cwd: &str,
    env_vars: &[(&str, &str)],
    channel: Channel<OutputEvent>,
    state: tauri::State<'_, AppState>,
    existing_task_id: Option<String>,
    initial_stdin: Option<&[u8]>,
) -> Result<String, String> {
    spawn_with_env_core(
        cmd,
        args,
        cwd,
        env_vars,
        "",
        "",
        channel,
        &state,
        existing_task_id,
        initial_stdin,
    )
    .await
}

/// Core implementation for spawning a subprocess with env vars and pgid isolation.
/// Accepts `&AppState` directly so it can be called from both Tauri commands
/// (via `spawn_with_env`) and orchestration code (via `spawn_interactive`).
async fn spawn_with_env_core(
    cmd: &str,
    args: &[String],
    cwd: &str,
    env_vars: &[(&str, &str)],
    task_description: &str,
    tool_name: &str,
    channel: Channel<OutputEvent>,
    state: &AppState,
    existing_task_id: Option<String>,
    initial_stdin: Option<&[u8]>,
) -> Result<String, String> {
    let task_id = existing_task_id.unwrap_or_else(|| Uuid::new_v4().to_string());

    let mut command = Command::new(cmd);
    command
        .args(args)
        .current_dir(cwd)
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        // Prevent nested-session detection by CLI tools that check parent env
        .env_remove("CLAUDECODE")
        .env_remove("CLAUDE_CODE_ENTRYPOINT")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // Inject custom environment variables (keys only logged, values redacted)
    for (key, value) in env_vars {
        command.env(key, value);
    }

    // Create new process group so we can kill the entire tree
    // SAFETY: setpgid is async-signal-safe, safe to call in pre_exec context
    unsafe {
        command.pre_exec(|| {
            libc::setpgid(0, 0);
            Ok(())
        });
    }

    let mut child = command.spawn().map_err(|e| format!("Failed to spawn process: {}", e))?;

    let initial_bytes = initial_stdin.map(|b| b.to_vec());
    let stdin_tx = if let Some(mut stdin) = child.stdin.take() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

        tauri::async_runtime::spawn(async move {
            use tokio::io::AsyncWriteExt;
            // Send adapter-specific initial stdin bytes (e.g., auto-answer prompts)
            if let Some(bytes) = initial_bytes {
                let _ = stdin.write_all(&bytes).await;
            }

            // Then listen for user input
            while let Some(text) = rx.recv().await {
                if stdin.write_all(text.as_bytes()).await.is_err() {
                    break;
                }
                if stdin.write_all(b"\n").await.is_err() {
                    break;
                }
            }
        });

        Some(tx)
    } else {
        None
    };

    // pgid = pid since we called setpgid(0, 0)
    let pid = child.id().ok_or("Failed to get child pid")? as i32;

    // Completion notification channel — waiter task signals when process exits
    let (completion_tx, completion_rx) = tokio::sync::watch::channel(false);
    // Line count notification channel — stdout reader signals new output
    let (line_count_tx, line_count_rx) = tokio::sync::watch::channel(0usize);

    // Register in state
    {
        let mut inner = state.lock();
        inner.processes.insert(
            task_id.clone(),
            ProcessEntry {
                pgid: pid,
                status: ProcessStatus::Running,
                tool_name: tool_name.to_string(),
                task_description: task_description.to_string(),
                started_at: chrono::Utc::now().timestamp_millis(),
                stdin_tx,
                output_lines: Vec::new(),
                completion_rx,
                line_count_rx,
                input_tokens: None,
                output_tokens: None,
                total_tokens: None,
                cost_usd: None,
            },
        );
    }

    // Take stdout and stderr handles
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Clone channel for stderr task
    let stderr_channel = channel.clone();

    // Spawn stdout reader
    if let Some(stdout) = stdout {
        let stdout_channel = channel.clone();
        let state_for_output = state.clone();
        let task_id_for_output = task_id.clone();
        tauri::async_runtime::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                stdout_channel.send(OutputEvent::Stdout(line.clone())).ok();
                // Store output line for review phase summaries
                { let mut inner = state_for_output.lock();
                    if let Some(entry) = inner.processes.get_mut(&task_id_for_output) {
                        entry.output_lines.push(line);
                        // Keep only last 500 lines (increased from 50 to avoid
                        // evicting result events for verbose master agents)
                        if entry.output_lines.len() > 500 {
                            entry.output_lines.drain(0..entry.output_lines.len() - 500);
                        }
                        // Signal new line count to watchers
                        line_count_tx.send(entry.output_lines.len()).ok();
                    }
                }
            }
        });
    }

    // Spawn stderr reader
    if let Some(stderr) = stderr {
        tauri::async_runtime::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                stderr_channel.send(OutputEvent::Stderr(line)).ok();
            }
        });
    }

    // Spawn waiter task to update status on exit
    let waiter_task_id = task_id.clone();
    let waiter_state = state.clone();
    let exit_channel = channel;
    tauri::async_runtime::spawn(async move {
        let status: Result<std::process::ExitStatus, std::io::Error> = child.wait().await;
        let exit_code = match &status {
            Ok(s) => s.code().unwrap_or(-1),
            Err(_) => -1,
        };

        // Update process status in state
        { let mut inner = waiter_state.lock();
            if let Some(entry) = inner.processes.get_mut(&waiter_task_id) {
                extract_usage_from_output(entry);
                match &status {
                    Ok(s) if s.success() => {
                        entry.status = ProcessStatus::Completed(exit_code);
                    }
                    Ok(_) => {
                        entry.status = ProcessStatus::Failed(format!("Exited with code {}", exit_code));
                    }
                    Err(e) => {
                        entry.status = ProcessStatus::Failed(e.to_string());
                    }
                }
                // Drop stdin sender so the stdin writer task can exit
                entry.stdin_tx = None;
                // Keep output_lines — they may still be read by
                // wait_for_turn_complete or parse_decomposition_from_output
                // after process exit. Buffer is already capped at 500 lines.
            }
        }

        // Signal completion — wakes any wait_for_process_completion callers
        completion_tx.send(true).ok();

        exit_channel.send(OutputEvent::Exit(exit_code)).ok();
    });

    Ok(task_id)
}

/// Extract token usage from NDJSON result events in process output.
/// Scans the last 10 lines for a result event.
fn extract_usage_from_output(entry: &mut ProcessEntry) {
    let start = entry.output_lines.len().saturating_sub(10);
    for line in &entry.output_lines[start..] {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line.trim()) {
            if parsed.get("type").and_then(|v| v.as_str()) == Some("result") {
                // Claude: total_cost_usd at top level
                if let Some(cost) = parsed.get("total_cost_usd").and_then(|v| v.as_f64()) {
                    entry.cost_usd = Some(cost);
                }
                // Claude: usage.input_tokens, usage.output_tokens (if present)
                if let Some(usage) = parsed.get("usage") {
                    if let Some(input) = usage.get("input_tokens").and_then(|v| v.as_u64()) {
                        entry.input_tokens = Some(input);
                    }
                    if let Some(output) = usage.get("output_tokens").and_then(|v| v.as_u64()) {
                        entry.output_tokens = Some(output);
                    }
                    if let Some(total) = usage.get("total_tokens").and_then(|v| v.as_u64()) {
                        entry.total_tokens = Some(total);
                    } else if entry.input_tokens.is_some() && entry.output_tokens.is_some() {
                        entry.total_tokens = Some(entry.input_tokens.unwrap() + entry.output_tokens.unwrap());
                    }
                }
                // Gemini: stats.input_tokens, stats.output_tokens, stats.total_tokens
                if let Some(stats) = parsed.get("stats") {
                    if let Some(input) = stats.get("input_tokens").and_then(|v| v.as_u64()) {
                        entry.input_tokens = Some(input);
                    }
                    if let Some(output) = stats.get("output_tokens").and_then(|v| v.as_u64()) {
                        entry.output_tokens = Some(output);
                    }
                    if let Some(total) = stats.get("total_tokens").and_then(|v| v.as_u64()) {
                        entry.total_tokens = Some(total);
                    }
                }
                break;
            }
        }
    }
}

/// Spawn an agent in interactive mode for multi-turn conversation.
/// Returns task_id. Use ProcessEntry.stdin_tx to send subsequent prompts.
pub async fn spawn_interactive(
    tool_command: ToolCommand,
    task_description: &str,
    tool_name: &str,
    channel: Channel<OutputEvent>,
    state: &AppState,
) -> Result<String, String> {
    let env_refs: Vec<(&str, &str)> = tool_command
        .env
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();

    spawn_with_env_core(
        &tool_command.cmd,
        &tool_command.args,
        &tool_command.cwd,
        &env_refs,
        task_description,
        tool_name,
        channel,
        state,
        None,
        None,
    )
    .await
}

/// Send a message to a running process's stdin channel.
pub fn send_to_process(
    state: &AppState,
    task_id: &str,
    message: &str,
) -> Result<(), String> {
    let state_guard = state.lock();
    let entry = state_guard
        .processes
        .get(task_id)
        .ok_or_else(|| format!("Process {} not found", task_id))?;
    let stdin_tx = entry
        .stdin_tx
        .as_ref()
        .ok_or_else(|| format!("Process {} has no stdin channel", task_id))?;
    stdin_tx
        .send(message.to_string())
        .map_err(|e| format!("Failed to send to stdin: {}", e))
}

/// Close a process's stdin, signaling EOF. This causes CLIs that read until EOF
/// (like Claude Code in non-TTY mode) to start processing their input.
pub fn close_stdin(state: &AppState, task_id: &str) -> Result<(), String> {
    let mut state_guard = state.lock();
    let entry = state_guard
        .processes
        .get_mut(task_id)
        .ok_or_else(|| format!("Process {} not found", task_id))?;
    // Dropping the sender closes the mpsc channel, which makes the stdin writer
    // task exit its loop, dropping ChildStdin and closing the pipe fd.
    entry.stdin_tx = None;
    Ok(())
}

/// Cancel a running process by sending SIGTERM then SIGKILL to its process group.
pub async fn cancel(task_id: &str, state: tauri::State<'_, AppState>) -> Result<(), String> {
    kill_and_remove(task_id, &state).await
}

/// Kill a process and remove it from state. Works with `&AppState` directly
/// so it can be called from orchestration code (not just Tauri commands).
///
/// 1. Sends SIGTERM → waits 2s → SIGKILL to the process group.
/// 2. Removes the process entry from state entirely.
///
/// Idempotent: returns Ok(()) if the process was already removed or never existed.
pub async fn kill_and_remove(task_id: &str, state: &AppState) -> Result<(), String> {
    let pgid = {
        let inner = state.lock();
        match inner.processes.get(task_id) {
            Some(entry) => match entry.status {
                // Already dead — just remove below
                ProcessStatus::Completed(_) | ProcessStatus::Failed(_) => None,
                _ => Some(entry.pgid),
            },
            None => return Ok(()), // Already removed — nothing to do
        }
    };

    if let Some(pgid) = pgid {
        signals::graceful_kill(pgid).await;
    }

    // Remove from state entirely (don't just mark Failed — that leaks memory)
    {
        let mut inner = state.lock();
        inner.processes.remove(task_id);
    }

    Ok(())
}

/// Pause a running process by sending SIGSTOP to its process group.
pub fn pause(task_id: &str, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut inner = state.lock();
    let entry = inner
        .processes
        .get_mut(task_id)
        .ok_or_else(|| format!("Process not found: {}", task_id))?;

    signals::pause_group(entry.pgid)?;
    entry.status = ProcessStatus::Paused;

    Ok(())
}

/// Resume a paused process by sending SIGCONT to its process group.
pub fn resume(task_id: &str, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut inner = state.lock();
    let entry = inner
        .processes
        .get_mut(task_id)
        .ok_or_else(|| format!("Process not found: {}", task_id))?;

    signals::resume_group(entry.pgid)?;
    entry.status = ProcessStatus::Running;

    Ok(())
}

/// Atomically check that no running process exists for `tool_name` and reserve the slot.
/// Returns `Err` if the tool already has a running process or is being dispatched.
pub fn acquire_tool_slot(state: &AppState, tool_name: &str) -> Result<(), String> {
    let mut inner = state.lock();
    for (_id, proc) in inner.processes.iter() {
        if proc.tool_name == tool_name && matches!(proc.status, ProcessStatus::Running) {
            return Err(format!("{} is already running a task", tool_name));
        }
    }
    if !inner.reserved_tools.insert(tool_name.to_string()) {
        return Err(format!("{} is already being dispatched", tool_name));
    }
    Ok(())
}

/// Release a tool slot reservation. Idempotent.
pub fn release_tool_slot(state: &AppState, tool_name: &str) {
    { let mut inner = state.lock();
        inner.reserved_tools.remove(tool_name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spawn_interactive_builds_correct_args() {
        let adapter = crate::adapters::claude::ClaudeAdapter;
        use crate::adapters::ToolAdapter;
        let cmd = adapter.build_interactive_command("/tmp", "test-key");
        assert!(!cmd.args.iter().any(|a| a == "-p"));
        assert!(cmd.args.contains(&"--output-format".to_string()));
    }

    #[test]
    fn test_send_to_process_missing_process() {
        use std::sync::Arc; use parking_lot::Mutex;
        let state: AppState = Arc::new(Mutex::new(Default::default()));
        let result = send_to_process(&state, "nonexistent", "hello");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn test_acquire_tool_slot_success() {
        use std::sync::Arc; use parking_lot::Mutex;
        let state: AppState = Arc::new(Mutex::new(Default::default()));
        assert!(acquire_tool_slot(&state, "claude").is_ok());
        assert!(state.lock().reserved_tools.contains("claude"));
    }

    #[test]
    fn test_acquire_tool_slot_already_reserved() {
        use std::sync::Arc; use parking_lot::Mutex;
        let state: AppState = Arc::new(Mutex::new(Default::default()));
        acquire_tool_slot(&state, "claude").unwrap();
        let err = acquire_tool_slot(&state, "claude");
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("already being dispatched"));
    }

    #[test]
    fn test_acquire_tool_slot_running_process() {
        use std::sync::Arc; use parking_lot::Mutex;
        let state: AppState = Arc::new(Mutex::new(Default::default()));
        let (_tx, rx) = tokio::sync::watch::channel(false);
        let (_ltx, lrx) = tokio::sync::watch::channel(0usize);
        {
            let mut inner = state.lock();
            inner.processes.insert("t1".to_string(), ProcessEntry {
                pgid: 1, status: ProcessStatus::Running,
                tool_name: "claude".to_string(), task_description: "test".to_string(),
                started_at: 0, stdin_tx: None, output_lines: vec![],
                completion_rx: rx, line_count_rx: lrx,
                input_tokens: None, output_tokens: None, total_tokens: None, cost_usd: None,
            });
        }
        let err = acquire_tool_slot(&state, "claude");
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("already running"));
    }

    #[test]
    fn test_release_tool_slot() {
        use std::sync::Arc; use parking_lot::Mutex;
        let state: AppState = Arc::new(Mutex::new(Default::default()));
        acquire_tool_slot(&state, "claude").unwrap();
        release_tool_slot(&state, "claude");
        assert!(!state.lock().reserved_tools.contains("claude"));
        // Can re-acquire
        assert!(acquire_tool_slot(&state, "claude").is_ok());
    }
}
