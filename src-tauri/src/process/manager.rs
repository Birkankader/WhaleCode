use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use uuid::Uuid;

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
    spawn_with_env(cmd, args, cwd, &[], channel, state, None).await
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

    let stdin_tx = if let Some(mut stdin) = child.stdin.take() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

        tauri::async_runtime::spawn(async move {
            use tokio::io::AsyncWriteExt;
            // Auto-answer initial CLI prompts
            let _ = stdin.write_all(b"1\ny\n").await;

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

    // Register in state
    {
        let mut inner = state.lock().map_err(|e| e.to_string())?;
        inner.processes.insert(
            task_id.clone(),
            ProcessEntry {
                pgid: pid,
                status: ProcessStatus::Running,
                tool_name: String::new(),
                task_description: "".to_string(),
                started_at: chrono::Utc::now().timestamp_millis(),
                stdin_tx,
                output_lines: Vec::new(),
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
        let state_for_output = (*state).clone();
        let task_id_for_output = task_id.clone();
        tauri::async_runtime::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                stdout_channel.send(OutputEvent::Stdout(line.clone())).ok();
                // Store output line for review phase summaries
                if let Ok(mut inner) = state_for_output.lock() {
                    if let Some(entry) = inner.processes.get_mut(&task_id_for_output) {
                        entry.output_lines.push(line);
                        // Keep only last 50 lines
                        if entry.output_lines.len() > 50 {
                            entry.output_lines.drain(0..entry.output_lines.len() - 50);
                        }
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
    let waiter_state = (*state).clone();
    let exit_channel = channel;
    tauri::async_runtime::spawn(async move {
        let status: Result<std::process::ExitStatus, std::io::Error> = child.wait().await;
        let exit_code = match &status {
            Ok(s) => s.code().unwrap_or(-1),
            Err(_) => -1,
        };

        // Update process status in state
        if let Ok(mut inner) = waiter_state.lock() {
            if let Some(entry) = inner.processes.get_mut(&waiter_task_id) {
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
                // Free output buffer — no longer needed after exit
                entry.output_lines.clear();
                entry.output_lines.shrink_to_fit();
            }
        }

        exit_channel.send(OutputEvent::Exit(exit_code)).ok();
    });

    Ok(task_id)
}

/// Cancel a running process by sending SIGTERM then SIGKILL to its process group.
pub async fn cancel(task_id: &str, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let pgid = {
        let inner = state.lock().map_err(|e| e.to_string())?;
        let entry = inner
            .processes
            .get(task_id)
            .ok_or_else(|| format!("Process not found: {}", task_id))?;
        entry.pgid
    };

    signals::graceful_kill(pgid).await;

    // Update status
    {
        let mut inner = state.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = inner.processes.get_mut(task_id) {
            entry.status = ProcessStatus::Failed("Cancelled".to_string());
        }
    }

    Ok(())
}

/// Pause a running process by sending SIGSTOP to its process group.
pub fn pause(task_id: &str, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut inner = state.lock().map_err(|e| e.to_string())?;
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
    let mut inner = state.lock().map_err(|e| e.to_string())?;
    let entry = inner
        .processes
        .get_mut(task_id)
        .ok_or_else(|| format!("Process not found: {}", task_id))?;

    signals::resume_group(entry.pgid)?;
    entry.status = ProcessStatus::Running;

    Ok(())
}
