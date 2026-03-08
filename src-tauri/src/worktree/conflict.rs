use git2::{IndexAddOption, Repository};
use std::path::Path;

use super::models::{ConflictFile, ConflictReport};

/// Detect file-level conflicts between two branches using a read-only three-way merge.
///
/// Uses `merge_trees` to simulate a merge without modifying the working directory.
/// Returns a ConflictReport indicating whether conflicts exist and which files are affected.
pub fn detect_conflicts(
    repo_path: &Path,
    branch_a: &str,
    branch_b: &str,
) -> Result<ConflictReport, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repo: {}", e))?;

    // Resolve both branches to commits (using find_branch to handle `/` in names)
    let commit_a = super::resolve_branch_commit(&repo, branch_a)?;
    let commit_b = super::resolve_branch_commit(&repo, branch_b)?;

    // Find merge base (common ancestor)
    let merge_base = repo
        .merge_base(commit_a.id(), commit_b.id())
        .map_err(|e| format!("No common ancestor between '{}' and '{}': {}", branch_a, branch_b, e))?;

    let ancestor_commit = repo
        .find_commit(merge_base)
        .map_err(|e| format!("Failed to find merge base commit: {}", e))?;

    // Get trees from all three commits
    let ancestor_tree = ancestor_commit
        .tree()
        .map_err(|e| format!("Failed to get ancestor tree: {}", e))?;
    let tree_a = commit_a
        .tree()
        .map_err(|e| format!("Failed to get tree for '{}': {}", branch_a, e))?;
    let tree_b = commit_b
        .tree()
        .map_err(|e| format!("Failed to get tree for '{}': {}", branch_b, e))?;

    // Perform read-only three-way merge
    let index = repo
        .merge_trees(&ancestor_tree, &tree_a, &tree_b, None)
        .map_err(|e| format!("Failed to merge trees: {}", e))?;

    // Check for conflicts
    let has_conflicts = index.has_conflicts();
    let mut conflicting_files = Vec::new();

    if has_conflicts {
        let conflicts = index
            .conflicts()
            .map_err(|e| format!("Failed to iterate conflicts: {}", e))?;

        for entry in conflicts {
            let entry = entry.map_err(|e| format!("Failed to read conflict entry: {}", e))?;

            // Extract path from whichever side of the conflict has it
            let path = entry
                .our
                .as_ref()
                .or(entry.their.as_ref())
                .or(entry.ancestor.as_ref())
                .and_then(|e| String::from_utf8(e.path.clone()).ok());

            if let Some(path) = path {
                // Deduplicate (conflicts can appear multiple times per file)
                if !conflicting_files.iter().any(|f: &ConflictFile| f.path == path) {
                    conflicting_files.push(ConflictFile { path });
                }
            }
        }
    }

    Ok(ConflictReport {
        has_conflicts,
        conflicting_files,
        worktree_a: branch_a.to_string(),
        worktree_b: branch_b.to_string(),
    })
}

