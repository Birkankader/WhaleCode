//! Git worktree lifecycle.
//!
//! Every subtask in a WhaleCode run gets its own git worktree under
//! `{repo_root}/.whalecode-worktrees/{run_id}/{subtask_id}`, branched
//! off whatever branch the user was on when the run started. Workers
//! operate inside that worktree — their blast radius is contained, and
//! the main checkout stays untouched during parallel execution.
//!
//! # Design goals
//!
//! - **Cleanup is guaranteed.** Every exit path the orchestrator takes
//!   ends with `cleanup_all`: normal Apply, user Discard, cancel, even
//!   a crash (picked up by `cleanup_orphans_on_startup` on next boot).
//!   Worktree leaks are the silent failure mode of Phase 2 — if this
//!   module isn't tested adversarially, disks fill up months later
//!   and we hear "WhaleCode is broken" with no smoking gun.
//!
//! - **Never touch the user's WIP.** If the repo has uncommitted
//!   changes on the base branch, we log a warning and continue. The
//!   worktree branches off HEAD, so the WIP simply isn't visible to
//!   workers. Blocking the run on dirty state would be user-hostile.
//!
//! - **Merge is separate from cleanup.** `merge_all` succeeds → the
//!   orchestrator decides what's next (show diff, get Apply/Discard).
//!   Cleanup only happens on the orchestrator's explicit call. If
//!   apply fails, worktrees stay for inspection.
//!
//! # Layout
//!
//! ```text
//! {repo_root}/
//!   .whalecode-worktrees/
//!     {run_id}/
//!       {subtask_id}/     ← one worktree per subtask
//!         ...
//! ```
//!
//! Branches are named `whalecode/{run_id}/{subtask_id}` so they're
//! clearly distinguishable from the user's branches and trivially
//! pattern-matchable for orphan cleanup.

#![allow(dead_code)] // Orchestrator (step 8) consumes the rest.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::mpsc;

pub mod git;

use git::{
    branch_exists, current_branch, detect_git_version, is_dirty, parse_conflicted_files,
    parse_dirty_files, run_git, try_run_git, MIN_GIT_VERSION,
};

#[cfg(test)]
mod tests;

/// Directory under `repo_root` where all WhaleCode worktrees live. Not
/// configurable on purpose — consistency across repos helps users
/// (and us) recognize WhaleCode state at a glance.
pub const WORKTREES_DIRNAME: &str = ".whalecode-worktrees";

/// Prefix for WhaleCode-managed branches. The full name is
/// `{BRANCH_PREFIX}/{run_id}/{subtask_id}`.
pub const BRANCH_PREFIX: &str = "whalecode";

/// If a subtask changes more than this many files, `diff()` returns
/// the first N and drops the rest. Phase 4's diff UI will paginate;
/// for Phase 2 we just want the Vec to stay a sane size on screen
/// and in memory.
pub const MAX_DIFFS_PER_SUBTASK: usize = 50;

// -- Public types ----------------------------------------------------

/// Manager for all worktrees under one repo. One instance per app
/// session — constructed at startup, shared by the orchestrator.
#[derive(Debug)]
pub struct WorktreeManager {
    repo_root: PathBuf,
    base_branch: String,
    worktrees_dir: PathBuf,
    /// Optional sink for advisory log lines (dirty-tree warning,
    /// orphan cleanup summaries). When `None`, warnings are silent —
    /// which is fine in tests that don't care.
    log_tx: Option<mpsc::Sender<String>>,
}

/// What `list()` returns for each managed worktree. The fields are
/// derived from the directory layout plus `git worktree list` output.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorktreeInfo {
    pub run_id: String,
    pub subtask_id: String,
    pub path: PathBuf,
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileDiff {
    pub path: PathBuf,
    pub status: DiffStatus,
    /// Unified diff output. Empty for binary files.
    pub patch: String,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DiffStatus {
    Added,
    Modified,
    Deleted,
    Renamed { from: PathBuf },
    Binary,
}

/// Dependency graph passed to `merge_all`. Keys are subtask IDs;
/// values are the IDs that must be merged *before* the key. An empty
/// value means "no dependencies, merge any time".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DependencyGraph {
    pub edges: HashMap<String, Vec<String>>,
}

