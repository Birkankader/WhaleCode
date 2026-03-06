use crate::worktree::conflict;
use crate::worktree::diff;
use crate::worktree::manager::WorktreeManager;
use crate::worktree::models::{ConflictReport, WorktreeDiffReport, WorktreeEntry};

/// Create an isolated git worktree for a task.
///
/// Creates a new branch and worktree directory in a sibling `.whalecode-worktrees/` folder.
/// Returns the WorktreeEntry for frontend tracking.
#[tauri::command]
#[specta::specta]
pub async fn create_worktree(
    task_id: String,
    project_dir: String,
) -> Result<WorktreeEntry, String> {
    let project_path = std::path::PathBuf::from(project_dir);
    tokio::task::spawn_blocking(move || {
        let manager = WorktreeManager::new(project_path);
        manager.create_for_task(&task_id)
    })
    .await
    .map_err(|e| format!("Worktree creation task failed: {}", e))?
}

/// Check for file-level conflicts between two worktree branches.
///
/// Auto-commits any uncommitted changes in both worktrees before running
/// the three-way merge conflict detection.
#[tauri::command]
#[specta::specta]
pub async fn check_worktree_conflicts(
    project_dir: String,
    branch_a: String,
    branch_b: String,
) -> Result<ConflictReport, String> {
    let project_path = std::path::PathBuf::from(project_dir);
    tokio::task::spawn_blocking(move || {
        // Resolve worktree paths from branch names
        // Branches follow pattern: whalecode/task/{prefix}
        // Worktree dirs follow pattern: .whalecode-worktrees/whalecode-{prefix}
        let manager = WorktreeManager::new(project_path.clone());
        let base_dir = manager.worktree_base_dir();

        // Extract prefix from branch name to find worktree path
        let resolve_worktree_path =
            |branch: &str| -> Option<std::path::PathBuf> {
                let prefix = branch.strip_prefix("whalecode/task/")?;
                let wt_name = format!("whalecode-{}", prefix);
                let path = base_dir.join(&wt_name);
                if path.exists() {
                    Some(path)
                } else {
                    None
                }
            };

        // Auto-commit uncommitted changes in both worktrees (best-effort)
        if let Some(path_a) = resolve_worktree_path(&branch_a) {
            let _ = conflict::auto_commit_worktree(&path_a);
        }
        if let Some(path_b) = resolve_worktree_path(&branch_b) {
            let _ = conflict::auto_commit_worktree(&path_b);
        }

        // Run conflict detection
        conflict::detect_conflicts(&project_path, &branch_a, &branch_b)
    })
    .await
    .map_err(|e| format!("Conflict check task failed: {}", e))?
}

/// Generate per-file unified diffs between a worktree branch and the default branch.
///
/// Auto-commits any uncommitted changes in the worktree before generating diffs
/// to capture all tool changes.
#[tauri::command]
#[specta::specta]
pub async fn get_worktree_diff(
    project_dir: String,
    branch_name: String,
) -> Result<WorktreeDiffReport, String> {
    let project_path = std::path::PathBuf::from(project_dir);
    tokio::task::spawn_blocking(move || {
        // Auto-commit pending changes in the worktree before diffing
        let manager = WorktreeManager::new(project_path.clone());
        let base_dir = manager.worktree_base_dir();
        if let Some(prefix) = branch_name.strip_prefix("whalecode/task/") {
            let wt_path = base_dir.join(format!("whalecode-{}", prefix));
            if wt_path.exists() {
                let _ = conflict::auto_commit_worktree(&wt_path);
            }
        }

        diff::generate_worktree_diff(&project_path, &branch_name)
    })
    .await
    .map_err(|e| format!("Diff task failed: {}", e))?
}

