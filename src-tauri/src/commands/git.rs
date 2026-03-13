use crate::git::{diff, log, models::*, operations, status};

#[tauri::command]
#[specta::specta]
pub async fn git_status(project_dir: String) -> Result<GitStatusReport, String> {
    let path = super::expand_tilde(&project_dir);
    tokio::task::spawn_blocking(move || status::get_status(&path))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
#[specta::specta]
pub async fn git_stage_files(project_dir: String, paths: Vec<String>) -> Result<(), String> {
    let path = super::expand_tilde(&project_dir);
    tokio::task::spawn_blocking(move || operations::stage_files(&path, &paths))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
#[specta::specta]
pub async fn git_unstage_files(project_dir: String, paths: Vec<String>) -> Result<(), String> {
    let path = super::expand_tilde(&project_dir);
    tokio::task::spawn_blocking(move || operations::unstage_files(&path, &paths))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
#[specta::specta]
pub async fn git_commit(project_dir: String, message: String) -> Result<String, String> {
    let path = super::expand_tilde(&project_dir);
    tokio::task::spawn_blocking(move || operations::commit(&path, &message))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
#[specta::specta]
pub async fn git_diff_file(project_dir: String, file_path: String) -> Result<String, String> {
    let path = super::expand_tilde(&project_dir);
    tokio::task::spawn_blocking(move || diff::diff_file(&path, &file_path))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
#[specta::specta]
pub async fn git_log(project_dir: String, limit: u32) -> Result<Vec<GitLogEntry>, String> {
    let path = super::expand_tilde(&project_dir);
    tokio::task::spawn_blocking(move || log::get_log(&path, limit))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
#[specta::specta]
pub async fn git_pull(project_dir: String) -> Result<GitPullResult, String> {
    let path = super::expand_tilde(&project_dir);
    let output = tokio::process::Command::new("git")
        .args(["pull"])
        .current_dir(&path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git pull: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let message = if stdout.is_empty() {
        stderr.clone()
    } else {
        stdout
    };

    Ok(GitPullResult {
        success: output.status.success(),
        message: message.trim().to_string(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn git_push(project_dir: String) -> Result<GitPushResult, String> {
    let path = super::expand_tilde(&project_dir);
    let output = tokio::process::Command::new("git")
        .args(["push"])
        .current_dir(&path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git push: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let message = if stdout.is_empty() {
        stderr.clone()
    } else {
        stdout
    };

    Ok(GitPushResult {
        success: output.status.success(),
        message: message.trim().to_string(),
    })
}