impl DependencyGraph {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, subtask_id: impl Into<String>, deps: Vec<String>) {
        self.edges.insert(subtask_id.into(), deps);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MergeResult {
    pub commits_created: usize,
    pub files_changed: Vec<PathBuf>,
    /// Head SHA of `base_branch` after all worker branches were
    /// merged. Phase 4 Step 2 uses this in the `ApplySummary` overlay
    /// so the user sees the commit their run produced. Always the
    /// full 40-char hex SHA — the UI truncates to 7 for display.
    pub commit_sha: String,
}

// -- Error taxonomy --------------------------------------------------
//
// Kept distinct on purpose: Phase 4's conflict UI branches on
// `MergeConflict`, and Phase 3's retry ladder (not yet built) may
// distinguish `GitCommandFailed` from `IoError` to decide whether to
// retry or give up.

#[derive(Debug, Error)]
pub enum WorktreeError {
    #[error("git command failed: `{command}` — {stderr}")]
    GitCommandFailed { command: String, stderr: String },

    #[error("{path} is not a git repository (or HEAD is detached)")]
    NotARepo { path: PathBuf },

    #[error("branch `{branch}` already exists")]
    BranchAlreadyExists { branch: String },

    #[error("worktree path {path} is already occupied")]
    WorktreePathOccupied { path: PathBuf },

    #[error("merge conflict in {} files", files.len())]
    MergeConflict { files: Vec<PathBuf> },

    /// Base branch working tree has uncommitted changes at merge time.
    ///
    /// Step 6 deliberately allows a dirty repo at worker-creation time:
    /// workers live in isolated worktrees and don't touch the user's WIP
    /// there. Merging back, however, targets the base branch's working
    /// tree — `git merge` hard-refuses to overwrite dirty files, so we
    /// have to surface this before we even attempt the merge and let
    /// the user commit / stash before retrying.
    #[error("base branch has uncommitted changes in {} files", files.len())]
    BaseBranchDirty { files: Vec<PathBuf> },

    #[error("dependency graph contains a cycle")]
    DependencyCycle,

    #[error("repo has uncommitted changes")]
    UncommittedChanges,

    #[error("io error: {cause}")]
    IoError { cause: String },

    #[error("git {found:?} is older than the minimum supported {required:?}")]
    GitTooOld { found: (u32, u32), required: (u32, u32) },
}

// -- Manager ---------------------------------------------------------

impl WorktreeManager {
    /// Construct a manager rooted at `repo_root`. Validates:
    ///
    /// 1. `git --version` ≥ [`MIN_GIT_VERSION`]
    /// 2. `repo_root` is a git repo (implied by `rev-parse` below)
    /// 3. HEAD is on a branch (not detached)
    ///
    /// The branch name captured here is what all worktrees get
    /// branched from and what `merge_all` merges back into. It is
    /// **not** re-read later — if the user switches branches mid-run
    /// we still merge back to whatever branch was current at new().
    pub async fn new(repo_root: PathBuf) -> Result<Self, WorktreeError> {
        let version = detect_git_version().await?;
        if version < MIN_GIT_VERSION {
            return Err(WorktreeError::GitTooOld {
                found: version,
                required: MIN_GIT_VERSION,
            });
        }
        let base_branch = current_branch(&repo_root).await?;
        let worktrees_dir = repo_root.join(WORKTREES_DIRNAME);

        // Teach the repo to ignore everything WhaleCode writes to disk.
        // We do this at manager construction (not create()) so even a
        // dry `list()` before any worktree exists leaves the repo in
        // the right state. Failure here is advisory — if we can't
        // write to `.git/info/exclude` (permissions, unusual git
        // layout) the worktree still functions; the user just sees
        // `.whalecode-worktrees/` in `git status`.
        let _ = crate::gitignore::ensure_local_gitignore(
            &repo_root,
            &[".whalecode-worktrees/", ".whalecode/"],
        )
        .await;

        Ok(Self {
            repo_root,
            base_branch,
            worktrees_dir,
            log_tx: None,
        })
    }

    /// Attach a log sink for advisory messages. Builder-style so tests
    /// can observe warnings without globals.
    pub fn with_logger(mut self, log_tx: mpsc::Sender<String>) -> Self {
        self.log_tx = Some(log_tx);
        self
    }

    pub fn repo_root(&self) -> &Path {
        &self.repo_root
    }

    pub fn base_branch(&self) -> &str {
        &self.base_branch
    }

    pub fn worktrees_dir(&self) -> &Path {
        &self.worktrees_dir
    }

    fn worktree_path(&self, run_id: &str, subtask_id: &str) -> PathBuf {
        self.worktrees_dir.join(run_id).join(subtask_id)
    }

    fn branch_name(run_id: &str, subtask_id: &str) -> String {
        format!("{BRANCH_PREFIX}/{run_id}/{subtask_id}")
    }

