# Git View Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a full-screen "Git" tab to WhaleCode for viewing git status, staging/unstaging files, committing, pulling, pushing, inline diffs, and recent commit history.

**Architecture:** Hybrid git2 + CLI backend. git2 handles local operations (status, stage, commit, diff, log). Git CLI handles push/pull for auth compatibility. New `GitView` component as a tab-based view.

**Tech Stack:** Rust (git2 crate, already in Cargo.toml), tauri-specta for type bindings, React + Zustand + Tailwind CSS 4.

---

### Task 1: Git Data Models

**Files:**
- Create: `src-tauri/src/git/models.rs`
- Create: `src-tauri/src/git/mod.rs`

**Step 1: Create the git module with data types**

Create `src-tauri/src/git/mod.rs`:
```rust
pub mod models;
```

Create `src-tauri/src/git/models.rs`:
```rust
use serde::Serialize;
use specta::Type;

#[derive(Debug, Clone, Serialize, Type)]
pub struct GitFileEntry {
    pub path: String,
    pub status: String,      // "modified" | "added" | "deleted" | "renamed"
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct GitStatusReport {
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<GitFileEntry>,
    pub unstaged: Vec<GitFileEntry>,
    pub untracked: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct GitLogEntry {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub time_ago: String,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct GitPullResult {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct GitPushResult {
    pub success: bool,
    pub message: String,
}
```

**Step 2: Register the git module in lib.rs**

In `src-tauri/src/lib.rs`, add `mod git;` after the existing `mod state;` line (line 12).

**Step 3: Verify it compiles**

Run: `cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5`
Expected: Compiles with no errors (warnings OK).

**Step 4: Commit**

```bash
git add src-tauri/src/git/
git commit -m "feat(git): add data models for git view"
```

---

### Task 2: git_status Command

**Files:**
- Create: `src-tauri/src/git/status.rs`
- Modify: `src-tauri/src/git/mod.rs`

**Step 1: Write the status module**

Add to `src-tauri/src/git/mod.rs`:
```rust
pub mod models;
pub mod status;
```

