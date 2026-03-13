use std::path::Path;

use git2::{Repository, StatusOptions};

use super::models::{GitFileEntry, GitStatusReport};

/// Returns the current branch name, or "HEAD (detached)" if detached.
fn get_branch_name(repo: &Repository) -> String {
    repo.head()
        .ok()
        .and_then(|head| head.shorthand().map(String::from))
        .unwrap_or_else(|| "HEAD (detached)".to_string())
}

/// Returns (ahead, behind) commit counts relative to the upstream tracking branch.
/// Returns (0, 0) if there is no upstream or if it cannot be determined.
fn get_ahead_behind(repo: &Repository) -> (u32, u32) {
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return (0, 0),
    };

    let local_oid = match head.target() {
        Some(oid) => oid,
        None => return (0, 0),
    };

    let branch_name = match head.shorthand() {
        Some(name) => name.to_string(),
        None => return (0, 0),
    };

    let upstream_name = format!("refs/remotes/origin/{}", branch_name);
    let upstream_ref = match repo.find_reference(&upstream_name) {
        Ok(r) => r,
        Err(_) => return (0, 0),
    };

    let upstream_oid = match upstream_ref.target() {
        Some(oid) => oid,
        None => return (0, 0),
    };

    match repo.graph_ahead_behind(local_oid, upstream_oid) {
        Ok((ahead, behind)) => (ahead as u32, behind as u32),
        Err(_) => (0, 0),
    }
}

/// Computes a status label string from git2 status flags.
fn status_label(status: git2::Status) -> &'static str {
    if status.contains(git2::Status::INDEX_NEW) {
        "added"
    } else if status.contains(git2::Status::INDEX_MODIFIED) {
        "modified"
    } else if status.contains(git2::Status::INDEX_DELETED) {
        "deleted"
    } else if status.contains(git2::Status::INDEX_RENAMED) {
        "renamed"
    } else if status.contains(git2::Status::INDEX_TYPECHANGE) {
        "typechange"
    } else if status.contains(git2::Status::WT_MODIFIED) {
        "modified"
    } else if status.contains(git2::Status::WT_DELETED) {
        "deleted"
    } else if status.contains(git2::Status::WT_RENAMED) {
        "renamed"
    } else if status.contains(git2::Status::WT_TYPECHANGE) {
        "typechange"
    } else {
        "unknown"
    }
}

/// Retrieves the full git status for a repository at the given path.
///
/// Returns a `GitStatusReport` containing branch info, ahead/behind counts,
/// and categorized file lists (staged, unstaged, untracked).
pub fn get_status(repo_path: &Path) -> Result<GitStatusReport, String> {
    let repo = Repository::discover(repo_path)
        .map_err(|_| format!("No git repository found at or above '{}'", repo_path.display()))?;

    let branch = get_branch_name(&repo);
    let (ahead, behind) = get_ahead_behind(&repo);

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("Failed to get statuses: {}", e))?;

    let mut staged: Vec<GitFileEntry> = Vec::new();
    let mut unstaged: Vec<GitFileEntry> = Vec::new();
    let mut untracked: Vec<String> = Vec::new();

    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let status = entry.status();

        // Untracked files
        if status.contains(git2::Status::WT_NEW) {
            untracked.push(path.clone());
            continue;
        }

        // Staged changes (INDEX_*)
        let index_flags = git2::Status::INDEX_NEW
            | git2::Status::INDEX_MODIFIED
            | git2::Status::INDEX_DELETED
            | git2::Status::INDEX_RENAMED
            | git2::Status::INDEX_TYPECHANGE;

        if status.intersects(index_flags) {
            staged.push(GitFileEntry {
                path: path.clone(),
                status: status_label(status).to_string(),
                additions: 0,
                deletions: 0,
            });
        }

        // Unstaged changes (WT_*)
        let wt_flags = git2::Status::WT_MODIFIED
            | git2::Status::WT_DELETED
            | git2::Status::WT_RENAMED
            | git2::Status::WT_TYPECHANGE;

        if status.intersects(wt_flags) {
            unstaged.push(GitFileEntry {
                path: path.clone(),
                status: status_label(status).to_string(),
                additions: 0,
                deletions: 0,
            });
        }
    }

    Ok(GitStatusReport {
        branch,
        ahead,
        behind,
        staged,
        unstaged,
        untracked,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Helper: create a git repo with an initial commit so HEAD is valid.
    fn init_repo_with_commit(dir: &Path) -> Repository {
        let repo = Repository::init(dir).expect("Failed to init repo");

        // Configure user for commits
        let mut config = repo.config().expect("Failed to get config");
        config
            .set_str("user.name", "Test User")
            .expect("Failed to set user.name");
        config
            .set_str("user.email", "test@example.com")
            .expect("Failed to set user.email");

        // Create an initial commit on the default branch
        {
            let sig = repo.signature().expect("Failed to create signature");
            let tree_id = repo
                .index()
                .expect("Failed to get index")
                .write_tree()
                .expect("Failed to write tree");
            let tree = repo.find_tree(tree_id).expect("Failed to find tree");
            repo.commit(Some("HEAD"), &sig, &sig, "Initial commit", &tree, &[])
                .expect("Failed to create initial commit");
        }

        repo
    }

    #[test]
    fn test_clean_repo_status() {
        let tmp = TempDir::new().expect("Failed to create temp dir");
        let _repo = init_repo_with_commit(tmp.path());

        let report = get_status(tmp.path()).expect("get_status failed");

        // Should be on default branch (usually "main" or "master")
        assert!(!report.branch.is_empty());
        assert_eq!(report.ahead, 0);
        assert_eq!(report.behind, 0);
        assert!(report.staged.is_empty());
        assert!(report.unstaged.is_empty());
        assert!(report.untracked.is_empty());
    }

    #[test]
    fn test_untracked_file_detection() {
        let tmp = TempDir::new().expect("Failed to create temp dir");
        let _repo = init_repo_with_commit(tmp.path());

        // Create an untracked file
        fs::write(tmp.path().join("new_file.txt"), "hello").expect("Failed to write file");

        let report = get_status(tmp.path()).expect("get_status failed");

        assert_eq!(report.untracked.len(), 1);
        assert_eq!(report.untracked[0], "new_file.txt");
        assert!(report.staged.is_empty());
        assert!(report.unstaged.is_empty());
    }

    #[test]
    fn test_staged_file_detection() {
        let tmp = TempDir::new().expect("Failed to create temp dir");
        let repo = init_repo_with_commit(tmp.path());

        // Create a file and stage it
        fs::write(tmp.path().join("staged_file.txt"), "content").expect("Failed to write file");
        let mut index = repo.index().expect("Failed to get index");
        index
            .add_path(Path::new("staged_file.txt"))
            .expect("Failed to add to index");
        index.write().expect("Failed to write index");

        let report = get_status(tmp.path()).expect("get_status failed");

        assert_eq!(report.staged.len(), 1);
        assert_eq!(report.staged[0].path, "staged_file.txt");
        assert_eq!(report.staged[0].status, "added");
        assert!(report.untracked.is_empty());
    }

    #[test]
    fn test_non_repo_error() {
        let tmp = TempDir::new().expect("Failed to create temp dir");
        // Don't init any repo — just a plain directory

        let result = get_status(tmp.path());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No git repository found"));
    }
}