    async fn log(&self, msg: impl Into<String>) {
        if let Some(tx) = &self.log_tx {
            let _ = tx.try_send(msg.into());
        }
    }

    // -- Creation ----------------------------------------------------

    /// Create a worktree for `subtask_id` under `run_id`. Branches
    /// off `base_branch`. Fails loudly if the branch or path already
    /// exists — the caller decides whether that's stale state to
    /// clean up or a real collision.
    ///
    /// Before the first worktree in a fresh `.whalecode-worktrees/`
    /// exists we also probe the repo for uncommitted changes. If
    /// dirty, we log an advisory line and proceed — WhaleCode
    /// intentionally never refuses on WIP.
    pub async fn create(
        &self,
        run_id: &str,
        subtask_id: &str,
    ) -> Result<PathBuf, WorktreeError> {
        let path = self.worktree_path(run_id, subtask_id);
        let branch = Self::branch_name(run_id, subtask_id);

        // Pre-flight: fail fast on collisions. git itself will fail
        // for the same reasons, but its error messages are verbose
        // and context-free; our taxonomy lets the caller pattern-
        // match cleanly.
        if branch_exists(&self.repo_root, &branch).await? {
            return Err(WorktreeError::BranchAlreadyExists { branch });
        }
        if tokio::fs::metadata(&path).await.is_ok() {
            return Err(WorktreeError::WorktreePathOccupied { path });
        }

        // Advisory dirty-tree check. Surface via log channel; never
        // abort. The worker won't see the WIP (worktree branches off
        // HEAD, not off a staged/working state).
        if is_dirty(&self.repo_root).await.unwrap_or(false) {
            self.log(
                "Uncommitted changes on base branch — workers will not see them.",
            )
            .await;
        }

        // Make sure parent dirs exist. `git worktree add` wants the
        // target's parent to exist but will create the leaf itself.
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| WorktreeError::IoError {
                    cause: format!("creating {} failed: {e}", parent.display()),
                })?;
        }

        let path_str = path.to_string_lossy();
        run_git(
            &self.repo_root,
            &[
                "worktree",
                "add",
                &path_str,
                "-b",
                &branch,
                &self.base_branch,
            ],
        )
        .await?;

        // Sanity check: the worktree should answer to `git status`.
        // If not, we just left a half-initialized worktree on disk —
        // clean it up before returning the error.
        if let Err(e) = run_git(&path, &["status", "--porcelain"]).await {
            let _ = self.cleanup(subtask_id).await;
            return Err(e);
        }

