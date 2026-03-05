use git2::{Repository, WorktreeAddOptions};
use std::path::PathBuf;

use super::models::WorktreeEntry;

pub struct WorktreeManager {
    repo_path: PathBuf,
    /// Override for the worktree base directory (useful for testing).
    base_dir_override: Option<PathBuf>,
}

impl WorktreeManager {
    pub fn new(repo_path: PathBuf) -> Self {
        Self {
            repo_path,
            base_dir_override: None,
        }
    }

    /// Create a WorktreeManager with a custom base directory for worktrees.
    #[cfg(test)]
    pub fn with_base_dir(repo_path: PathBuf, base_dir: PathBuf) -> Self {
        Self {
            repo_path,
            base_dir_override: Some(base_dir),
        }
    }

    /// Base directory for all whalecode worktrees (sibling to project).
    pub fn worktree_base_dir(&self) -> PathBuf {
        if let Some(ref dir) = self.base_dir_override {
            return dir.clone();
        }
        // Canonicalize repo_path to resolve symlinks, then go to parent
        let canonical = self
            .repo_path
            .canonicalize()
            .unwrap_or_else(|_| self.repo_path.clone());
        canonical
            .parent()
            .unwrap_or(&canonical)
            .join(".whalecode-worktrees")
    }

    /// Create an isolated worktree for a task.
    pub fn create_for_task(&self, task_id: &str) -> Result<WorktreeEntry, String> {
        let repo = Repository::open(&self.repo_path).map_err(|e| e.to_string())?;

        let prefix_len = task_id.len().min(8);
        let prefix = &task_id[..prefix_len];
        let worktree_name = format!("whalecode-{}", prefix);
        let branch_name = format!("whalecode/task/{}", prefix);
        let worktree_path = self.worktree_base_dir().join(&worktree_name);

        // If worktree path already exists, attempt to prune stale worktree and remove dir
        if worktree_path.exists() {
            // Try to find and prune existing worktree
            if let Ok(wt) = repo.find_worktree(&worktree_name) {
                let mut prune_opts = git2::WorktreePruneOptions::new();
                prune_opts.valid(true);
                prune_opts.working_tree(true);
                let _ = wt.prune(Some(&mut prune_opts));
            }
            // Remove the directory if it still exists
            if worktree_path.exists() {
                std::fs::remove_dir_all(&worktree_path).map_err(|e| {
                    format!("Failed to remove stale worktree dir: {}", e)
                })?;
            }
        }

        // Delete branch if it already exists (leftover from previous run)
        if let Ok(mut branch) = repo.find_branch(&branch_name, git2::BranchType::Local) {
            // Can only delete if not checked out
            let _ = branch.delete();
        }

        // Create branch from HEAD commit
        let head = repo.head().map_err(|e| format!("Failed to get HEAD: {}", e))?;
        let head_commit = head
            .peel_to_commit()
            .map_err(|e| format!("Failed to peel HEAD to commit: {}", e))?;
        let branch = repo
            .branch(&branch_name, &head_commit, false)
            .map_err(|e| format!("Failed to create branch: {}", e))?;

        // Create worktree with branch reference
        let mut opts = WorktreeAddOptions::new();
        let branch_ref = branch.into_reference();
        opts.reference(Some(&branch_ref));

        // Ensure parent directory exists
        if let Some(parent) = worktree_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create worktree base dir: {}", e))?;
        }

        repo.worktree(&worktree_name, &worktree_path, Some(&opts))
            .map_err(|e| format!("Failed to create worktree: {}", e))?;

