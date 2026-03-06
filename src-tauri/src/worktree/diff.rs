use std::path::Path;

use super::models::WorktreeDiffReport;

/// Generate per-file unified diffs between a worktree branch and the default branch.
pub fn generate_worktree_diff(
    _repo_path: &Path,
    _branch_name: &str,
) -> Result<WorktreeDiffReport, String> {
    Err("not implemented".to_string())
}

/// Selectively merge only the accepted files from a branch into the default branch.
pub fn selective_merge(
    _repo_path: &Path,
    _branch_name: &str,
    _accepted_files: &[String],
) -> Result<(), String> {
    Err("not implemented".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, Signature};
    use std::path::PathBuf;

    /// Create a temporary git repo with an initial commit containing a single file.
    fn create_test_repo_with_file(name: &str, content: &str) -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().expect("Failed to create tempdir");
        let repo_path = tmp.path().join("repo");
        std::fs::create_dir_all(&repo_path).unwrap();
        let repo = Repository::init(&repo_path).expect("Failed to init repo");

        let file_path = repo_path.join(name);
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&file_path, content).unwrap();

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

        repo.branch(branch_name, &head_commit, false).unwrap();

        let refname = format!("refs/heads/{}", branch_name);
        repo.set_head(&refname).unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();

        let file_path = repo_path.join(file);
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&file_path, content).unwrap();

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
        let branch_name = if repo
            .find_branch("main", git2::BranchType::Local)
            .is_ok()
        {
            "main"
        } else {
            "master"
        };
        let refname = format!("refs/heads/{}", branch_name);
        repo.set_head(&refname).unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
    }

    /// Create a branch that adds a new file (not modifying existing).
    fn create_branch_with_new_file(
        repo_path: &Path,
        branch_name: &str,
        file: &str,
        content: &str,
    ) {
        let repo = Repository::open(repo_path).unwrap();
        let head = repo.head().unwrap();
        let head_commit = head.peel_to_commit().unwrap();

        repo.branch(branch_name, &head_commit, false).unwrap();
        let refname = format!("refs/heads/{}", branch_name);
        repo.set_head(&refname).unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();

        let file_path = repo_path.join(file);
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&file_path, content).unwrap();

        let mut index = repo.index().unwrap();
        index.add_path(Path::new(file)).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let sig = Signature::now("Test", "test@test.com").unwrap();
        let parent_commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.commit(
            Some("HEAD"),
            &sig,
            &sig,
            &format!("add {} on {}", file, branch_name),
            &tree,
            &[&parent_commit],
        )
        .unwrap();
    }

    /// Create a branch that deletes a file.
    fn create_branch_with_deletion(repo_path: &Path, branch_name: &str, file: &str) {
        let repo = Repository::open(repo_path).unwrap();
        let head = repo.head().unwrap();
        let head_commit = head.peel_to_commit().unwrap();

        repo.branch(branch_name, &head_commit, false).unwrap();
        let refname = format!("refs/heads/{}", branch_name);
        repo.set_head(&refname).unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();

        let file_path = repo_path.join(file);
        std::fs::remove_file(&file_path).unwrap();

        let mut index = repo.index().unwrap();
        index.remove_path(Path::new(file)).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let sig = Signature::now("Test", "test@test.com").unwrap();
        let parent_commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.commit(
            Some("HEAD"),
            &sig,
            &sig,
            &format!("delete {} on {}", file, branch_name),
            &tree,
            &[&parent_commit],
        )
        .unwrap();
    }

    #[test]
    fn diff_modified_file() {
        let (_tmp, repo_path) = create_test_repo_with_file("file.txt", "original content\n");
        create_branch_with_change(&repo_path, "feature", "file.txt", "modified content\n");
        checkout_default_branch(&repo_path);

        let report = generate_worktree_diff(&repo_path, "feature").unwrap();
        assert_eq!(report.files.len(), 1);
        assert_eq!(report.files[0].path, "file.txt");
        assert_eq!(report.files[0].status, "modified");
        assert!(report.files[0].patch.contains('+'));
        assert!(report.files[0].patch.contains('-'));
        assert!(report.files[0].additions > 0);
        assert!(report.files[0].deletions > 0);
    }

    #[test]
    fn diff_added_file() {
        let (_tmp, repo_path) = create_test_repo_with_file("existing.txt", "content\n");
        create_branch_with_new_file(&repo_path, "add-feature", "new_file.txt", "new content\n");
        checkout_default_branch(&repo_path);

        let report = generate_worktree_diff(&repo_path, "add-feature").unwrap();
        let added = report.files.iter().find(|f| f.path == "new_file.txt").unwrap();
        assert_eq!(added.status, "added");
        assert!(added.additions > 0);
    }

    #[test]
    fn diff_deleted_file() {
        let (_tmp, repo_path) = create_test_repo_with_file("to_delete.txt", "will be deleted\n");
        create_branch_with_deletion(&repo_path, "delete-feature", "to_delete.txt");
        checkout_default_branch(&repo_path);

        let report = generate_worktree_diff(&repo_path, "delete-feature").unwrap();
        let deleted = report.files.iter().find(|f| f.path == "to_delete.txt").unwrap();
        assert_eq!(deleted.status, "deleted");
        assert!(deleted.deletions > 0);
    }

    #[test]
    fn diff_additions_deletions_correct() {
        let (_tmp, repo_path) = create_test_repo_with_file("count.txt", "line1\nline2\nline3\n");
        create_branch_with_change(&repo_path, "count-branch", "count.txt", "line1\nnew_line2\nline3\nextra\n");
        checkout_default_branch(&repo_path);

        let report = generate_worktree_diff(&repo_path, "count-branch").unwrap();
        assert_eq!(report.files.len(), 1);
        // "line2" removed, "new_line2" and "extra" added => 2 additions, 1 deletion
        assert_eq!(report.files[0].additions, 2);
        assert_eq!(report.files[0].deletions, 1);
        assert_eq!(report.total_additions, 2);
        assert_eq!(report.total_deletions, 1);
    }

    #[test]
    fn diff_empty_no_changes() {
        let (_tmp, repo_path) = create_test_repo_with_file("stable.txt", "no changes\n");
        // Create branch with same content (no actual changes)
        {
            let repo = Repository::open(&repo_path).unwrap();
            let head = repo.head().unwrap();
            let head_commit = head.peel_to_commit().unwrap();
            repo.branch("no-change", &head_commit, false).unwrap();
        }

        let report = generate_worktree_diff(&repo_path, "no-change").unwrap();
        assert!(report.files.is_empty());
        assert_eq!(report.total_additions, 0);
        assert_eq!(report.total_deletions, 0);
    }

    #[test]
    fn selective_merge_applies_only_accepted_files() {
        let (_tmp, repo_path) = create_test_repo_with_file("base.txt", "base\n");
        // Add a second file to initial commit
        {
            let repo = Repository::open(&repo_path).unwrap();
            std::fs::write(repo_path.join("other.txt"), "other\n").unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("other.txt")).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let sig = Signature::now("Test", "test@test.com").unwrap();
            let parent = repo.head().unwrap().peel_to_commit().unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "add other.txt", &tree, &[&parent])
                .unwrap();
        }

        // Create branch that modifies both files
        create_branch_with_change(&repo_path, "selective-branch", "base.txt", "modified base\n");
        {
            let repo = Repository::open(&repo_path).unwrap();
            std::fs::write(repo_path.join("other.txt"), "modified other\n").unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("other.txt")).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let sig = Signature::now("Test", "test@test.com").unwrap();
            let parent = repo.head().unwrap().peel_to_commit().unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "modify other.txt", &tree, &[&parent])
                .unwrap();
        }
        checkout_default_branch(&repo_path);

        // Only accept base.txt
        selective_merge(&repo_path, "selective-branch", &["base.txt".to_string()]).unwrap();

        // Check default branch: base.txt should be updated, other.txt should remain unchanged
        let repo = Repository::open(&repo_path).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let tree = head.tree().unwrap();
        let base_blob = tree.get_name("base.txt").unwrap().to_object(&repo).unwrap();
        let base_content = base_blob.as_blob().unwrap().content();
        assert_eq!(std::str::from_utf8(base_content).unwrap(), "modified base\n");

        let other_blob = tree.get_name("other.txt").unwrap().to_object(&repo).unwrap();
        let other_content = other_blob.as_blob().unwrap().content();
        assert_eq!(std::str::from_utf8(other_content).unwrap(), "other\n");
    }

    #[test]
    fn selective_merge_empty_accepted_files_no_changes() {
        let (_tmp, repo_path) = create_test_repo_with_file("keep.txt", "original\n");
        create_branch_with_change(&repo_path, "empty-merge", "keep.txt", "changed\n");
        checkout_default_branch(&repo_path);

        selective_merge(&repo_path, "empty-merge", &[]).unwrap();

        // File should remain unchanged
        let repo = Repository::open(&repo_path).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let tree = head.tree().unwrap();
        let blob = tree.get_name("keep.txt").unwrap().to_object(&repo).unwrap();
        let content = blob.as_blob().unwrap().content();
        assert_eq!(std::str::from_utf8(content).unwrap(), "original\n");
    }

    #[test]
    fn selective_merge_handles_nested_paths() {
        let (_tmp, repo_path) = create_test_repo_with_file("src/commands/foo.rs", "fn foo() {}\n");
        create_branch_with_change(&repo_path, "nested-branch", "src/commands/foo.rs", "fn foo() { updated }\n");
        checkout_default_branch(&repo_path);

        selective_merge(&repo_path, "nested-branch", &["src/commands/foo.rs".to_string()]).unwrap();

        let repo = Repository::open(&repo_path).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let tree = head.tree().unwrap();
        let entry = tree.get_path(Path::new("src/commands/foo.rs")).unwrap();
        let blob = entry.to_object(&repo).unwrap();
        let content = blob.as_blob().unwrap().content();
        assert_eq!(std::str::from_utf8(content).unwrap(), "fn foo() { updated }\n");
    }
}