        Ok(path)
    }

    // -- Listing -----------------------------------------------------

    /// List all WhaleCode-managed worktrees. Filters `git worktree
    /// list --porcelain` down to just the ones whose branch name
    /// starts with `whalecode/`, then derives `run_id`/`subtask_id`
    /// from the path layout.
    pub async fn list(&self) -> Result<Vec<WorktreeInfo>, WorktreeError> {
        if tokio::fs::metadata(&self.worktrees_dir).await.is_err() {
            return Ok(vec![]);
        }
        let porcelain = run_git(&self.repo_root, &["worktree", "list", "--porcelain"]).await?;
        Ok(parse_worktree_list(&porcelain, &self.worktrees_dir))
    }

    // -- Diff --------------------------------------------------------

    /// Compute the diff of `subtask_id`'s worktree against
    /// `base_branch`. Capped at [`MAX_DIFFS_PER_SUBTASK`] entries;
    /// beyond that the UI shows a "too many changes" hint.
    ///
    /// `subtask_id` is resolved by scanning the managed worktrees —
    /// we don't store the (run_id, subtask_id) pair in the manager,
    /// because the storage layer already owns that mapping.
    pub async fn diff(&self, subtask_id: &str) -> Result<Vec<FileDiff>, WorktreeError> {
        let wt = self
            .list()
            .await?
            .into_iter()
            .find(|w| w.subtask_id == subtask_id)
            .ok_or_else(|| WorktreeError::IoError {
                cause: format!("no worktree found for subtask `{subtask_id}`"),
            })?;

        // --numstat gives us <+>\t<->\t<path> per file, with "-\t-"
        // for binaries. --name-status gives us A/M/D/R plus rename
        // pairs. We need both so we can classify and count in one
        // cheap pair of git calls.
        let numstat = run_git(
            &wt.path,
            &["diff", "--numstat", &format!("{}..HEAD", self.base_branch)],
        )
        .await?;
        let name_status = run_git(
            &wt.path,
            &[
                "diff",
                "--name-status",
                &format!("{}..HEAD", self.base_branch),
            ],
        )
        .await?;

        let counts = parse_numstat(&numstat);
        let statuses = parse_name_status(&name_status);

        let mut out = Vec::with_capacity(statuses.len().min(MAX_DIFFS_PER_SUBTASK));
        for (idx, (path, status)) in statuses.into_iter().enumerate() {
            if idx >= MAX_DIFFS_PER_SUBTASK {
                break;
            }
            let (additions, deletions, is_binary) = counts
                .get(&path)
                .copied()
                .unwrap_or((0, 0, false));

            // Binary beats whatever --name-status said — we never
            // emit a patch for binaries (they'd be megabytes of
            // base64-ish gibberish).
            let final_status = if is_binary {
                DiffStatus::Binary
            } else {
                status
            };

            let patch = if matches!(final_status, DiffStatus::Binary | DiffStatus::Deleted) {
                // Skip patch body for binaries and deletions — the
                // status alone tells the UI everything.
                String::new()
            } else {
                let path_str = path.to_string_lossy();
                // `-U10` bumps context from git's default -U3 so the
                // inline diff preview shows roughly a screen of
                // surrounding code around each change. 10 is enough
                // for most "is this change sensible?" decisions
                // without tipping into effectively-full-file output
                // on small files. Full-file inspection uses the
                // worktree-actions "Reveal in file manager" or
                // "Open terminal here" affordances instead.
                run_git(
                    &wt.path,
                    &[
                        "diff",
                        "-U10",
                        &format!("{}..HEAD", self.base_branch),
                        "--",
                        &path_str,
                    ],
                )
                .await
                .unwrap_or_default()
            };

            out.push(FileDiff {
                path,
                status: final_status,
                patch,
                additions,
                deletions,
            });
        }
        Ok(out)
    }

    // -- Merge -------------------------------------------------------

    /// Topologically merge every subtask's branch back into
    /// `base_branch`, in dependency order. On the first conflict we
    /// abort the in-flight merge and return [`WorktreeError::
    /// MergeConflict`]; worktrees stay on disk so the user can
    /// inspect them.
    ///
    /// Cleanup is deliberately **not** called here. The orchestrator
    /// decides: if the user Applies, it calls `cleanup_all`; if they
    /// Discard, same; on conflict, the user gets to review first.
    pub async fn merge_all(
        &self,
        subtask_ids: &[String],
        dependencies: &DependencyGraph,
    ) -> Result<MergeResult, WorktreeError> {
        let order = topo_sort(subtask_ids, dependencies)?;

        // Make sure the main checkout is on base_branch. In the
        // normal case it already is (base_branch was captured as the
        // current branch at new()). If the user switched away mid-
        // run this brings us back; the checkout can't conflict with
        // our worktrees because their branches have distinct names.
        run_git(&self.repo_root, &["checkout", &self.base_branch]).await?;

        // Pre-flight: refuse to merge into a dirty working tree. Step 6
        // allowed a dirty repo at worker-creation time because workers
        // don't conflict with WIP at that point — they produce commits
        // in isolated worktrees. Merging back touches the base working
        // tree directly, which is hostile to WIP: `git merge` bails with
        // "would be overwritten by merge" and leaves the user in a
        // half-checked-out state. Detect this up front, emit a clear
        // error with the dirty file list, and let the user commit /
        // stash their WIP before retrying Apply.
        let dirty_status = run_git(&self.repo_root, &["status", "--porcelain"]).await?;
        let dirty_files = parse_dirty_files(&dirty_status);
        if !dirty_files.is_empty() {
            return Err(WorktreeError::BaseBranchDirty { files: dirty_files });
        }

        let head_before = head_sha(&self.repo_root).await?;
        let mut merged_branches = Vec::with_capacity(order.len());

        for subtask_id in &order {
            // Locate the worktree so we can find the correct branch
            // name (which contains the run_id we don't have access
            // to otherwise).
            let info = self
                .list()
                .await?
                .into_iter()
                .find(|w| &w.subtask_id == subtask_id)
                .ok_or_else(|| WorktreeError::IoError {
                    cause: format!("no worktree for subtask `{subtask_id}`"),
                })?;

            let merge_res = run_git(
                &self.repo_root,
                &[
                    "merge",
                    "--no-ff",
                    "--no-edit",
                    "-m",
                    &format!("whalecode: merge {}", subtask_id),
                    &info.branch,
                ],
            )
            .await;

            if let Err(e) = merge_res {
                // Try to recover: if the failure was a conflict,
                // abort cleanly and report the conflicted files. If
                // it was something else (dirty tree, permissions,
                // etc.) we surface the git error as-is.
                let status = run_git(&self.repo_root, &["status", "--porcelain"])
                    .await
                    .unwrap_or_default();
                let files = parse_conflicted_files(&status);
                if !files.is_empty() {
                    let _ = run_git(&self.repo_root, &["merge", "--abort"]).await;
                    return Err(WorktreeError::MergeConflict { files });
                }
                return Err(e);
            }

            merged_branches.push(info.branch);
        }

        let head_after = head_sha(&self.repo_root).await?;
        let files_changed = if head_before == head_after {
            vec![]
        } else {
            changed_files_between(&self.repo_root, &head_before, &head_after)
                .await
                .unwrap_or_default()
        };

        Ok(MergeResult {
            commits_created: order.len(),
            files_changed,
            commit_sha: head_after,
        })
    }

    // -- Cleanup -----------------------------------------------------

    /// Remove a single worktree + its branch. Idempotent: calling
    /// twice on the same subtask_id is not an error — every step
    /// checks existence first. Non-idempotency here would leak
    /// worktrees on retry paths.
    pub async fn cleanup(&self, subtask_id: &str) -> Result<(), WorktreeError> {
        let wt = self
            .list()
            .await?
            .into_iter()
            .find(|w| w.subtask_id == subtask_id);

        let (path, branch) = match wt {
            Some(info) => (info.path, info.branch),
            None => {
                // Not a known managed worktree. Scan disk for a
                // leftover directory with matching subtask_id — orphan
                // cleanup falls through this same code path.
                if let Some(leftover) = find_orphan_dir(&self.worktrees_dir, subtask_id).await {
                    (leftover, String::new())
                } else {
                    return Ok(());
                }
            }
        };

        // 1. `git worktree remove --force`. Force because the worker
        // may have left unstaged changes or even an ongoing merge.
        let path_str = path.to_string_lossy();
        let _ = try_run_git(
            &self.repo_root,
            &["worktree", "remove", "--force", &path_str],
        )
        .await;

        // 2. Drop the branch. `-D` not `-d` because its commits
        // haven't been merged if the run was cancelled.
        if !branch.is_empty() {
            let _ = try_run_git(&self.repo_root, &["branch", "-D", &branch]).await;
        }

        // 3. Belt-and-braces: if the dir still exists (git worktree
        // remove occasionally fails mid-way, leaving dir + no admin
        // entry), nuke it manually. Last line of defense.
        if tokio::fs::metadata(&path).await.is_ok() {
            if let Err(e) = tokio::fs::remove_dir_all(&path).await {
                return Err(WorktreeError::IoError {
                    cause: format!("failed to remove {}: {e}", path.display()),
                });
            }
        }

        // 4. Prune git's admin entries regardless — cheap, makes
        // `git worktree list` stop mentioning removed paths.
        let _ = try_run_git(&self.repo_root, &["worktree", "prune"]).await;

        Ok(())
    }

    /// Remove every managed worktree, then the containing dir. Called
    /// on Apply/Discard/cancel — every normal exit path.
    pub async fn cleanup_all(&self) -> Result<(), WorktreeError> {
        let list = self.list().await.unwrap_or_default();
        for wt in list {
            if let Err(e) = self.cleanup(&wt.subtask_id).await {
                // Keep going — we want to remove as much as possible
                // even if one cleanup errors. Log and carry on.
                self.log(format!("cleanup error for {}: {}", wt.subtask_id, e))
                    .await;
            }
        }
        // Prune git's view of any stragglers before we delete the
        // directory they live in.
        let _ = try_run_git(&self.repo_root, &["worktree", "prune"]).await;

        if tokio::fs::metadata(&self.worktrees_dir).await.is_ok() {
            if let Err(e) = tokio::fs::remove_dir_all(&self.worktrees_dir).await {
                // Non-fatal: a stale dir is a nuisance, not data loss.
                self.log(format!(
                    "could not remove worktrees dir {}: {}",
                    self.worktrees_dir.display(),
                    e
                ))
                .await;
            }
        }
        Ok(())
    }

    /// Sweep `.whalecode-worktrees/` on app startup. Anything under
    /// it is presumed orphaned — a clean boot means no run is in
    /// progress, so nothing here belongs to anyone. Returns the
    /// number of worktree dirs removed.
    ///
    /// Idempotent and tolerant: missing directory is not an error
    /// (returns 0), and per-entry failures are logged but don't abort
    /// the sweep.
    pub async fn cleanup_orphans_on_startup(&self) -> Result<usize, WorktreeError> {
        if tokio::fs::metadata(&self.worktrees_dir).await.is_err() {
            return Ok(0);
        }

        // First, ask git what it still knows about — those are the
        // "nice" orphans with both branch + worktree admin entries.
        let known = self.list().await.unwrap_or_default();
        let mut cleaned = 0usize;
        for wt in known {
            if self.cleanup(&wt.subtask_id).await.is_ok() {
                cleaned += 1;
            }
        }

        // Now sweep anything left on disk that git doesn't know
        // about (e.g. half-created during a crash). We recurse two
        // levels: {worktrees_dir}/{run_id}/{subtask_id}.
        if let Ok(mut run_dirs) = tokio::fs::read_dir(&self.worktrees_dir).await {
            while let Ok(Some(run_entry)) = run_dirs.next_entry().await {
                let run_path = run_entry.path();
                if !run_path.is_dir() {
                    continue;
                }
                if let Ok(mut subtasks) = tokio::fs::read_dir(&run_path).await {
                    while let Ok(Some(sub_entry)) = subtasks.next_entry().await {
                        let sub_path = sub_entry.path();
                        if sub_path.is_dir() {
                            if let Err(e) = tokio::fs::remove_dir_all(&sub_path).await {
                                self.log(format!(
                                    "orphan sweep: couldn't remove {}: {}",
                                    sub_path.display(),
                                    e
                                ))
                                .await;
                            } else {
                                cleaned += 1;
                            }
                        }
                    }
                }
                let _ = tokio::fs::remove_dir(&run_path).await;
            }
        }

        // Kill any leftover `whalecode/*` branches whose worktree
        // entries we've just pruned. `git branch -D` fails silently
        // via try_run_git if they're already gone.
        if let Ok(branches) = run_git(&self.repo_root, &["branch", "--list", "whalecode/*"]).await {
            for line in branches.lines() {
                let name = line.trim_start_matches('*').trim();
                if name.is_empty() {
                    continue;
                }
                let _ = try_run_git(&self.repo_root, &["branch", "-D", name]).await;
            }
        }

        let _ = try_run_git(&self.repo_root, &["worktree", "prune"]).await;
        let _ = tokio::fs::remove_dir(&self.worktrees_dir).await;

        if cleaned > 0 {
            self.log(format!("cleaned up {cleaned} orphan worktree(s) on startup"))
                .await;
        }
        Ok(cleaned)
    }
}

