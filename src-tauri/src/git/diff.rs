use std::path::Path;
use git2::Repository;

/// Get unified diff for a single file (workdir vs HEAD).
pub fn diff_file(repo_path: &Path, file_path: &str) -> Result<String, String> {
    let repo = Repository::discover(repo_path)
        .map_err(|_| format!("No git repository found at or above '{}'", repo_path.display()))?;

    let mut opts = git2::DiffOptions::new();
    opts.pathspec(file_path);
    opts.context_lines(3);

    // Diff HEAD vs workdir (includes both staged and unstaged changes)
    let head_tree = repo.head()
        .and_then(|h| h.peel_to_tree())
        .ok();

    let diff = repo.diff_tree_to_workdir_with_index(
        head_tree.as_ref(),
        Some(&mut opts),
    ).map_err(|e| format!("Failed to generate diff: {}", e))?;

    let mut output = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        let prefix = match line.origin() {
            '+' => "+",
            '-' => "-",
            ' ' => " ",
            _ => "",
        };
        let content = std::str::from_utf8(line.content()).unwrap_or("");
        output.push_str(prefix);
        output.push_str(content);
        true
    }).map_err(|e| format!("Failed to format diff: {}", e))?;

    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn init_test_repo() -> (TempDir, Repository) {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        // Create file and initial commit (scoped to release borrows)
        {
            let sig = git2::Signature::now("Test", "test@test.com").unwrap();
            fs::write(dir.path().join("file.txt"), "line1\nline2\n").unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("file.txt")).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
        }
        (dir, repo)
    }

    #[test]
    fn test_diff_modified_file() {
        let (dir, _repo) = init_test_repo();
        fs::write(dir.path().join("file.txt"), "line1\nchanged\n").unwrap();
        let diff = diff_file(dir.path(), "file.txt").unwrap();
        assert!(diff.contains("-line2"));
        assert!(diff.contains("+changed"));
    }

    #[test]
    fn test_diff_no_changes() {
        let (dir, _repo) = init_test_repo();
        let diff = diff_file(dir.path(), "file.txt").unwrap();
        assert!(diff.is_empty());
    }
}