/// Merge a worktree branch into the main/default branch.
///
/// SAFE-04: Pre-merge conflict gate — checks for conflicts against the default branch
/// and all other active whalecode branches before merging. If any conflicts are detected,
/// the merge is blocked and an error is returned.
#[tauri::command]
#[specta::specta]
pub async fn merge_worktree(
    project_dir: String,
    branch_name: String,
    accepted_files: Option<Vec<String>>,
) -> Result<(), String> {
    let project_path = std::path::PathBuf::from(project_dir);
    tokio::task::spawn_blocking(move || {
        let repo =
            git2::Repository::open(&project_path).map_err(|e| format!("Failed to open repo: {}", e))?;

        // Determine the default branch (main or master)
        let default_branch = find_default_branch(&repo)?;

        // Auto-commit any uncommitted changes in the worktree
        let manager = WorktreeManager::new(project_path.clone());
        let base_dir = manager.worktree_base_dir();
        if let Some(prefix) = branch_name.strip_prefix("whalecode/task/") {
            let wt_path = base_dir.join(format!("whalecode-{}", prefix));
            if wt_path.exists() {
                let _ = conflict::auto_commit_worktree(&wt_path);
            }
        }

        // Check conflicts against the default branch
        let report = conflict::detect_conflicts(&project_path, &branch_name, &default_branch)?;
        if report.has_conflicts {
            let files: Vec<String> = report.conflicting_files.iter().map(|f| f.path.clone()).collect();
            return Err(format!(
                "Merge blocked: conflicts with {} in files: {}",
                default_branch,
                files.join(", ")
            ));
        }

        // Check conflicts against all other active whalecode branches
        let other_branches = manager.list_worktrees()?;
        for wt_name in &other_branches {
            let prefix = wt_name.strip_prefix("whalecode-").unwrap_or(wt_name);
            let other_branch = format!("whalecode/task/{}", prefix);
            if other_branch == branch_name {
                continue; // Skip self
            }
            let report = conflict::detect_conflicts(&project_path, &branch_name, &other_branch)?;
            if report.has_conflicts {
                let files: Vec<String> = report.conflicting_files.iter().map(|f| f.path.clone()).collect();
                return Err(format!(
                    "Merge blocked: conflicts with {} in files: {}",
                    other_branch,
                    files.join(", ")
                ));
            }
        }

        // Choose merge strategy based on accepted_files
        if let Some(ref files) = accepted_files {
            // Selective merge: only apply accepted files
            diff::selective_merge(&project_path, &branch_name, files)?;
        } else {
            // Full fast-forward merge (original behavior)
            let branch_commit = repo
                .revparse_single(&branch_name)
                .map_err(|e| format!("Failed to resolve '{}': {}", branch_name, e))?
                .peel_to_commit()
                .map_err(|e| format!("Failed to peel '{}' to commit: {}", branch_name, e))?;

            let default_ref_name = format!("refs/heads/{}", default_branch);
            let mut default_ref = repo
                .find_reference(&default_ref_name)
                .map_err(|e| format!("Failed to find ref '{}': {}", default_ref_name, e))?;

            // Check if fast-forward is possible
            let default_commit = default_ref
                .peel_to_commit()
                .map_err(|e| format!("Failed to get default branch commit: {}", e))?;

            let is_ancestor = repo
                .merge_base(default_commit.id(), branch_commit.id())
                .map(|base| base == default_commit.id())
                .unwrap_or(false);

            if !is_ancestor {
                return Err(format!(
                    "Cannot fast-forward: {} has diverged from {}",
                    default_branch, branch_name
                ));
            }

            // Fast-forward the default branch reference
            default_ref
                .set_target(
                    branch_commit.id(),
                    &format!("whalecode: merge {} into {}", branch_name, default_branch),
                )
                .map_err(|e| format!("Failed to fast-forward merge: {}", e))?;

            // Update working directory to match new HEAD
            repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
                .map_err(|e| format!("Failed to update working directory: {}", e))?;
        }

        // Clean up the worktree after successful merge
        if let Some(prefix) = branch_name.strip_prefix("whalecode/task/") {
            let wt_name = format!("whalecode-{}", prefix);
            let _ = manager.remove_worktree(&wt_name);
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("Merge task failed: {}", e))?
}

/// Clean up stale/invalid worktrees from previous crashed sessions.
///
/// Returns the names of worktrees that were cleaned up.
#[tauri::command]
#[specta::specta]
pub async fn cleanup_worktrees(project_dir: String) -> Result<Vec<String>, String> {
    let project_path = std::path::PathBuf::from(project_dir);
    tokio::task::spawn_blocking(move || {
        let manager = WorktreeManager::new(project_path);
        manager.cleanup_stale_worktrees()
    })
    .await
    .map_err(|e| format!("Cleanup task failed: {}", e))?
}

/// List all active whalecode worktrees for the project.
#[tauri::command]
#[specta::specta]
pub async fn list_worktrees(project_dir: String) -> Result<Vec<String>, String> {
    let project_path = std::path::PathBuf::from(project_dir);
    tokio::task::spawn_blocking(move || {
        let manager = WorktreeManager::new(project_path);
        manager.list_worktrees()
    })
    .await
    .map_err(|e| format!("List task failed: {}", e))?
}

/// Find the default branch name (main or master).
fn find_default_branch(repo: &git2::Repository) -> Result<String, String> {
    if repo
        .find_branch("main", git2::BranchType::Local)
        .is_ok()
    {
        Ok("main".to_string())
    } else if repo
        .find_branch("master", git2::BranchType::Local)
        .is_ok()
    {
        Ok("master".to_string())
    } else {
        Err("Could not find default branch (main or master)".to_string())
    }
}