// -- Helpers ---------------------------------------------------------

/// Topological sort of `ids` given `deps` (map from id → ids that must
/// come before). Returns an ordering where every dependency appears
/// before its dependent. Errors with [`WorktreeError::DependencyCycle`]
/// if the graph isn't a DAG.
///
/// Small graphs (~10 nodes tops in practice), so Kahn's algorithm
/// without any crate dependency is the right tool.
fn topo_sort(
    ids: &[String],
    deps: &DependencyGraph,
) -> Result<Vec<String>, WorktreeError> {
    let set: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let mut indegree: HashMap<&str, usize> = ids.iter().map(|s| (s.as_str(), 0usize)).collect();
    let mut successors: HashMap<&str, Vec<&str>> = HashMap::new();

    for id in ids {
        if let Some(ds) = deps.edges.get(id) {
            for d in ds {
                if !set.contains(d.as_str()) {
                    // Dep points outside this set. Ignore — caller's
                    // responsibility to feed a complete set. This
                    // shouldn't happen in practice but we'd rather
                    // proceed than refuse on a benign data shape.
                    continue;
                }
                *indegree.entry(id.as_str()).or_insert(0) += 1;
                successors.entry(d.as_str()).or_default().push(id.as_str());
            }
        }
    }

    let mut queue: VecDeque<&str> = indegree
        .iter()
        .filter_map(|(k, &v)| if v == 0 { Some(*k) } else { None })
        .collect();

    let mut out: Vec<String> = Vec::with_capacity(ids.len());
    while let Some(n) = queue.pop_front() {
        out.push(n.to_string());
        if let Some(succs) = successors.get(n) {
            for s in succs {
                let entry = indegree.entry(s).or_insert(0);
                *entry -= 1;
                if *entry == 0 {
                    queue.push_back(s);
                }
            }
        }
    }

    if out.len() != ids.len() {
        return Err(WorktreeError::DependencyCycle);
    }
    Ok(out)
}

