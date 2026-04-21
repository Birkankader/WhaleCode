//! Integration tests for the worktree manager.
//!
//! These tests spin up a real temporary git repo per case, not a
//! mock. Worktrees exercise enough of git's internals (branches,
//! HEAD, refs, merge machinery) that mocking the CLI would miss the
//! actual failure modes we care about. Each test uses its own
//! `TempDir`, so parallel execution is safe.
//!
//! Any test that touches `git` requires a `git` binary on PATH.

use std::path::{Path, PathBuf};

use tempfile::TempDir;
use tokio::sync::mpsc;

use super::git::run_git;
use super::{DependencyGraph, DiffStatus, WorktreeError, WorktreeManager};

/// Create a fresh repo in a tempdir, configured with a user identity
/// and one initial commit on `main`. Returns the `TempDir` (keep it
/// alive for the duration of the test) and the resolved repo path.
async fn init_repo() -> (TempDir, PathBuf) {
    let td = tempfile::tempdir().unwrap();
    // Canonicalize so macOS's `/var` → `/private/var` doesn't bite us
    // when comparing paths from `git worktree list` later.
    let path = td
        .path()
        .canonicalize()
        .unwrap_or_else(|_| td.path().to_path_buf());

    run_git(&path, &["init", "--initial-branch=main", "-q"])
        .await
        .unwrap();
    // Scope identity to the repo — no mutations to the user's global
    // git config.
    run_git(&path, &["config", "user.email", "test@example.com"])
        .await
        .unwrap();
    run_git(&path, &["config", "user.name", "Test User"])
        .await
        .unwrap();
    // An initial commit so HEAD resolves and branches can branch.
    tokio::fs::write(path.join("README.md"), "# test repo\n")
        .await
        .unwrap();
    run_git(&path, &["add", "README.md"]).await.unwrap();
    run_git(&path, &["commit", "-q", "-m", "init"]).await.unwrap();

    (td, path)
}

async fn write(path: &Path, body: &str) {
    if let Some(p) = path.parent() {
        tokio::fs::create_dir_all(p).await.unwrap();
    }
    tokio::fs::write(path, body).await.unwrap();
}

async fn commit_in(worktree: &Path, files: &[(&str, &str)], msg: &str) {
    for (name, body) in files {
        write(&worktree.join(name), body).await;
    }
    run_git(worktree, &["add", "-A"]).await.unwrap();
    run_git(worktree, &["commit", "-q", "-m", msg]).await.unwrap();
}

// -- Construction ----------------------------------------------------

#[tokio::test]
async fn new_captures_base_branch() {
    let (_td, repo) = init_repo().await;
    let mgr = WorktreeManager::new(repo.clone()).await.unwrap();
    assert_eq!(mgr.base_branch(), "main");
    assert_eq!(mgr.worktrees_dir(), repo.join(".whalecode-worktrees"));
}

#[tokio::test]
async fn new_rejects_detached_head() {
    let (_td, repo) = init_repo().await;
    // Detach: check out HEAD's SHA directly.
    let head = run_git(&repo, &["rev-parse", "HEAD"]).await.unwrap();
    run_git(&repo, &["checkout", "-q", head.trim()]).await.unwrap();
    match WorktreeManager::new(repo.clone()).await {
        Err(WorktreeError::NotARepo { .. }) => {}
        other => panic!("expected NotARepo, got {other:?}"),
    }
}

// -- create ----------------------------------------------------------

#[tokio::test]
async fn create_produces_usable_worktree_on_branch() {
    let (_td, repo) = init_repo().await;
    let mgr = WorktreeManager::new(repo.clone()).await.unwrap();

    let path = mgr.create("run1", "sub1").await.unwrap();
    assert!(tokio::fs::metadata(&path).await.is_ok());
    assert_eq!(
        path,
        repo.join(".whalecode-worktrees/run1/sub1")
            .canonicalize()
            .unwrap_or(path.clone())
    );

    // It's on the right branch.
    let branch = run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .unwrap();
    assert_eq!(branch.trim(), "whalecode/run1/sub1");

    // And HEAD matches base_branch's SHA.
    let main_sha = run_git(&repo, &["rev-parse", "main"]).await.unwrap();
    let wt_sha = run_git(&path, &["rev-parse", "HEAD"]).await.unwrap();
    assert_eq!(main_sha.trim(), wt_sha.trim());
}

