use nix::sys::signal::{killpg, Signal};
use nix::unistd::Pid;
use std::time::Duration;

/// Send a signal to an entire process group.
pub fn kill_process_group(pgid: i32, signal: Signal) -> Result<(), String> {
    killpg(Pid::from_raw(pgid), signal).map_err(|e| format!("Failed to send {:?} to pgid {}: {}", signal, pgid, e))
}

/// Gracefully kill a process group: SIGTERM, wait 2s, then SIGKILL.
pub async fn graceful_kill(pgid: i32) {
    // Send SIGTERM first
    let _ = kill_process_group(pgid, Signal::SIGTERM);

    // Wait 2 seconds for graceful shutdown
    tokio::time::sleep(Duration::from_secs(2)).await;

    // Force kill if still alive
    let _ = kill_process_group(pgid, Signal::SIGKILL);
}

/// Pause an entire process group via SIGSTOP.
pub fn pause_group(pgid: i32) -> Result<(), String> {
    kill_process_group(pgid, Signal::SIGSTOP)
}

/// Resume an entire process group via SIGCONT.
pub fn resume_group(pgid: i32) -> Result<(), String> {
    kill_process_group(pgid, Signal::SIGCONT)
}