/// Parse `git worktree list --porcelain` into our structured form.
/// Only keeps worktrees under `worktrees_dir` — the user's main
/// checkout and any unrelated worktrees are ignored.
fn parse_worktree_list(porcelain: &str, worktrees_dir: &Path) -> Vec<WorktreeInfo> {
    let mut out = Vec::new();
    let mut cur_path: Option<PathBuf> = None;
    let mut cur_branch: Option<String> = None;

    let flush = |path: &mut Option<PathBuf>, branch: &mut Option<String>, out: &mut Vec<WorktreeInfo>| {
        if let (Some(p), Some(b)) = (path.take(), branch.take()) {
            if let Ok(rel) = p.strip_prefix(worktrees_dir) {
                // Expected layout: {worktrees_dir}/{run_id}/{subtask_id}
                let mut comps = rel.components();
                let run_id = comps.next().map(|c| c.as_os_str().to_string_lossy().into_owned());
                let subtask_id = comps.next().map(|c| c.as_os_str().to_string_lossy().into_owned());
                if let (Some(run_id), Some(subtask_id)) = (run_id, subtask_id) {
                    if b.starts_with(&format!("{BRANCH_PREFIX}/")) {
                        out.push(WorktreeInfo {
                            run_id,
                            subtask_id,
                            path: p,
                            branch: b,
                        });
                    }
                }
            }
        } else {
            path.take();
            branch.take();
        }
    };

    for line in porcelain.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            // New record — flush any pending one first.
            flush(&mut cur_path, &mut cur_branch, &mut out);
            cur_path = Some(PathBuf::from(p));
        } else if let Some(b) = line.strip_prefix("branch ") {
            // `branch refs/heads/whalecode/...` — strip the ref prefix.
            cur_branch = Some(b.trim_start_matches("refs/heads/").to_string());
        }
        // Other lines (HEAD, bare, detached) — we don't care; branch
        // stays None for those and the record gets dropped.
    }
    flush(&mut cur_path, &mut cur_branch, &mut out);
    out
}

