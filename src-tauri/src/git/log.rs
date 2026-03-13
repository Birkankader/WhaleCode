use std::path::Path;
use git2::Repository;
use super::models::GitLogEntry;

/// Get the N most recent commits.
pub fn get_log(repo_path: &Path, limit: u32) -> Result<Vec<GitLogEntry>, String> {
    let repo = Repository::discover(repo_path)
        .map_err(|_| format!("No git repository found at or above '{}'", repo_path.display()))?;

    let head = repo.head()
        .map_err(|e| format!("Failed to get HEAD: {}", e))?;
    let head_oid = head.target()
        .ok_or("HEAD has no target")?;

    let mut revwalk = repo.revwalk()
        .map_err(|e| format!("Failed to create revwalk: {}", e))?;
    revwalk.push(head_oid)
        .map_err(|e| format!("Failed to push HEAD: {}", e))?;
    revwalk.set_sorting(git2::Sort::TIME)
        .map_err(|e| format!("Failed to set sorting: {}", e))?;

    let now = chrono::Utc::now().timestamp();
    let mut entries = Vec::new();

    for oid_result in revwalk.take(limit as usize) {
        let oid = oid_result.map_err(|e| format!("Revwalk error: {}", e))?;
        let commit = repo.find_commit(oid)
            .map_err(|e| format!("Failed to find commit: {}", e))?;

        let hash = oid.to_string();
        let short_hash = hash[..7.min(hash.len())].to_string();
        let message = commit.summary().unwrap_or("").to_string();
        let author = commit.author().name().unwrap_or("").to_string();
        let time = commit.time().seconds();
        let time_ago = format_relative_time(now, time);

        entries.push(GitLogEntry {
            hash: short_hash,
            message,
            author,
            time_ago,
        });
    }

    Ok(entries)
}

fn format_relative_time(now: i64, then: i64) -> String {
    let diff = now - then;
    if diff < 60 { return "just now".to_string(); }
    if diff < 3600 { return format!("{}m ago", diff / 60); }
    if diff < 86400 { return format!("{}h ago", diff / 3600); }
    if diff < 604800 { return format!("{}d ago", diff / 86400); }
    format!("{}w ago", diff / 604800)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn init_test_repo_with_commits() -> (TempDir, Repository) {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let sig = git2::Signature::now("Test Author", "test@test.com").unwrap();

        // First commit (empty tree)
        let tree_id = repo.index().unwrap().write_tree().unwrap();
        let c1 = {
            let tree = repo.find_tree(tree_id).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "first commit", &tree, &[]).unwrap()
        };

        // Second commit (with a file)
        fs::write(dir.path().join("a.txt"), "a").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(Path::new("a.txt")).unwrap();
        idx.write().unwrap();
        let tree2_id = idx.write_tree().unwrap();
        {
            let parent = repo.find_commit(c1).unwrap();
            let tree2 = repo.find_tree(tree2_id).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "second commit", &tree2, &[&parent]).unwrap();
        }

        (dir, repo)
    }

    #[test]
    fn test_log_returns_commits() {
        let (dir, _repo) = init_test_repo_with_commits();
        let log = get_log(dir.path(), 10).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].message, "second commit");
        assert_eq!(log[1].message, "first commit");
        assert_eq!(log[0].author, "Test Author");
    }

    #[test]
    fn test_log_respects_limit() {
        let (dir, _repo) = init_test_repo_with_commits();
        let log = get_log(dir.path(), 1).unwrap();
        assert_eq!(log.len(), 1);
    }

    #[test]
    fn test_format_relative_time() {
        assert_eq!(format_relative_time(100, 95), "just now");
        assert_eq!(format_relative_time(1000, 700), "5m ago");
        assert_eq!(format_relative_time(10000, 3000), "1h ago");
    }
}