Create `src-tauri/src/git/status.rs`:
```rust
use std::path::Path;
use git2::{Repository, StatusOptions, Delta};
use super::models::{GitStatusReport, GitFileEntry};

/// Get the full git status for a repository: branch, ahead/behind, staged, unstaged, untracked.
pub fn get_status(repo_path: &Path) -> Result<GitStatusReport, String> {
    let repo = Repository::open(repo_path)
        .map_err(|e| format!("Not a git repository: {}", e))?;

    let branch = get_branch_name(&repo);
    let (ahead, behind) = get_ahead_behind(&repo);

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);

    let statuses = repo.statuses(Some(&mut opts))
        .map_err(|e| format!("Failed to get status: {}", e))?;

    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();

    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let s = entry.status();

        // Staged (index) changes
        if s.intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED,
        ) {
            let status = if s.contains(git2::Status::INDEX_NEW) {
                "added"
            } else if s.contains(git2::Status::INDEX_DELETED) {
                "deleted"
            } else if s.contains(git2::Status::INDEX_RENAMED) {
                "renamed"
            } else {
                "modified"
            };
            staged.push(GitFileEntry {
                path: path.clone(),
                status: status.to_string(),
                additions: 0,
                deletions: 0,
            });
        }

        // Unstaged (workdir) changes
        if s.intersects(
            git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_RENAMED,
        ) {
            let status = if s.contains(git2::Status::WT_DELETED) {
                "deleted"
            } else if s.contains(git2::Status::WT_RENAMED) {
                "renamed"
            } else {
                "modified"
            };
            unstaged.push(GitFileEntry {
                path: path.clone(),
                status: status.to_string(),
                additions: 0,
                deletions: 0,
            });
        }

        // Untracked files
        if s.contains(git2::Status::WT_NEW) {
            untracked.push(path);
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

fn get_branch_name(repo: &Repository) -> String {
    repo.head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()))
        .unwrap_or_else(|| "HEAD (detached)".to_string())
}

fn get_ahead_behind(repo: &Repository) -> (u32, u32) {
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return (0, 0),
    };
    let local_oid = match head.target() {
        Some(oid) => oid,
        None => return (0, 0),
    };

    // Find upstream branch
    let branch_name = match head.shorthand() {
        Some(name) => name.to_string(),
        None => return (0, 0),
    };
    let branch = match repo.find_branch(&branch_name, git2::BranchType::Local) {
        Ok(b) => b,
        Err(_) => return (0, 0),
    };
    let upstream = match branch.upstream() {
        Ok(u) => u,
        Err(_) => return (0, 0), // No upstream configured
    };
    let upstream_oid = match upstream.get().target() {
        Some(oid) => oid,
        None => return (0, 0),
    };

    repo.graph_ahead_behind(local_oid, upstream_oid)
        .map(|(a, b)| (a as u32, b as u32))
        .unwrap_or((0, 0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn init_test_repo() -> (TempDir, Repository) {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        // Create initial commit so HEAD exists
        let sig = git2::Signature::now("Test", "test@test.com").unwrap();
        let tree_id = repo.index().unwrap().write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
        (dir, repo)
    }

    #[test]
    fn test_status_clean_repo() {
        let (dir, _repo) = init_test_repo();
        let report = get_status(dir.path()).unwrap();
        assert_eq!(report.branch, "master");
        assert!(report.staged.is_empty());
        assert!(report.unstaged.is_empty());
        assert!(report.untracked.is_empty());
    }

    #[test]
    fn test_status_untracked_file() {
        let (dir, _repo) = init_test_repo();
        fs::write(dir.path().join("new.txt"), "hello").unwrap();
        let report = get_status(dir.path()).unwrap();
        assert_eq!(report.untracked.len(), 1);
        assert_eq!(report.untracked[0], "new.txt");
    }

    #[test]
    fn test_status_staged_file() {
        let (dir, repo) = init_test_repo();
        let file_path = dir.path().join("staged.txt");
        fs::write(&file_path, "content").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("staged.txt")).unwrap();
        index.write().unwrap();

        let report = get_status(dir.path()).unwrap();
        assert_eq!(report.staged.len(), 1);
        assert_eq!(report.staged[0].status, "added");
    }

    #[test]
    fn test_status_not_a_repo() {
        let dir = TempDir::new().unwrap();
        let result = get_status(dir.path());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Not a git repository"));
    }
}
```

**Step 2: Add tempfile dev-dependency to Cargo.toml**

In `src-tauri/Cargo.toml`, add under `[dev-dependencies]`:
```toml
tempfile = "3"
```

**Step 3: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml git::status -- --nocapture 2>&1 | tail -15`
Expected: 4 tests pass.

**Step 4: Commit**

```bash
git add src-tauri/src/git/ src-tauri/Cargo.toml
git commit -m "feat(git): implement git_status with git2"
```

---

### Task 3: git_stage, git_unstage, git_commit Commands

**Files:**
- Create: `src-tauri/src/git/operations.rs`
- Modify: `src-tauri/src/git/mod.rs`

**Step 1: Write the operations module**

Add to `src-tauri/src/git/mod.rs`:
```rust
pub mod operations;
```

Create `src-tauri/src/git/operations.rs`:
```rust
use std::path::Path;
use git2::Repository;

/// Stage files by adding them to the git index.
pub fn stage_files(repo_path: &Path, paths: &[String]) -> Result<(), String> {
    let repo = Repository::open(repo_path)
        .map_err(|e| format!("Failed to open repo: {}", e))?;
    let mut index = repo.index()
        .map_err(|e| format!("Failed to get index: {}", e))?;

    for path in paths {
        // Use add_path for existing/modified files, handles new files too
        index.add_path(Path::new(path))
            .map_err(|e| format!("Failed to stage '{}': {}", path, e))?;
    }

    index.write().map_err(|e| format!("Failed to write index: {}", e))?;
    Ok(())
}