/// Parse `git diff --numstat` output. Keyed by path, value is
/// `(additions, deletions, is_binary)`. Binary lines show up as
/// `-\t-\t<path>` which we recognize by the literal dashes.
fn parse_numstat(s: &str) -> HashMap<PathBuf, (usize, usize, bool)> {
    let mut out = HashMap::new();
    for line in s.lines() {
        let mut parts = line.splitn(3, '\t');
        let (add, del, path) = match (parts.next(), parts.next(), parts.next()) {
            (Some(a), Some(d), Some(p)) => (a, d, p),
            _ => continue,
        };
        let path = PathBuf::from(path);
        if add == "-" && del == "-" {
            out.insert(path, (0, 0, true));
        } else {
            let a = add.parse().unwrap_or(0);
            let d = del.parse().unwrap_or(0);
            out.insert(path, (a, d, false));
        }
    }
    out
}

/// Parse `git diff --name-status`. Returns `(path, status)` pairs in
/// the order git emitted them. Rename pairs carry the old path on
/// [`DiffStatus::Renamed`].
fn parse_name_status(s: &str) -> Vec<(PathBuf, DiffStatus)> {
    let mut out = Vec::new();
    for line in s.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split('\t');
        let code = match parts.next() {
            Some(c) if !c.is_empty() => c,
            _ => continue,
        };
        let c0 = code.chars().next().unwrap_or('?');
        match c0 {
            'A' => {
                if let Some(p) = parts.next() {
                    out.push((PathBuf::from(p), DiffStatus::Added));
                }
            }
            'M' => {
                if let Some(p) = parts.next() {
                    out.push((PathBuf::from(p), DiffStatus::Modified));
                }
            }
            'D' => {
                if let Some(p) = parts.next() {
                    out.push((PathBuf::from(p), DiffStatus::Deleted));
                }
            }
            'R' => {
                if let (Some(from), Some(to)) = (parts.next(), parts.next()) {
                    out.push((
                        PathBuf::from(to),
                        DiffStatus::Renamed {
                            from: PathBuf::from(from),
                        },
                    ));
                }
            }
            _ => { /* C (copy), T (type change), U (unmerged) — skip */ }
        }
    }
    out
}

async fn head_sha(repo_root: &Path) -> Result<String, WorktreeError> {
    Ok(run_git(repo_root, &["rev-parse", "HEAD"]).await?.trim().to_string())
}