#[tokio::test]
async fn create_twice_same_ids_errors_with_branch_exists() {
    let (_td, repo) = init_repo().await;
    let mgr = WorktreeManager::new(repo).await.unwrap();
    mgr.create("run1", "sub1").await.unwrap();
    match mgr.create("run1", "sub1").await {
        Err(WorktreeError::BranchAlreadyExists { branch }) => {
            assert_eq!(branch, "whalecode/run1/sub1");
        }
        other => panic!("expected BranchAlreadyExists, got {other:?}"),
    }
}

#[tokio::test]
async fn create_on_dirty_repo_logs_warning_and_proceeds() {
    let (_td, repo) = init_repo().await;
    // Introduce a WIP change on the base branch.
    write(&repo.join("WIP.txt"), "uncommitted\n").await;

    let (tx, mut rx) = mpsc::channel::<String>(8);
    let mgr = WorktreeManager::new(repo).await.unwrap().with_logger(tx);
    mgr.create("run1", "sub1").await.unwrap();

    // We should have been told about the WIP.
    let mut got_warning = false;
    while let Ok(line) = rx.try_recv() {
        if line.to_lowercase().contains("uncommitted") {
            got_warning = true;
        }
    }
    assert!(got_warning, "expected dirty-tree warning line");
}

// -- list ------------------------------------------------------------

#[tokio::test]
async fn list_returns_only_managed_worktrees() {
    let (_td, repo) = init_repo().await;
    let mgr = WorktreeManager::new(repo).await.unwrap();
    mgr.create("r", "a").await.unwrap();
    mgr.create("r", "b").await.unwrap();

    let list = mgr.list().await.unwrap();
    let mut ids: Vec<String> = list.iter().map(|w| w.subtask_id.clone()).collect();
    ids.sort();
    assert_eq!(ids, vec!["a", "b"]);
    assert!(list.iter().all(|w| w.run_id == "r"));
    assert!(list
        .iter()
        .all(|w| w.branch.starts_with("whalecode/r/")));
}

// -- diff ------------------------------------------------------------

#[tokio::test]
async fn diff_after_commit_reports_statuses_and_counts() {
    let (_td, repo) = init_repo().await;
    let mgr = WorktreeManager::new(repo.clone()).await.unwrap();
    let wt = mgr.create("r", "s").await.unwrap();

    // Modify README, add a new file, delete by not-touching... well,
    // we can add + modify here; delete needs an existing file.
    commit_in(
        &wt,
        &[
            ("README.md", "# test repo\nline two\nline three\n"),
            ("new.rs", "pub fn hello() {}\n"),
        ],
        "feat: README + new.rs",
    )
    .await;

    let diffs = mgr.diff("s").await.unwrap();
    let readme = diffs
        .iter()
        .find(|d| d.path == Path::new("README.md"))
        .expect("README diff present");
    assert!(matches!(readme.status, DiffStatus::Modified));
    assert!(readme.additions >= 2);
    assert!(readme.patch.contains("line two"));

    let newfile = diffs
        .iter()
        .find(|d| d.path == Path::new("new.rs"))
        .expect("new.rs diff present");
    assert!(matches!(newfile.status, DiffStatus::Added));
    assert_eq!(newfile.additions, 1);
    assert!(newfile.patch.contains("pub fn hello"));
}

