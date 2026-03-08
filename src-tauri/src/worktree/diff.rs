use std::path::Path;

use git2::{Delta, Repository};

use super::models::{FileDiff, WorktreeDiffReport};

/// Maximum patch size per file before truncation (50KB).
const MAX_PATCH_SIZE: usize = 50 * 1024;

/// Find the default branch name (main or master).
fn find_default_branch(repo: &Repository) -> Result<String, String> {
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

/// Generate per-file unified diffs between a worktree branch and the default branch.
pub fn generate_worktree_diff(
    repo_path: &Path,
    branch_name: &str,
) -> Result<WorktreeDiffReport, String> {
    let repo =
        Repository::open(repo_path).map_err(|e| format!("Failed to open repo: {}", e))?;

    let default_branch = find_default_branch(&repo)?;

    // Resolve both branches to trees (using find_branch to handle `/` in names)
    let default_commit = super::resolve_branch_commit(&repo, &default_branch)?;
    let default_tree = default_commit
        .tree()
        .map_err(|e| format!("Failed to get tree for '{}': {}", default_branch, e))?;

    let branch_commit = super::resolve_branch_commit(&repo, branch_name)?;
    let branch_tree = branch_commit
        .tree()
        .map_err(|e| format!("Failed to get tree for '{}': {}", branch_name, e))?;

    // Generate diff: default -> branch (shows what branch changed)
    let mut opts = git2::DiffOptions::new();
    opts.context_lines(3);
    let diff = repo
        .diff_tree_to_tree(Some(&default_tree), Some(&branch_tree), Some(&mut opts))
        .map_err(|e| format!("Failed to generate diff: {}", e))?;

    let mut files = Vec::new();
    let mut total_additions: u32 = 0;
    let mut total_deletions: u32 = 0;

    let num_deltas = diff.deltas().len();
    for idx in 0..num_deltas {
        let delta = diff.get_delta(idx).ok_or("Failed to get delta")?;

        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let old_path = match delta.status() {
            Delta::Renamed => delta.old_file().path().map(|p| p.to_string_lossy().to_string()),
            _ => None,
        };

        let status = match delta.status() {
            Delta::Added => "added",
            Delta::Deleted => "deleted",
            Delta::Modified => "modified",
            Delta::Renamed => "renamed",
            _ => "modified",
        }
        .to_string();

        // Get patch text for this file
        let patch = git2::Patch::from_diff(&diff, idx)
            .map_err(|e| format!("Failed to get patch for {}: {}", path, e))?;

        let mut patch_text = String::new();
        let mut additions: u32 = 0;
        let mut deletions: u32 = 0;

        if let Some(mut patch) = patch {
            let buf = patch
                .to_buf()
                .map_err(|e| format!("Failed to convert patch to buf: {}", e))?;
            patch_text = String::from_utf8_lossy(&buf).to_string();

            // Count additions/deletions from patch lines
            for line in patch_text.lines() {
                if line.starts_with('+') && !line.starts_with("+++") {
                    additions += 1;
                } else if line.starts_with('-') && !line.starts_with("---") {
                    deletions += 1;
                }
            }

            // Truncate large patches
            if patch_text.len() > MAX_PATCH_SIZE {
                patch_text.truncate(MAX_PATCH_SIZE);
                patch_text.push_str("\n[diff truncated]");
            }
        }

        total_additions += additions;
        total_deletions += deletions;

        files.push(FileDiff {
            path,
            status,
            old_path,
            patch: patch_text,
            additions,
            deletions,
        });
    }

    Ok(WorktreeDiffReport {
        branch_name: branch_name.to_string(),
        default_branch,
        files,
        total_additions,
        total_deletions,
    })
}

/// Selectively merge only the accepted files from a branch into the default branch.
///
/// Uses an in-memory index approach to handle nested paths correctly.
/// Creates a merge commit on the default branch with only the accepted file changes.
pub fn selective_merge(
    repo_path: &Path,
    branch_name: &str,
    accepted_files: &[String],
) -> Result<(), String> {
    let repo =
        Repository::open(repo_path).map_err(|e| format!("Failed to open repo: {}", e))?;

    let default_branch = find_default_branch(&repo)?;

    // Resolve commits and trees (using find_branch to handle `/` in names)
    let default_commit = super::resolve_branch_commit(&repo, &default_branch)?;
    let default_tree = default_commit
        .tree()
        .map_err(|e| format!("Failed to get default tree: {}", e))?;

    let branch_commit = super::resolve_branch_commit(&repo, branch_name)?;
    let branch_tree = branch_commit
        .tree()
        .map_err(|e| format!("Failed to get branch tree: {}", e))?;

    if accepted_files.is_empty() {
        // No files to merge -- create a merge commit with the default tree unchanged
        let sig = git2::Signature::now("WhaleCode", "whalecode@auto")
            .map_err(|e| format!("Failed to create signature: {}", e))?;

        let default_ref_name = format!("refs/heads/{}", default_branch);
        repo.commit(
            Some(&default_ref_name),
            &sig,
            &sig,
            &format!("whalecode: selective merge from {} (no files accepted)", branch_name),
            &default_tree,
            &[&default_commit, &branch_commit],
        )
        .map_err(|e| format!("Failed to create merge commit: {}", e))?;

        return Ok(());
    }

    // Build new tree: start with default tree, apply accepted files from branch tree
    let mut index = git2::Index::new()
        .map_err(|e| format!("Failed to create index: {}", e))?;

    // Read the default tree into the index
    index
        .read_tree(&default_tree)
        .map_err(|e| format!("Failed to read default tree into index: {}", e))?;

    for file_path in accepted_files {
        let path = std::path::Path::new(file_path);

        // Check if file exists in branch tree
        match branch_tree.get_path(path) {
            Ok(entry) => {
                // File exists in branch -- add/update it in the index
                let mut idx_entry = git2::IndexEntry {
                    ctime: git2::IndexTime::new(0, 0),
                    mtime: git2::IndexTime::new(0, 0),
                    dev: 0,
                    ino: 0,
                    mode: entry.filemode() as u32,
                    uid: 0,
                    gid: 0,
                    file_size: 0,
                    id: entry.id(),
                    flags: 0,
                    flags_extended: 0,
                    path: file_path.as_bytes().to_vec(),
                };

                // Get blob size for file_size
                if let Ok(blob) = repo.find_blob(entry.id()) {
                    idx_entry.file_size = blob.size() as u32;
                }

                index
                    .add(&idx_entry)
                    .map_err(|e| format!("Failed to add {} to index: {}", file_path, e))?;
            }
            Err(_) => {
                // File doesn't exist in branch (was deleted) -- remove from index
                let _ = index.remove_path(path);
            }
        }
    }

    // Write the index to a new tree
    let new_tree_oid = index
        .write_tree_to(&repo)
        .map_err(|e| format!("Failed to write selective tree: {}", e))?;
    let new_tree = repo
        .find_tree(new_tree_oid)
        .map_err(|e| format!("Failed to find new tree: {}", e))?;

    // Create merge commit on default branch
    let sig = git2::Signature::now("WhaleCode", "whalecode@auto")
        .map_err(|e| format!("Failed to create signature: {}", e))?;

    let default_ref_name = format!("refs/heads/{}", default_branch);
    repo.commit(
        Some(&default_ref_name),
        &sig,
        &sig,
        &format!("whalecode: selective merge from {} ({} files)", branch_name, accepted_files.len()),
        &new_tree,
        &[&default_commit, &branch_commit],
    )
    .map_err(|e| format!("Failed to create merge commit: {}", e))?;

    // Update working directory
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .map_err(|e| format!("Failed to update working directory: {}", e))?;

    Ok(())
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