async fn changed_files_between(
    repo_root: &Path,
    from: &str,
    to: &str,
) -> Result<Vec<PathBuf>, WorktreeError> {
    let out = run_git(repo_root, &["diff", "--name-only", &format!("{from}..{to}")]).await?;
    Ok(out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(PathBuf::from)
        .collect())
}

/// Walk `.whalecode-worktrees/*/<subtask_id>` looking for a leftover
/// directory that git doesn't know about. Used by cleanup() when
/// `list()` came up empty but a stale dir might still be on disk.
async fn find_orphan_dir(worktrees_dir: &Path, subtask_id: &str) -> Option<PathBuf> {
    let mut run_dirs = tokio::fs::read_dir(worktrees_dir).await.ok()?;
    while let Ok(Some(run_entry)) = run_dirs.next_entry().await {
        let candidate = run_entry.path().join(subtask_id);
        if tokio::fs::metadata(&candidate).await.is_ok() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    fn deps(pairs: &[(&str, &[&str])]) -> DependencyGraph {
        let mut g = DependencyGraph::new();
        for (k, v) in pairs {
            g.insert(*k, v.iter().map(|s| s.to_string()).collect());
        }
        g
    }

    #[test]
    fn topo_sort_linear_chain() {
        let ids = vec!["a".into(), "b".into(), "c".into()];
        let g = deps(&[("b", &["a"]), ("c", &["b"])]);
        let order = topo_sort(&ids, &g).unwrap();
        assert_eq!(order, vec!["a", "b", "c"]);
    }

    #[test]
    fn topo_sort_parallel_branches() {
        let ids = vec!["root".into(), "left".into(), "right".into(), "join".into()];
        let g = deps(&[
            ("left", &["root"]),
            ("right", &["root"]),
            ("join", &["left", "right"]),
        ]);
        let order = topo_sort(&ids, &g).unwrap();
        assert_eq!(order[0], "root");
        assert_eq!(order[3], "join");
        assert!(order.contains(&"left".to_string()));
        assert!(order.contains(&"right".to_string()));
    }

    #[test]
    fn topo_sort_cycle_rejected() {
        let ids = vec!["a".into(), "b".into()];
        let g = deps(&[("a", &["b"]), ("b", &["a"])]);
        assert!(matches!(
            topo_sort(&ids, &g),
            Err(WorktreeError::DependencyCycle)
        ));
    }

    #[test]
    fn topo_sort_self_loop_rejected() {
        let ids = vec!["a".into()];
        let g = deps(&[("a", &["a"])]);
        assert!(matches!(
            topo_sort(&ids, &g),
            Err(WorktreeError::DependencyCycle)
        ));
    }

    #[test]
    fn parse_numstat_mixed() {
        let s = "10\t2\tsrc/lib.rs\n-\t-\timg.png\n0\t5\told.txt\n";
        let m = parse_numstat(s);
        assert_eq!(m[&PathBuf::from("src/lib.rs")], (10, 2, false));
        assert_eq!(m[&PathBuf::from("img.png")], (0, 0, true));
        assert_eq!(m[&PathBuf::from("old.txt")], (0, 5, false));
    }

    #[test]
    fn parse_name_status_covers_add_mod_del_rename() {
        let s = "A\tnew.rs\nM\tlib.rs\nD\told.rs\nR100\tfrom.rs\tto.rs\n";
        let v = parse_name_status(s);
        assert_eq!(v[0], (PathBuf::from("new.rs"), DiffStatus::Added));
        assert_eq!(v[1], (PathBuf::from("lib.rs"), DiffStatus::Modified));
        assert_eq!(v[2], (PathBuf::from("old.rs"), DiffStatus::Deleted));
        assert_eq!(
            v[3],
            (
                PathBuf::from("to.rs"),
                DiffStatus::Renamed {
                    from: PathBuf::from("from.rs")
                }
            )
        );
    }

    #[test]
    fn parse_worktree_list_filters_to_managed() {
        let base = PathBuf::from("/tmp/repo");
        let worktrees_dir = base.join(".whalecode-worktrees");
        let porcelain = format!(
            "worktree /tmp/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree {}\nHEAD def\nbranch refs/heads/whalecode/run1/sub1\n",
            worktrees_dir.join("run1").join("sub1").display()
        );
        let list = parse_worktree_list(&porcelain, &worktrees_dir);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].run_id, "run1");
        assert_eq!(list[0].subtask_id, "sub1");
        assert_eq!(list[0].branch, "whalecode/run1/sub1");
    }
}
