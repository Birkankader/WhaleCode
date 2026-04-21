//! Builds the [`PlanningContext`] handed to the master agent.
//!
//! Three ingredients:
//!   1. **Directory tree** — a two-level listing of the repo root.
//!      We skip the usual heavyweights (`node_modules`, `target`,
//!      build outputs, `.git`) and WhaleCode's own scratch dirs
//!      (`.whalecode`, `.whalecode-worktrees`) so the master's view
//!      isn't polluted by its own previous runs.
//!   2. **AGENTS.md / CLAUDE.md / GEMINI.md** — per-project instructions
//!      the user wants the agent to honor. Missing files are `None`
//!      (not an empty string) so the prompt templates can decide
//!      whether to render a heading at all.
//!   3. **Recent commits** — last 20 on the current branch, newest
//!      first. Gives the master something to ground its plan against
//!      (what has been done lately, what's in flight, the prose style
//!      of commit messages).
//!
//! This module runs before any work begins, so it's I/O-heavy but
//! never long-running — a 2s budget is ample for any repo we'd
//! realistically run this against. Failures are degrading, not
//! fatal: an unreadable AGENTS.md becomes `None`, a broken
//! `git log` yields an empty commits list. The master can plan
//! without any of this — it just plans worse.

use std::path::Path;

use tokio::process::Command;

use crate::agents::{CommitInfo, PlanningContext};
use crate::ipc::AgentKind;

/// Depth cap for [`scan_directory_tree`]. Two levels is enough to see
/// the shape of a repo (top-level + immediate children) without
/// drowning the prompt in noise.
const MAX_TREE_DEPTH: usize = 2;

/// How many commits to pull back for the master's grounding.
const RECENT_COMMITS_LIMIT: usize = 20;

/// Dirs we skip while walking the tree. Extend cautiously — anything
/// here is invisible to the master and therefore to its plans.
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".whalecode",
    ".whalecode-worktrees",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "__pycache__",
    ".idea",
    ".vscode",
];

/// Top-level entry point: assembles every ingredient into a single
/// [`PlanningContext`]. `available_workers` is plumbed through from
/// agent detection — the master must only assign subtasks to workers
/// the orchestrator is willing to spawn.
pub async fn build_planning_context(
    repo_root: &Path,
    available_workers: Vec<AgentKind>,
) -> PlanningContext {
    let (directory_tree, claude_md, agents_md, gemini_md, recent_commits) = tokio::join!(
        scan_directory_tree(repo_root),
        read_instruction_file(repo_root, "CLAUDE.md"),
        read_instruction_file(repo_root, "AGENTS.md"),
        read_instruction_file(repo_root, "GEMINI.md"),
        recent_commits(repo_root),
    );

    PlanningContext {
        repo_root: repo_root.to_path_buf(),
        directory_tree,
        claude_md,
        agents_md,
        gemini_md,
        recent_commits,
        available_workers,
    }
}

/// Newline-separated listing of the repo, capped at [`MAX_TREE_DEPTH`]
/// levels. Directories get a trailing `/` so the master can
/// distinguish them from files at a glance.
async fn scan_directory_tree(root: &Path) -> String {
    let mut lines = Vec::new();
    walk_dir(root, root, 0, &mut lines).await;
    lines.sort();
    lines.join("\n")
}

/// Recursive walker. Boxed because async recursion needs a heap-
/// allocated future — the compiler refuses an `async fn` that calls
/// itself directly.
fn walk_dir<'a>(
    root: &'a Path,
    current: &'a Path,
    depth: usize,
    out: &'a mut Vec<String>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
    Box::pin(async move {
        if depth >= MAX_TREE_DEPTH {
            return;
        }
        let Ok(mut entries) = tokio::fs::read_dir(current).await else {
            return;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if SKIP_DIRS.iter().any(|d| *d == name_str) {
                continue;
            }
            let path = entry.path();
            let rel = match path.strip_prefix(root) {
                Ok(r) => r.to_path_buf(),
                Err(_) => continue,
            };
            let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
            let line = if is_dir {
                format!("{}/", rel.display())
            } else {
                rel.display().to_string()
            };
            out.push(line);
            if is_dir {
                walk_dir(root, &path, depth + 1, out).await;
            }
        }
    })
}

/// Read `repo_root/<name>` as UTF-8. Missing/unreadable → `None`;
/// non-UTF-8 content → `None` (we'd rather drop a malformed file than
/// feed the master mojibake).
async fn read_instruction_file(root: &Path, name: &str) -> Option<String> {
    match tokio::fs::read(root.join(name)).await {
        Ok(bytes) => String::from_utf8(bytes).ok(),
        Err(_) => None,
    }
}