        Ok(WorktreeEntry {
            task_id: task_id.to_string(),
            worktree_name,
            branch_name,
            path: worktree_path,
            created_at: chrono::Utc::now().to_rfc3339(),
        })
    }

    /// Remove a worktree by name, prune it, and delete its branch.
    pub fn remove_worktree(&self, worktree_name: &str) -> Result<(), String> {
        let repo = Repository::open(&self.repo_path).map_err(|e| e.to_string())?;

        // Find and prune the worktree
        if let Ok(wt) = repo.find_worktree(worktree_name) {
            let mut prune_opts = git2::WorktreePruneOptions::new();
            prune_opts.valid(true);
            prune_opts.working_tree(true);
            wt.prune(Some(&mut prune_opts))
                .map_err(|e| format!("Failed to prune worktree: {}", e))?;
        }

        // Remove worktree directory if it still exists
        let worktree_path = self.worktree_base_dir().join(worktree_name);
        if worktree_path.exists() {
            std::fs::remove_dir_all(&worktree_path)
                .map_err(|e| format!("Failed to remove worktree dir: {}", e))?;
        }

        // Delete the associated branch (extract id from worktree name)
        let id = worktree_name.strip_prefix("whalecode-").unwrap_or(worktree_name);
        let branch_name = format!("whalecode/task/{}", id);
        if let Ok(mut branch) = repo.find_branch(&branch_name, git2::BranchType::Local) {
            let _ = branch.delete();
        }

        Ok(())
    }

    /// List all whalecode-prefixed worktrees.
    pub fn list_worktrees(&self) -> Result<Vec<String>, String> {
        let repo = Repository::open(&self.repo_path).map_err(|e| e.to_string())?;
        let worktrees = repo.worktrees().map_err(|e| e.to_string())?;

        let mut result = Vec::new();
        for name in worktrees.iter() {
            if let Some(name) = name {
                if name.starts_with("whalecode-") {
                    result.push(name.to_string());
                }
            }
        }

        Ok(result)
    }

    /// Clean up stale/invalid whalecode worktrees. Returns names of cleaned worktrees.
    pub fn cleanup_stale_worktrees(&self) -> Result<Vec<String>, String> {
        let repo = Repository::open(&self.repo_path).map_err(|e| e.to_string())?;
        let worktrees = repo.worktrees().map_err(|e| e.to_string())?;
        let mut cleaned = Vec::new();

        for name in worktrees.iter() {
            let name = match name {
                Some(n) => n,
                None => continue,
            };
            if !name.starts_with("whalecode-") {
                continue;
            }

            if let Ok(wt) = repo.find_worktree(name) {
                let is_invalid = wt.validate().is_err();
                let is_prunable = wt.is_prunable(None).unwrap_or(false);

                if is_invalid || is_prunable {
                    let mut prune_opts = git2::WorktreePruneOptions::new();
                    prune_opts.valid(true);
                    prune_opts.working_tree(true);
                    if wt.prune(Some(&mut prune_opts)).is_ok() {
                        // Also clean up the directory
                        let wt_path = self.worktree_base_dir().join(name);
                        if wt_path.exists() {
                            let _ = std::fs::remove_dir_all(&wt_path);
                        }
                        cleaned.push(name.to_string());
                    }
                }
            }
        }

        Ok(cleaned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a temporary git repo with an initial commit and a dedicated worktree base dir.
    /// Returns (tempdir_handle, repo_path, worktree_base_dir).
    fn create_test_repo() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().expect("Failed to create tempdir");
        let repo_path = tmp.path().join("repo");
        std::fs::create_dir_all(&repo_path).unwrap();
        let repo = Repository::init(&repo_path).expect("Failed to init repo");

        // Create an initial commit so HEAD exists
        let sig = git2::Signature::now("Test", "test@test.com").unwrap();
        let tree_id = repo.index().unwrap().write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "initial commit", &tree, &[])
            .unwrap();

        // Worktree base dir is a sibling to "repo" inside the same tempdir
        let wt_base = tmp.path().join(".whalecode-worktrees");

        (tmp, repo_path, wt_base)
    }

    fn make_manager(repo_path: &PathBuf, base_dir: &PathBuf) -> WorktreeManager {
        WorktreeManager::with_base_dir(repo_path.clone(), base_dir.clone())
    }

    #[test]
    fn create_for_task_returns_valid_entry() {
        let (_tmp, repo_path, wt_base) = create_test_repo();
        let manager = make_manager(&repo_path, &wt_base);
        let task_id = "abcdef12-3456-7890-abcd-ef1234567890";

        let entry = manager.create_for_task(task_id).expect("should create worktree");

        assert_eq!(entry.task_id, task_id);
        assert_eq!(entry.worktree_name, "whalecode-abcdef12");
        assert_eq!(entry.branch_name, "whalecode/task/abcdef12");
        assert!(entry.path.to_str().unwrap().contains("whalecode-abcdef12"));
        assert!(!entry.created_at.is_empty());
    }

    #[test]
    fn worktree_directory_exists_after_creation() {
        let (_tmp, repo_path, wt_base) = create_test_repo();
        let manager = make_manager(&repo_path, &wt_base);
        let task_id = "dir-exist-test-1234";

        let entry = manager.create_for_task(task_id).expect("should create worktree");
        assert!(entry.path.exists(), "worktree directory should exist");
    }

    #[test]
    fn remove_worktree_cleans_up_directory_and_branch() {
        let (_tmp, repo_path, wt_base) = create_test_repo();
        let manager = make_manager(&repo_path, &wt_base);
        let task_id = "remove-me-test-1234";

        let entry = manager.create_for_task(task_id).expect("should create worktree");
        let wt_path = entry.path.clone();
        let wt_name = entry.worktree_name.clone();
        let branch_name = entry.branch_name.clone();

        assert!(wt_path.exists(), "worktree dir should exist before removal");

        manager.remove_worktree(&wt_name).expect("should remove worktree");

        assert!(!wt_path.exists(), "worktree dir should be gone after removal");

        // Branch should be deleted
        let repo = Repository::open(&repo_path).unwrap();
        assert!(
            repo.find_branch(&branch_name, git2::BranchType::Local)
                .is_err(),
            "branch should be deleted after removal"
        );
    }

    #[test]
    fn list_worktrees_returns_only_whalecode_prefixed() {
        let (_tmp, repo_path, wt_base) = create_test_repo();
        let manager = make_manager(&repo_path, &wt_base);

        // Create two whalecode worktrees
        let _ = manager.create_for_task("list-aaa-test-1234").unwrap();
        let _ = manager.create_for_task("list-bbb-test-5678").unwrap();

        let list = manager.list_worktrees().expect("should list worktrees");

        assert!(
            list.len() >= 2,
            "should have at least 2 worktrees, got {}",
            list.len()
        );
        for name in &list {
            assert!(
                name.starts_with("whalecode-"),
                "all should be whalecode-prefixed: {}",
                name
            );
        }
    }

    #[test]
    fn cleanup_stale_worktrees_handles_invalid_worktrees() {
        let (_tmp, repo_path, wt_base) = create_test_repo();
        let manager = make_manager(&repo_path, &wt_base);

        // Create a worktree, then manually delete its directory to make it stale
        let entry = manager
            .create_for_task("stale-cleanup-test1")
            .unwrap();
        let wt_path = entry.path.clone();

        // Manually remove the worktree directory to simulate crash/stale state
        assert!(
            wt_path.exists(),
            "worktree path should exist before manual removal"
        );
        std::fs::remove_dir_all(&wt_path).expect("should remove dir");

        // Now cleanup should detect and prune the stale worktree
        let cleaned = manager
            .cleanup_stale_worktrees()
            .expect("should cleanup");
        assert!(
            cleaned.contains(&entry.worktree_name),
            "should have cleaned stale worktree, cleaned: {:?}",
            cleaned
        );

        // After cleanup, list should not include it
        let list = manager.list_worktrees().unwrap();
        assert!(
            !list.contains(&entry.worktree_name),
            "stale worktree should be removed from list"
        );
    }

    #[test]
    fn create_for_task_with_duplicate_recovers_gracefully() {
        let (_tmp, repo_path, wt_base) = create_test_repo();
        let manager = make_manager(&repo_path, &wt_base);
        let task_id = "dup-test-recovery-12";

        // Create once
        let entry1 = manager
            .create_for_task(task_id)
            .expect("first create should work");
        assert!(entry1.path.exists());

        // Create again with same task_id -- should recover (prune old, create new)
        let entry2 = manager
            .create_for_task(task_id)
            .expect("second create should recover");
        assert!(entry2.path.exists());
        assert_eq!(entry1.worktree_name, entry2.worktree_name);
    }
}