#[tokio::test]
async fn diff_flags_binary_file() {
    let (_td, repo) = init_repo().await;
    let mgr = WorktreeManager::new(repo).await.unwrap();
    let wt = mgr.create("r", "s").await.unwrap();

    // Fake binary: embed a NUL byte so git classifies as binary.
    let blob: Vec<u8> = (0u8..=255).collect();
    tokio::fs::write(wt.join("blob.bin"), &blob).await.unwrap();
    run_git(&wt, &["add", "blob.bin"]).await.unwrap();
    run_git(&wt, &["commit", "-q", "-m", "add binary"])
        .await
        .unwrap();

    let diffs = mgr.diff("s").await.unwrap();
    let bin = diffs
        .iter()
        .find(|d| d.path == Path::new("blob.bin"))
        .expect("blob.bin in diff");
    assert!(matches!(bin.status, DiffStatus::Binary));
    assert!(bin.patch.is_empty());
}

// -- merge_all -------------------------------------------------------

#[tokio::test]
async fn merge_all_independent_subtasks_merges_both() {
    let (_td, repo) = init_repo().await;
    let mgr = WorktreeManager::new(repo.clone()).await.unwrap();
    let wt_a = mgr.create("r", "a").await.unwrap();
    let wt_b = mgr.create("r", "b").await.unwrap();

    commit_in(&wt_a, &[("a.txt", "from a\n")], "a change").await;
    commit_in(&wt_b, &[("b.txt", "from b\n")], "b change").await;

    let res = mgr
        .merge_all(
            &["a".into(), "b".into()],
            &DependencyGraph::default(),
        )
        .await
        .unwrap();
    assert_eq!(res.commits_created, 2);

    // Both branches' files are present on main.
    let a_exists = tokio::fs::metadata(repo.join("a.txt")).await.is_ok();
    let b_exists = tokio::fs::metadata(repo.join("b.txt")).await.is_ok();
    assert!(a_exists && b_exists);
}

#[tokio::test]
async fn merge_all_respects_dependency_order() {
    let (_td, repo) = init_repo().await;
    let mgr = WorktreeManager::new(repo.clone()).await.unwrap();
    let wt_a = mgr.create("r", "a").await.unwrap();
    let wt_b = mgr.create("r", "b").await.unwrap();

    commit_in(&wt_a, &[("shared.txt", "from a\n")], "a").await;
    commit_in(&wt_b, &[("b.txt", "from b\n")], "b").await;

    let mut deps = DependencyGraph::default();
    deps.insert("b", vec!["a".into()]);

    mgr.merge_all(&["a".into(), "b".into()], &deps)
        .await
        .unwrap();

    // If order was respected, both files are now on main.
    let log = run_git(&repo, &["log", "--oneline", "--all"])
        .await
        .unwrap();
    assert!(log.contains("merge a"));
    assert!(log.contains("merge b"));
}

#[tokio::test]
async fn merge_all_cycle_rejected() {
    let (_td, repo) = init_repo().await;
    let mgr = WorktreeManager::new(repo).await.unwrap();
    let mut deps = DependencyGraph::default();
    deps.insert("a", vec!["b".into()]);
    deps.insert("b", vec!["a".into()]);
    match mgr.merge_all(&["a".into(), "b".into()], &deps).await {
        Err(WorktreeError::DependencyCycle) => {}
        other => panic!("expected DependencyCycle, got {other:?}"),
    }
}

#[tokio::test]
async fn merge_all_refuses_when_base_branch_has_tracked_wip() {
    // Step 6 lets workers spin up on a dirty repo — that's safe because
    // they live in isolated worktrees. Merging back hits the base
    // working tree, and `git merge` bails on dirty tracked files. The
    // manager has to detect this *before* touching the merge so the
    // user can cleanly commit/stash and retry without ending up in a
    // half-merged state.
    let (_td, repo) = init_repo().await;
    let mgr = WorktreeManager::new(repo.clone()).await.unwrap();

    // A normal worker worktree with a completed commit.
    let wt = mgr.create("r", "s1").await.unwrap();
    commit_in(&wt, &[("feature.txt", "hello\n")], "s1 work").await;

    // Dirty the base working tree on a tracked file. Untracked files
    // alone don't trigger the pre-flight (they don't block merges in
    // the common case), so we modify README.md which init_repo
    // committed above.
    write(&repo.join("README.md"), "# test repo\n\nWIP\n").await;

    let err = mgr
        .merge_all(&["s1".into()], &DependencyGraph::default())
        .await
        .unwrap_err();

    match err {
        WorktreeError::BaseBranchDirty { files } => {
            assert!(
                files.iter().any(|p| p == &PathBuf::from("README.md")),
                "expected README.md in dirty list, got {files:?}",
            );
        }
        other => panic!("expected BaseBranchDirty, got {other:?}"),
    }

    // Worktrees and the worker branch must still be intact so a retry
    // (after the user stashes/commits) picks up where we left off.
    let worktrees = mgr.list().await.unwrap();
    assert!(
        worktrees.iter().any(|w| w.subtask_id == "s1"),
        "worker worktree was cleaned up prematurely: {worktrees:?}",
    );
    // README still has the user's WIP — we refused before overwriting.
    let readme = tokio::fs::read_to_string(repo.join("README.md")).await.unwrap();
    assert!(readme.contains("WIP"), "user WIP was clobbered: {readme:?}");
}