/// Auto-commit all uncommitted changes in a worktree with a standard message.
///
/// Returns Ok(true) if changes were committed, Ok(false) if the worktree was clean.
pub fn auto_commit_worktree(worktree_path: &Path) -> Result<bool, String> {
    let repo =
        Repository::open(worktree_path).map_err(|e| format!("Failed to open repo: {}", e))?;

    // Check if there are any changes (modified, new, deleted)
    let statuses = repo
        .statuses(None)
        .map_err(|e| format!("Failed to get repo status: {}", e))?;

    let has_changes = statuses.iter().any(|s| {
        !s.status().is_ignored()
            && (s.status().intersects(
                git2::Status::WT_MODIFIED
                    | git2::Status::WT_NEW
                    | git2::Status::WT_DELETED
                    | git2::Status::WT_RENAMED
                    | git2::Status::WT_TYPECHANGE
                    | git2::Status::INDEX_MODIFIED
                    | git2::Status::INDEX_NEW
                    | git2::Status::INDEX_DELETED
                    | git2::Status::INDEX_RENAMED
                    | git2::Status::INDEX_TYPECHANGE,
            ))
    });

    if !has_changes {
        return Ok(false);
    }

    // Stage all changes
    let mut index = repo.index().map_err(|e| format!("Failed to get index: {}", e))?;
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| format!("Failed to stage changes: {}", e))?;
    index
        .write()
        .map_err(|e| format!("Failed to write index: {}", e))?;

    // Write tree from index
    let tree_id = index
        .write_tree()
        .map_err(|e| format!("Failed to write tree: {}", e))?;
    let tree = repo
        .find_tree(tree_id)
        .map_err(|e| format!("Failed to find tree: {}", e))?;

    // Create commit
    let sig = git2::Signature::now("WhaleCode", "whalecode@auto")
        .map_err(|e| format!("Failed to create signature: {}", e))?;
    let parent = repo
        .head()
        .map_err(|e| format!("Failed to get HEAD: {}", e))?
        .peel_to_commit()
        .map_err(|e| format!("Failed to peel HEAD: {}", e))?;

    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        "whalecode: auto-commit task changes",
        &tree,
        &[&parent],
    )
    .map_err(|e| format!("Failed to create commit: {}", e))?;

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, Signature};
    use std::path::PathBuf;

    /// Get the default branch name for a repo (master or main).
    fn default_branch(repo: &Repository) -> String {
        let head = repo.head().unwrap();
        let name = head.shorthand().unwrap().to_string();
        name
    }

    /// Create a temporary git repo with an initial commit containing a single file.
    fn create_test_repo_with_file(name: &str, content: &str) -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().expect("Failed to create tempdir");
        let repo_path = tmp.path().join("repo");
        std::fs::create_dir_all(&repo_path).unwrap();
        let repo = Repository::init(&repo_path).expect("Failed to init repo");

        // Write the file
        let file_path = repo_path.join(name);
        std::fs::write(&file_path, content).unwrap();

        // Stage and commit
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(name)).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let sig = Signature::now("Test", "test@test.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "initial commit", &tree, &[])
            .unwrap();

        (tmp, repo_path)
    }

    /// Create a branch from HEAD and modify a file on it.
    fn create_branch_with_change(
        repo_path: &Path,
        branch_name: &str,
        file: &str,
        content: &str,
    ) {
        let repo = Repository::open(repo_path).unwrap();
        let head = repo.head().unwrap();
        let head_commit = head.peel_to_commit().unwrap();

        // Create branch
        repo.branch(branch_name, &head_commit, false).unwrap();

        // Check out the branch
        let refname = format!("refs/heads/{}", branch_name);
        repo.set_head(&refname).unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();

        // Modify file
        let file_path = repo_path.join(file);
        std::fs::write(&file_path, content).unwrap();

        // Stage and commit
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(file)).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let sig = Signature::now("Test", "test@test.com").unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        repo.commit(
            Some("HEAD"),
            &sig,
            &sig,
            &format!("change on {}", branch_name),
            &tree,
            &[&parent],
        )
        .unwrap();
    }

    /// Go back to the default branch (master/main) of the repo.
    fn checkout_default_branch(repo_path: &Path) {
        let repo = Repository::open(repo_path).unwrap();
        let branch_name = {
            // Find the default branch by checking what branches exist
            if repo
                .find_branch("main", git2::BranchType::Local)
                .is_ok()
            {
                "main"
            } else {
                "master"
            }
        };
        let refname = format!("refs/heads/{}", branch_name);
        repo.set_head(&refname).unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
    }

    #[test]
    fn no_conflict_when_different_files() {
        let (_tmp, repo_path) = create_test_repo_with_file("file1.txt", "initial content");

        // Also add file2.txt to the initial commit so both branches have it
        {
            let repo = Repository::open(&repo_path).unwrap();
            std::fs::write(repo_path.join("file2.txt"), "initial content 2").unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("file2.txt")).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let sig = Signature::now("Test", "test@test.com").unwrap();
            let parent = repo.head().unwrap().peel_to_commit().unwrap();
            repo.commit(
                Some("HEAD"),
                &sig,
                &sig,
                "add file2",
                &tree,
                &[&parent],
            )
            .unwrap();
        }

        // Branch A modifies file1
        create_branch_with_change(&repo_path, "branch-a", "file1.txt", "changed by A");

        // Go back to default branch for branch B
        checkout_default_branch(&repo_path);

        // Branch B modifies file2
        create_branch_with_change(&repo_path, "branch-b", "file2.txt", "changed by B");

        let report =
            detect_conflicts(&repo_path, "branch-a", "branch-b").expect("should detect conflicts");
        assert!(
            !report.has_conflicts,
            "different files should not conflict"
        );
        assert!(report.conflicting_files.is_empty());
    }

    #[test]
    fn conflict_when_same_file_different_changes() {
        let (_tmp, repo_path) = create_test_repo_with_file("shared.txt", "original content");

        // Branch A changes shared.txt
        create_branch_with_change(&repo_path, "conflict-a", "shared.txt", "version A content");

        // Go back to default branch for branch B
        checkout_default_branch(&repo_path);

        // Branch B changes shared.txt differently
        create_branch_with_change(&repo_path, "conflict-b", "shared.txt", "version B content");

        let report = detect_conflicts(&repo_path, "conflict-a", "conflict-b")
            .expect("should detect conflicts");
        assert!(
            report.has_conflicts,
            "same file with different changes should conflict"
        );
        assert!(
            report
                .conflicting_files
                .iter()
                .any(|f| f.path == "shared.txt"),
            "shared.txt should be in conflicting files, got: {:?}",
            report
                .conflicting_files
                .iter()
                .map(|f| &f.path)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn auto_commit_with_changes() {
        let (_tmp, repo_path) = create_test_repo_with_file("existing.txt", "content");

        // Add an uncommitted file
        std::fs::write(repo_path.join("new_file.txt"), "uncommitted content").unwrap();

        let committed = auto_commit_worktree(&repo_path).expect("should auto-commit");
        assert!(committed, "should return true when changes were committed");

        // Verify the file is now committed
        let repo = Repository::open(&repo_path).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let tree = head.tree().unwrap();
        assert!(
            tree.get_name("new_file.txt").is_some(),
            "new_file.txt should be in the committed tree"
        );
    }

    #[test]
    fn auto_commit_no_changes() {
        let (_tmp, repo_path) = create_test_repo_with_file("clean.txt", "content");

        let committed = auto_commit_worktree(&repo_path).expect("should succeed on clean repo");
        assert!(!committed, "should return false when no changes to commit");
    }
}