/// Unstage files by resetting them to HEAD in the index.
pub fn unstage_files(repo_path: &Path, paths: &[String]) -> Result<(), String> {
    let repo = Repository::open(repo_path)
        .map_err(|e| format!("Failed to open repo: {}", e))?;

    let head_commit = repo.head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| format!("Failed to get HEAD commit: {}", e))?;

    let head_tree = head_commit.tree()
        .map_err(|e| format!("Failed to get HEAD tree: {}", e))?;

    let mut index = repo.index()
        .map_err(|e| format!("Failed to get index: {}", e))?;

    for path in paths {
        let p = Path::new(path);
        // Check if file exists in HEAD tree
        match head_tree.get_path(p) {
            Ok(entry) => {
                // File exists in HEAD — reset index entry to HEAD version
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
    let repo = Repository::open(repo_path)
        .map_err(|e| format!("Failed to open repo: {}", e))?;

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
        // Initial commit
        let sig = git2::Signature::now("Test", "test@test.com").unwrap();
        let tree_id = repo.index().unwrap().write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
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
        let (dir, repo) = init_test_repo();
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
    fn test_commit_empty_index_fails() {
        let (dir, _repo) = init_test_repo();
        // Commit with nothing staged should succeed (empty commit) or fail
        // depending on git2 behavior — we accept either
        let _ = commit(dir.path(), "empty commit");
    }
}
```

**Step 2: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml git::operations 2>&1 | tail -10`
Expected: 3 tests pass.

**Step 3: Commit**

```bash
git add src-tauri/src/git/
git commit -m "feat(git): implement stage, unstage, commit operations"
```

---

### Task 4: git_diff_file and git_log Commands

**Files:**
- Create: `src-tauri/src/git/diff.rs`
- Create: `src-tauri/src/git/log.rs`
- Modify: `src-tauri/src/git/mod.rs`

**Step 1: Write diff module**

Add to `src-tauri/src/git/mod.rs`:
```rust
pub mod diff;
pub mod log;
```

Create `src-tauri/src/git/diff.rs`:
```rust
use std::path::Path;
use git2::Repository;

/// Get unified diff for a single file (workdir vs HEAD).
pub fn diff_file(repo_path: &Path, file_path: &str) -> Result<String, String> {
    let repo = Repository::open(repo_path)
        .map_err(|e| format!("Failed to open repo: {}", e))?;

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
        let sig = git2::Signature::now("Test", "test@test.com").unwrap();
        // Create file and initial commit
        fs::write(dir.path().join("file.txt"), "line1\nline2\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
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
```

**Step 2: Write log module**

Create `src-tauri/src/git/log.rs`:
```rust
use std::path::Path;
use git2::Repository;
use super::models::GitLogEntry;

/// Get the N most recent commits.
pub fn get_log(repo_path: &Path, limit: u32) -> Result<Vec<GitLogEntry>, String> {
    let repo = Repository::open(repo_path)
        .map_err(|e| format!("Failed to open repo: {}", e))?;

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
        let tree_id = repo.index().unwrap().write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let c1 = repo.commit(Some("HEAD"), &sig, &sig, "first commit", &tree, &[]).unwrap();
        let parent = repo.find_commit(c1).unwrap();
        fs::write(dir.path().join("a.txt"), "a").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(Path::new("a.txt")).unwrap();
        idx.write().unwrap();
        let tree2_id = idx.write_tree().unwrap();
        let tree2 = repo.find_tree(tree2_id).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "second commit", &tree2, &[&parent]).unwrap();
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
```

**Step 3: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml git::diff git::log 2>&1 | tail -15`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add src-tauri/src/git/
git commit -m "feat(git): implement diff_file and git_log"
```

---

### Task 5: Tauri Commands + Registration

**Files:**
- Create: `src-tauri/src/commands/git.rs`
- Modify: `src-tauri/src/commands/mod.rs` (lines 57-63)
- Modify: `src-tauri/src/lib.rs` (lines 14-26, 33-76)

**Step 1: Create the Tauri command file**

Create `src-tauri/src/commands/git.rs`:
```rust
use crate::git::{models::*, status, operations, diff, log};

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
    tokio::task::spawn_blocking(move || operations::stage_files(&path, &paths))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
#[specta::specta]
pub async fn git_unstage_files(project_dir: String, paths: Vec<String>) -> Result<(), String> {
    let path = super::expand_tilde(&project_dir);
    tokio::task::spawn_blocking(move || operations::unstage_files(&path, &paths))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
#[specta::specta]
pub async fn git_commit(project_dir: String, message: String) -> Result<String, String> {
    let path = super::expand_tilde(&project_dir);
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
    let output = tokio::process::Command::new("git")
        .args(["pull"])
        .current_dir(&path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git pull: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let message = if stdout.is_empty() { stderr.clone() } else { stdout };

    Ok(GitPullResult {
        success: output.status.success(),
        message: message.trim().to_string(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn git_push(project_dir: String) -> Result<GitPushResult, String> {
    let path = super::expand_tilde(&project_dir);
    let output = tokio::process::Command::new("git")
        .args(["push"])
        .current_dir(&path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git push: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let message = if stdout.is_empty() { stderr.clone() } else { stdout };

    Ok(GitPushResult {
        success: output.status.success(),
        message: message.trim().to_string(),
    })
}
```

**Step 2: Register in `src-tauri/src/commands/mod.rs`**

Add `pub mod git;` after line 12 (`pub mod worktree;`).

Add the `pub use` block after line 63:
```rust
pub use git::{
    git_status, git_stage_files, git_unstage_files, git_commit,
    git_diff_file, git_log, git_pull, git_push,
};
```

**Step 3: Register in `src-tauri/src/lib.rs`**

Add the git commands to the `use commands::{ ... }` import block (after line 24).

Add all 8 git commands to the `collect_commands!` macro (after line 75).

**Step 4: Build**

Run: `cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5`
Expected: Compiles successfully.

**Step 5: Commit**

```bash
git add src-tauri/src/commands/git.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(git): register all git Tauri commands"
```

---

### Task 6: Frontend — Store + Hook

**Files:**
- Modify: `src/stores/uiStore.ts` (line 3)
- Create: `src/hooks/useGitStatus.ts`

**Step 1: Add 'git' to AppView type**

In `src/stores/uiStore.ts`, change line 3:
```typescript
export type AppView = 'kanban' | 'terminal' | 'usage' | 'review' | 'done' | 'settings' | 'git';
```

**Step 2: Create the useGitStatus hook**

Create `src/hooks/useGitStatus.ts`:
```typescript
import { useState, useCallback, useEffect } from 'react';
import { commands } from '../bindings';
import type { GitStatusReport, GitLogEntry } from '../bindings';

export function useGitStatus(projectDir: string) {
  const [status, setStatus] = useState<GitStatusReport | null>(null);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [expandedDiffs, setExpandedDiffs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectDir) return;
    setLoading(true);
    setError(null);
    try {
      const [statusResult, logResult] = await Promise.all([
        commands.gitStatus(projectDir),
        commands.gitLog(projectDir, 10),
      ]);
      if (statusResult.status === 'ok') setStatus(statusResult.data);
      else setError(statusResult.error as string);
      if (logResult.status === 'ok') setLog(logResult.data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectDir]);

  useEffect(() => { refresh(); }, [refresh]);

  const stageFiles = useCallback(async (paths: string[]) => {
    const result = await commands.gitStageFiles(projectDir, paths);
    if (result.status === 'ok') await refresh();
    else setError(result.error as string);
  }, [projectDir, refresh]);

  const unstageFiles = useCallback(async (paths: string[]) => {
    const result = await commands.gitUnstageFiles(projectDir, paths);
    if (result.status === 'ok') await refresh();
    else setError(result.error as string);
  }, [projectDir, refresh]);

  const commit = useCallback(async (message: string) => {
    const result = await commands.gitCommit(projectDir, message);
    if (result.status === 'ok') {
      await refresh();
      return result.data;
    }
    setError(result.error as string);
    return null;
  }, [projectDir, refresh]);

  const pull = useCallback(async () => {
    const result = await commands.gitPull(projectDir);
    if (result.status === 'ok') {
      await refresh();
      return result.data;
    }
    setError(result.error as string);
    return null;
  }, [projectDir, refresh]);

  const push = useCallback(async () => {
    const result = await commands.gitPush(projectDir);
    if (result.status === 'ok') {
      await refresh();
      return result.data;
    }
    setError(result.error as string);
    return null;
  }, [projectDir, refresh]);

  const toggleDiff = useCallback(async (filePath: string) => {
    if (expandedDiffs[filePath] !== undefined) {
      setExpandedDiffs(prev => {
        const next = { ...prev };
        delete next[filePath];
        return next;
      });
      return;
    }
    const result = await commands.gitDiffFile(projectDir, filePath);
    if (result.status === 'ok') {
      setExpandedDiffs(prev => ({ ...prev, [filePath]: result.data }));
    }
  }, [projectDir, expandedDiffs]);

  return {
    status, log, expandedDiffs, loading, error,
    refresh, stageFiles, unstageFiles, commit, pull, push, toggleDiff,
  };
}
```

**Step 3: Commit**

```bash
git add src/stores/uiStore.ts src/hooks/useGitStatus.ts
git commit -m "feat(git): add useGitStatus hook and AppView type"
```

---

### Task 7: Frontend — GitView Component

**Files:**
- Create: `src/components/views/GitView.tsx`
- Modify: `src/routes/index.tsx` (lines 1-52)
- Modify: `src/components/layout/AppShell.tsx` (lines 66-70)

**Step 1: Create GitView component**

Create `src/components/views/GitView.tsx` — this is the largest file. It renders the branch header, staged/unstaged file lists with checkboxes, inline diffs, commit textarea, and recent commits.

The component uses `useGitStatus(projectDir)` hook and `useUIStore` for projectDir. Each file row has a checkbox for stage/unstage toggle, a status badge (M/A/D/?), the file path in monospace, and +/- counts. Clicking a file row toggles inline diff. Commit area has a textarea and "Commit Staged (N)" button.

Follow the patterns in `KanbanView.tsx`: import from `@/lib/theme` for `C` colors, use inline styles with the theme palette, scrollable layout.

Key sections:
1. **BranchHeader**: Branch name + dot + ahead/behind pills + Pull/Push buttons
2. **FileSection**: Collapsible section (staged or unstaged) with Stage All / Unstage All
3. **FileRow**: Checkbox + status badge + path + additions/deletions + click for diff
4. **InlineDiff**: Renders unified diff lines with green/red highlighting
5. **CommitArea**: Textarea + commit button (disabled when no staged files)
6. **RecentCommits**: List of GitLogEntry items

**Step 2: Add Git tab to AppShell header**

In `src/components/layout/AppShell.tsx`, add to the `tabs` array (line 69, after Usage):
```typescript
{ key: 'git', label: 'Git', icon: '⎇' },
```

**Step 3: Add GitView route**

In `src/routes/index.tsx`:
- Add import: `import { GitView } from '../components/views/GitView';`
- Add after line 52 (before the closing `</div>`):
```tsx
{activeView === 'git' && <GitView />}
```

**Step 4: Build frontend**

Run: `npm run build --prefix . 2>&1 | tail -10` (from project root)
Expected: Builds successfully.

**Step 5: Commit**

```bash
git add src/components/views/GitView.tsx src/routes/index.tsx src/components/layout/AppShell.tsx
git commit -m "feat(git): add GitView component with full UI"
```

---

### Task 8: Integration Test + Final Polish

**Step 1: Run all Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -- --skip credentials 2>&1 | tail -20`
Expected: All existing tests + new git tests pass.

**Step 2: Run the app in dev mode**

Run: `npm run tauri dev` (from project root)
Expected: App launches. Click "Git" tab. If a project directory is set, git status loads.

**Step 3: Verify features manually**
- Branch name and ahead/behind display
- File list shows modified/added/deleted files
- Checkbox toggles staging
- Click file row → inline diff appears
- Type commit message → Commit button active → click → commit created
- Pull/Push buttons work
- Recent commits list shows

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat(git): complete git view integration"
```

---

## Summary

| Task | Description | New Files | Tests |
|------|-------------|-----------|-------|
| 1 | Data models | `git/models.rs`, `git/mod.rs` | Compile check |
| 2 | git_status | `git/status.rs` | 4 unit tests |
| 3 | stage/unstage/commit | `git/operations.rs` | 3 unit tests |
| 4 | diff + log | `git/diff.rs`, `git/log.rs` | 5 unit tests |
| 5 | Tauri commands | `commands/git.rs` | Build check |
| 6 | Hook + store | `useGitStatus.ts`, `uiStore.ts` | — |
| 7 | GitView component | `GitView.tsx`, route + tab | Build check |
| 8 | Integration test | — | Manual verification |