#[tokio::test]
async fn merge_all_allows_base_branch_with_only_untracked_files() {
    // Untracked files don't block `git merge` in the usual case (they
    // only collide when the incoming merge creates a file with the
    // same name, which is rare). Don't false-positive on benign WIP
    // like editor backup files or newly scaffolded scripts.
    let (_td, repo) = init_repo().await;
    let mgr = WorktreeManager::new(repo.clone()).await.unwrap();
    let wt = mgr.create("r", "s1").await.unwrap();
    commit_in(&wt, &[("feature.txt", "hello\n")], "s1 work").await;

    // Untracked file on base; should NOT trigger the pre-flight.
    write(&repo.join("scratch.txt"), "untracked\n").await;

    let res = mgr
        .merge_all(&["s1".into()], &DependencyGraph::default())
        .await;
    assert!(res.is_ok(), "untracked-only base tripped pre-flight: {res:?}");
}

#[tokio::test]
async fn merge_all_conflict_returns_files_and_aborts_merge() {
    let (_td, repo) = init_repo().await;
    let mgr = WorktreeManager::new(repo.clone()).await.unwrap();
    let wt_a = mgr.create("r", "a").await.unwrap();
    let wt_b = mgr.create("r", "b").await.unwrap();

    // Both edit the same line of the same file.
    commit_in(&wt_a, &[("clash.txt", "alpha\n")], "a's version").await;
    commit_in(&wt_b, &[("clash.txt", "beta\n")], "b's version").await;

    let err = mgr
        .merge_all(
            &["a".into(), "b".into()],
            &DependencyGraph::default(),
        )
        .await
        .unwrap_err();

    match err {
        WorktreeError::MergeConflict { files } => {
            assert!(files
                .iter()
                .any(|p| p == &PathBuf::from("clash.txt")));
        }
        other => panic!("expected MergeConflict, got {other:?}"),
    }

    // Abort should leave no merge-conflict markers behind. (The
    // `.whalecode-worktrees/` dir itself shows up as untracked until
    // the caller gitignores it — that's fine, it's not conflict
    // state. We're checking that there are no `UU`/`AA`/`DD` lines.)
    let status = run_git(&repo, &["status", "--porcelain"]).await.unwrap();
    let conflict_lines: Vec<_> = status
        .lines()
        .filter(|l| {
            matches!(
                &l[..l.len().min(2)],
                "UU" | "AA" | "DD" | "AU" | "UA" | "UD" | "DU"
            )
        })
        .collect();
    assert!(
        conflict_lines.is_empty(),
        "post-abort status should have no conflict markers, saw: {conflict_lines:?}"
    );

    // Worktrees should still be on disk for inspection.
    assert!(tokio::fs::metadata(wt_a).await.is_ok());
    assert!(tokio::fs::metadata(wt_b).await.is_ok());
}

// -- cleanup ---------------------------------------------------------