/// Ask git for the last [`RECENT_COMMITS_LIMIT`] commits. Any git
/// failure (not a repo, no commits yet, weird git environment)
/// returns an empty vec — the master doesn't require this data to
/// plan.
async fn recent_commits(root: &Path) -> Vec<CommitInfo> {
    // `%H|%s|%an|%aI` packs sha, subject, author, author-date-iso8601
    // into one line each. `|` is fine as a separator because subjects
    // with literal `|` are rare enough that we accept a truncated
    // subject in that case (splitn(4)).
    let output = Command::new("git")
        .arg("log")
        .arg(format!("-n{}", RECENT_COMMITS_LIMIT))
        .arg("--format=%H|%s|%an|%aI")
        .current_dir(root)
        .output()
        .await;

    let Ok(out) = output else {
        return vec![];
    };
    if !out.status.success() {
        return vec![];
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    stdout
        .lines()
        .filter_map(parse_commit_line)
        .collect()
}

fn parse_commit_line(line: &str) -> Option<CommitInfo> {
    let mut parts = line.splitn(4, '|');
    let sha = parts.next()?.to_string();
    let subject = parts.next()?.to_string();
    let author = parts.next()?.to_string();
    let when = parts.next()?.to_string();
    Some(CommitInfo {
        sha,
        subject,
        author,
        when,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use tokio::fs;

    async fn init_git_repo(path: &Path) {
        Command::new("git")
            .args(["init", "--initial-branch=main"])
            .current_dir(path)
            .output()
            .await
            .unwrap();
        Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(path)
            .output()
            .await
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(path)
            .output()
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn tree_skips_well_known_heavyweights() {
        let td = tempdir().unwrap();
        let root = td.path();
        fs::create_dir_all(root.join("src")).await.unwrap();
        fs::create_dir_all(root.join("node_modules/lodash"))
            .await
            .unwrap();
        fs::create_dir_all(root.join(".whalecode-worktrees/r1"))
            .await
            .unwrap();
        fs::write(root.join("src/main.rs"), "fn main(){}")
            .await
            .unwrap();

        let tree = scan_directory_tree(root).await;
        assert!(tree.contains("src/"));
        assert!(tree.contains("src/main.rs"));
        assert!(!tree.contains("node_modules"));
        assert!(!tree.contains(".whalecode-worktrees"));
    }

    #[tokio::test]
    async fn tree_respects_depth_cap() {
        let td = tempdir().unwrap();
        let root = td.path();
        fs::create_dir_all(root.join("a/b/c")).await.unwrap();
        fs::write(root.join("a/b/c/deep.txt"), "").await.unwrap();

        let tree = scan_directory_tree(root).await;
        // depth 0: "a/", depth 1: "a/b/". "a/b/c/" is depth 2 which
        // is past MAX_TREE_DEPTH=2 (strictly less than).
        assert!(tree.contains("a/"));
        assert!(tree.contains("a/b/"));
        assert!(!tree.contains("deep.txt"));
    }

    #[tokio::test]
    async fn instruction_files_missing_is_none() {
        let td = tempdir().unwrap();
        let got = read_instruction_file(td.path(), "CLAUDE.md").await;
        assert!(got.is_none());
    }

    #[tokio::test]
    async fn instruction_files_present_roundtrip() {
        let td = tempdir().unwrap();
        fs::write(td.path().join("AGENTS.md"), "# Rules\nbe good")
            .await
            .unwrap();
        let got = read_instruction_file(td.path(), "AGENTS.md").await;
        assert_eq!(got.as_deref(), Some("# Rules\nbe good"));
    }

    #[tokio::test]
    async fn recent_commits_empty_for_non_repo() {
        let td = tempdir().unwrap();
        assert!(recent_commits(td.path()).await.is_empty());
    }

    #[tokio::test]
    async fn recent_commits_returns_shas_for_real_repo() {
        let td = tempdir().unwrap();
        init_git_repo(td.path()).await;
        fs::write(td.path().join("a.txt"), "hi").await.unwrap();
        Command::new("git")
            .args(["add", "."])
            .current_dir(td.path())
            .output()
            .await
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "first"])
            .current_dir(td.path())
            .output()
            .await
            .unwrap();

        let commits = recent_commits(td.path()).await;
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].subject, "first");
        assert_eq!(commits[0].author, "Test");
        assert_eq!(commits[0].sha.len(), 40);
    }

    #[tokio::test]
    async fn build_context_composes_all_pieces() {
        let td = tempdir().unwrap();
        init_git_repo(td.path()).await;
        fs::write(td.path().join("CLAUDE.md"), "rule").await.unwrap();
        fs::create_dir_all(td.path().join("src")).await.unwrap();
        fs::write(td.path().join("src/m.rs"), "").await.unwrap();
        Command::new("git")
            .args(["add", "."])
            .current_dir(td.path())
            .output()
            .await
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "seed"])
            .current_dir(td.path())
            .output()
            .await
            .unwrap();

        let ctx = build_planning_context(
            td.path(),
            vec![AgentKind::Claude, AgentKind::Gemini],
        )
        .await;
        assert_eq!(ctx.repo_root, td.path());
        assert!(ctx.directory_tree.contains("src/"));
        assert_eq!(ctx.claude_md.as_deref(), Some("rule"));
        assert!(ctx.agents_md.is_none());
        assert_eq!(ctx.recent_commits.len(), 1);
        assert_eq!(ctx.available_workers, vec![AgentKind::Claude, AgentKind::Gemini]);
    }
}
