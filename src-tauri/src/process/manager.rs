use std::os::unix::process::CommandExt;

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
    let task_id = Uuid::new_v4().to_string();

    let mut command = Command::new(cmd);
    command
        .args(args)
        .current_dir(cwd)
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // Create new process group so we can kill the entire tree
    unsafe {
        command.pre_exec(|| {
            libc::setpgid(0, 0);
            Ok(())
        });
    }

    let mut child = command.spawn().map_err(|e| format!("Failed to spawn process: {}", e))?;

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
        tauri::async_runtime::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                stdout_channel.send(OutputEvent::Stdout(line)).ok();
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
