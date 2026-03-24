use crate::git::{diff, log, models::*, operations, status};
use crate::utils::validate_project_dir;

/// Check if a directory is a valid git repository.
#[tauri::command]
#[specta::specta]
pub async fn check_git_repo(project_dir: String) -> Result<bool, String> {
    let path = super::expand_tilde(&project_dir);
    tokio::task::spawn_blocking(move || {
        Ok(git2::Repository::open(&path).is_ok())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Initialize a git repository, stage all files, and create an initial commit.
/// Returns the commit hash on success.
#[tauri::command]
#[specta::specta]
pub async fn init_git_repo(project_dir: String) -> Result<String, String> {
    let path = super::expand_tilde(&project_dir);
    tokio::task::spawn_blocking(move || {
        // git init
        let repo = git2::Repository::init(&path)
            .map_err(|e| format!("Failed to initialize git repository: {}", e))?;

        // git add -A
        let mut index = repo.index()
            .map_err(|e| format!("Failed to get index: {}", e))?;
        index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .map_err(|e| format!("Failed to stage files: {}", e))?;
        index.write()
            .map_err(|e| format!("Failed to write index: {}", e))?;
        let tree_oid = index.write_tree()
            .map_err(|e| format!("Failed to write tree: {}", e))?;
        let tree = repo.find_tree(tree_oid)
            .map_err(|e| format!("Failed to find tree: {}", e))?;

        // git commit -m "Initial commit"
        let sig = repo.signature()
            .or_else(|_| git2::Signature::now("WhaleCode", "whalecode@local"))
            .map_err(|e| format!("Failed to create signature: {}", e))?;
        let commit_oid = repo.commit(
            Some("HEAD"),
            &sig,
            &sig,
            "Initial commit",
            &tree,
            &[], // no parents — this is the first commit
        ).map_err(|e| format!("Failed to create commit: {}", e))?;

        Ok(commit_oid.to_string())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

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
    validate_project_dir(&path)?;
    tokio::task::spawn_blocking(move || operations::stage_files(&path, &paths))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
#[specta::specta]
pub async fn git_unstage_files(project_dir: String, paths: Vec<String>) -> Result<(), String> {
    let path = super::expand_tilde(&project_dir);
    validate_project_dir(&path)?;
    tokio::task::spawn_blocking(move || operations::unstage_files(&path, &paths))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
#[specta::specta]
pub async fn git_commit(project_dir: String, message: String) -> Result<String, String> {
    let path = super::expand_tilde(&project_dir);
    validate_project_dir(&path)?;
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
    validate_project_dir(&path)?;
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
    validate_project_dir(&path)?;
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