#[tokio::test]
async fn cleanup_removes_worktree_and_branch_and_is_idempotent() {
    let (_td, repo) = init_repo().await;
    let mgr = WorktreeManager::new(repo.clone()).await.unwrap();
    let path = mgr.create("r", "s").await.unwrap();

    mgr.cleanup("s").await.unwrap();
    assert!(tokio::fs::metadata(&path).await.is_err());
    let branches = run_git(&repo, &["branch", "--list", "whalecode/*"])
        .await
        .unwrap();
    assert!(branches.trim().is_empty());

    // Second call: no error, no side effects.
    mgr.cleanup("s").await.unwrap();
}

#[tokio::test]
async fn cleanup_all_removes_everything_including_worktrees_dir() {
    let (_td, repo) = init_repo().await;
    let mgr = WorktreeManager::new(repo.clone()).await.unwrap();
    mgr.create("r", "a").await.unwrap();
    mgr.create("r", "b").await.unwrap();

    mgr.cleanup_all().await.unwrap();
    let wt_dir = repo.join(".whalecode-worktrees");
    assert!(tokio::fs::metadata(&wt_dir).await.is_err());
    let branches = run_git(&repo, &["branch", "--list", "whalecode/*"])
        .await
        .unwrap();
    assert!(branches.trim().is_empty());
}

#[tokio::test]
async fn cleanup_orphans_on_startup_handles_missing_dir() {
    let (_td, repo) = init_repo().await;
    let mgr = WorktreeManager::new(repo).await.unwrap();
    // Fresh repo: no worktrees dir exists yet.
    let count = mgr.cleanup_orphans_on_startup().await.unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn cleanup_orphans_on_startup_sweeps_known_worktrees() {
    let (_td, repo) = init_repo().await;
    // Create a manager, make some worktrees, drop the manager — a
    // fresh one on next "startup" should sweep them all.
    {
        let mgr = WorktreeManager::new(repo.clone()).await.unwrap();
        mgr.create("r", "a").await.unwrap();
        mgr.create("r", "b").await.unwrap();
    }
    let mgr2 = WorktreeManager::new(repo.clone()).await.unwrap();
    let count = mgr2.cleanup_orphans_on_startup().await.unwrap();
    assert!(count >= 2, "expected ≥2 cleaned, got {count}");
    let wt_dir = repo.join(".whalecode-worktrees");
    assert!(tokio::fs::metadata(&wt_dir).await.is_err());
}

#[tokio::test]
async fn cleanup_orphans_on_startup_sweeps_disk_only_leftovers() {
    // Simulates a crash mid-create: a directory exists under
    // .whalecode-worktrees/ but git has no admin entry for it.
    let (_td, repo) = init_repo().await;
    let stray = repo
        .join(".whalecode-worktrees")
        .join("crashed-run")
        .join("sub");
    tokio::fs::create_dir_all(&stray).await.unwrap();
    tokio::fs::write(stray.join("leftover.txt"), "junk").await.unwrap();

    let mgr = WorktreeManager::new(repo.clone()).await.unwrap();
    let count = mgr.cleanup_orphans_on_startup().await.unwrap();
    assert!(count >= 1);
    assert!(tokio::fs::metadata(&stray).await.is_err());
}

#[tokio::test]
async fn merge_then_cleanup_all_leaves_repo_in_clean_state() {
    // End-to-end happy path: create, execute (simulated), merge,
    // cleanup. The repo should look identical to a user-run merge
    // commit — no stray branches, no leftover worktrees.
    let (_td, repo) = init_repo().await;
    let mgr = WorktreeManager::new(repo.clone()).await.unwrap();
    let wt = mgr.create("r", "s").await.unwrap();
    commit_in(&wt, &[("feature.rs", "// done\n")], "feat").await;

    mgr.merge_all(
        &["s".into()],
        &DependencyGraph::default(),
    )
    .await
    .unwrap();
    mgr.cleanup_all().await.unwrap();

    assert!(tokio::fs::metadata(repo.join("feature.rs")).await.is_ok());
    let branches = run_git(&repo, &["branch", "--list", "whalecode/*"])
        .await
        .unwrap();
    assert!(branches.trim().is_empty());
    assert!(tokio::fs::metadata(repo.join(".whalecode-worktrees"))
        .await
        .is_err());
}
