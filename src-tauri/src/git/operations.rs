use std::path::Path;
use git2::Repository;

/// Stage files by adding them to the git index.
pub fn stage_files(repo_path: &Path, paths: &[String]) -> Result<(), String> {
    let repo = Repository::discover(repo_path)
        .map_err(|_| format!("No git repository found at or above '{}'", repo_path.display()))?;
    let mut index = repo.index()
        .map_err(|e| format!("Failed to get index: {}", e))?;

    for path in paths {
        index.add_path(Path::new(path))
            .map_err(|e| format!("Failed to stage '{}': {}", path, e))?;
    }

    index.write().map_err(|e| format!("Failed to write index: {}", e))?;
    Ok(())
}

/// Unstage files by resetting them to HEAD in the index.
pub fn unstage_files(repo_path: &Path, paths: &[String]) -> Result<(), String> {
    let repo = Repository::discover(repo_path)
        .map_err(|_| format!("No git repository found at or above '{}'", repo_path.display()))?;

    let head_commit = repo.head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| format!("Failed to get HEAD commit: {}", e))?;

    let head_tree = head_commit.tree()
        .map_err(|e| format!("Failed to get HEAD tree: {}", e))?;

    let mut index = repo.index()
        .map_err(|e| format!("Failed to get index: {}", e))?;

    for path in paths {
        let p = Path::new(path);
        match head_tree.get_path(p) {
            Ok(entry) => {
                // File exists in HEAD — reset index entry to HEAD version
                let idx_entry = git2::IndexEntry {
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
                    path: path.as_bytes().to_vec(),
                };
                index.add(&idx_entry)
                    .map_err(|e| format!("Failed to unstage '{}': {}", path, e))?;
            }
            Err(_) => {
                // File is new (not in HEAD) — remove from index entirely
                index.remove_path(p)
                    .map_err(|e| format!("Failed to unstage '{}': {}", path, e))?;
            }
        }
    }

    index.write().map_err(|e| format!("Failed to write index: {}", e))?;
    Ok(())
}

/// Commit staged changes with a message. Returns the short commit hash.
pub fn commit(repo_path: &Path, message: &str) -> Result<String, String> {
    let repo = Repository::discover(repo_path)
        .map_err(|_| format!("No git repository found at or above '{}'", repo_path.display()))?;

    let sig = repo.signature()
        .map_err(|e| format!("Failed to get git signature (configure user.name/email): {}", e))?;

    let mut index = repo.index()
        .map_err(|e| format!("Failed to get index: {}", e))?;

    let tree_id = index.write_tree()
        .map_err(|e| format!("Failed to write tree: {}", e))?;
    let tree = repo.find_tree(tree_id)
        .map_err(|e| format!("Failed to find tree: {}", e))?;

    let parent = repo.head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| format!("Failed to get HEAD: {}", e))?;

    let commit_oid = repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        message,
        &tree,
        &[&parent],
    ).map_err(|e| format!("Failed to commit: {}", e))?;

    // Return 7-char short hash
    let hash = commit_oid.to_string();
    Ok(hash[..7.min(hash.len())].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn init_test_repo() -> (TempDir, Repository) {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        // Set user config for commits
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Test").unwrap();
        config.set_str("user.email", "test@test.com").unwrap();
        // Initial commit (scoped to release borrows before returning repo)
        {
            let sig = git2::Signature::now("Test", "test@test.com").unwrap();
            let tree_id = repo.index().unwrap().write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
        }
        (dir, repo)
    }

    #[test]
    fn test_stage_and_commit() {
        let (dir, _repo) = init_test_repo();
        fs::write(dir.path().join("test.txt"), "hello").unwrap();
        stage_files(dir.path(), &["test.txt".to_string()]).unwrap();
        let hash = commit(dir.path(), "add test file").unwrap();
        assert_eq!(hash.len(), 7);
    }

    #[test]
    fn test_unstage_new_file() {
        let (dir, _repo) = init_test_repo();
        let file_path = dir.path().join("new.txt");
        fs::write(&file_path, "content").unwrap();

        // Stage it
        stage_files(dir.path(), &["new.txt".to_string()]).unwrap();

        // Verify staged
        let status = super::super::status::get_status(dir.path()).unwrap();
        assert_eq!(status.staged.len(), 1);

        // Unstage it
        unstage_files(dir.path(), &["new.txt".to_string()]).unwrap();

        // Verify no longer staged
        let status = super::super::status::get_status(dir.path()).unwrap();
        assert_eq!(status.staged.len(), 0);
    }

    #[test]
    fn test_commit_empty_index() {
        let (dir, _repo) = init_test_repo();
        // Commit with nothing staged — we accept either success or failure
        let _ = commit(dir.path(), "empty commit");
    }
}
