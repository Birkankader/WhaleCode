//! Low-level `git` invocation helpers.
//!
//! Everything the worktree manager needs to know about driving the
//! git CLI lives here: running a command with a cwd, parsing the few
//! outputs we care about, and classifying "branch exists" / "detached
//! HEAD" style questions.
//!
//! We shell out to `git` rather than link libgit2 because (a) the repo
//! is the user's — we want identical behavior to whatever they'd get
//! at the command line, and (b) `git worktree` is simpler to drive
//! through the CLI than through libgit2's WIP worktree bindings.

use std::path::Path;

use tokio::process::Command;

use super::WorktreeError;

/// Minimum git version we support. `git worktree` is older than this,
/// but `--porcelain` output and the `git worktree list` format we
/// depend on have been stable since 2.17.
pub const MIN_GIT_VERSION: (u32, u32) = (2, 17);

/// Run `git` with the given args in `cwd`. Returns stdout on a zero
/// exit; returns [`WorktreeError::GitCommandFailed`] otherwise, with
/// the full command string and stderr preserved for the caller.
pub async fn run_git<P: AsRef<Path>>(
    cwd: P,
    args: &[&str],
) -> Result<String, WorktreeError> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd.as_ref())
        .output()
        .await
        .map_err(|e| WorktreeError::IoError {
            cause: format!("spawning `git {}` failed: {e}", args.join(" ")),
        })?;
    if !out.status.success() {
        return Err(WorktreeError::GitCommandFailed {
            command: format!("git {}", args.join(" ")),
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Same as [`run_git`] but returns `Ok(None)` on non-zero exit
/// (instead of surfacing as an error). Used for probe-style commands
/// where "no" is a legal answer — e.g. `git show-ref --verify`.
pub async fn try_run_git<P: AsRef<Path>>(
    cwd: P,
    args: &[&str],
) -> Result<Option<String>, WorktreeError> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd.as_ref())
        .output()
        .await
        .map_err(|e| WorktreeError::IoError {
            cause: format!("spawning `git {}` failed: {e}", args.join(" ")),
        })?;
    if !out.status.success() {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&out.stdout).to_string()))
}

/// Parse `git --version` output into a `(major, minor)` tuple. Used at
/// construction time to refuse ancient gits whose `git worktree`
/// behavior we haven't tested against.
pub async fn detect_git_version() -> Result<(u32, u32), WorktreeError> {
    // No cwd needed — `git --version` is process-global.
    let out = Command::new("git")
        .arg("--version")
        .output()
        .await
        .map_err(|e| WorktreeError::IoError {
            cause: format!("couldn't invoke `git --version`: {e}"),
        })?;
    if !out.status.success() {
        return Err(WorktreeError::GitCommandFailed {
            command: "git --version".into(),
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        });
    }
    let text = String::from_utf8_lossy(&out.stdout);
    parse_version(&text).ok_or_else(|| WorktreeError::IoError {
        cause: format!("couldn't parse `git --version` output: {text:?}"),
    })
}

/// Extract `(major, minor)` from a `git version X.Y.Z (...)` string.
/// Tolerant of trailing OS tags ("Apple Git-155") and pre-release
/// suffixes — we only care about major.minor.
fn parse_version(s: &str) -> Option<(u32, u32)> {
    let after = s.trim().strip_prefix("git version ")?;
    let digits: String = after
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut parts = digits.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

/// Is the working tree in `cwd` sitting on a branch, or detached? We
/// refuse to construct a manager in detached HEAD since all the
/// worktree branching assumes we have a sensible base branch name to
/// branch off of.
pub async fn current_branch(repo_root: &Path) -> Result<String, WorktreeError> {
    let out = run_git(repo_root, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    let name = out.trim();
    if name == "HEAD" || name.is_empty() {
        return Err(WorktreeError::NotARepo {
            path: repo_root.to_path_buf(),
        });
    }
    Ok(name.to_string())
}

/// `Ok(true)` iff `refs/heads/<branch>` exists locally. `--quiet`
/// suppresses the default "fatal" message on miss so we don't pollute
/// stderr with a non-error condition.
pub async fn branch_exists(repo_root: &Path, branch: &str) -> Result<bool, WorktreeError> {
    let refname = format!("refs/heads/{branch}");
    Ok(try_run_git(
        repo_root,
        &["show-ref", "--verify", "--quiet", &refname],
    )
    .await?
    .is_some())
}

/// `Ok(true)` iff the working tree OR the index has uncommitted
/// changes. Used only as an advisory warning — we never refuse to run
/// on a dirty tree.
pub async fn is_dirty(repo_root: &Path) -> Result<bool, WorktreeError> {
    let out = run_git(repo_root, &["status", "--porcelain"]).await?;
    Ok(!out.trim().is_empty())
}

/// Parse tracked-change entries from `git status --porcelain`. These
/// are the paths that would cause `git merge` to refuse with "would be
/// overwritten by merge". Untracked (`??`) entries are skipped because
/// they rarely block a merge in practice and we don't want the pre-
/// flight error to include WIP the user doesn't care about.
pub fn parse_dirty_files(porcelain: &str) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for line in porcelain.lines() {
        if line.len() < 4 {
            continue;
        }
        let (status, rest) = line.split_at(2);
        // Skip untracked (`??`) and ignored (`!!`). Everything else
        // indicates a staged/unstaged modification, addition, deletion,
        // rename, copy, or unmerged state — all of which either do
        // block merge or should make the user pause.
        if status == "??" || status == "!!" {
            continue;
        }
        let path = rest.trim();
        if path.is_empty() {
            continue;
        }
        // Rename entries look like `R  old -> new`; keep only the
        // destination so the error list makes sense to the user.
        let path = path.rsplit(" -> ").next().unwrap_or(path);
        out.push(std::path::PathBuf::from(path));
    }
    out
}

/// Parse the `UU`, `AA`, `DD` entries from `git status --porcelain`
/// inside a merge-conflict state. These are the paths the user has to
/// resolve. Non-conflict entries are ignored.
pub fn parse_conflicted_files(porcelain: &str) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for line in porcelain.lines() {
        if line.len() < 4 {
            continue;
        }
        let (status, rest) = line.split_at(2);
        let both_unmerged = matches!(status, "UU" | "AA" | "DD" | "AU" | "UA" | "UD" | "DU");
        if !both_unmerged {
            continue;
        }
        let path = rest.trim();
        if path.is_empty() {
            continue;
        }
        out.push(std::path::PathBuf::from(path));
    }
    out
}

/// Phase 5 Step 2 — outcome of a `git stash push -u`. `None` means
/// the working tree was clean and git refused to create a stash
/// (stdout "No local changes to save"). That shouldn't happen on the
/// `stash_and_retry_apply` path because we've already observed
/// `BaseBranchDirty`, but we surface it explicitly so the caller can
/// treat a clean tree as a no-op rather than an error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StashPushOutcome {
    Created { stash_ref: String },
    NothingToStash,
}

/// Phase 5 Step 2 — run `git stash push -u -m <message>` in
/// `repo_root`. Captures untracked (`-u`) so files the workers-then-
/// users left in the working tree round-trip cleanly. Returns the
/// stash ref (e.g. `stash@{0}`) for the explicit `pop_stash` pairing;
/// that avoids the classic "blind `git stash pop` hits someone else's
/// stash" footgun.
///
/// Security: structured argv — no shell interpolation on the
/// `message` argument. `message` is composed from fixed copy and a
/// timestamp / run-id in the caller; no user input ever gets spliced
/// into a shell string.
pub async fn stash_push<P: AsRef<Path>>(
    repo_root: P,
    message: &str,
) -> Result<StashPushOutcome, WorktreeError> {
    let out = Command::new("git")
        .args(["stash", "push", "-u", "-m", message])
        .current_dir(repo_root.as_ref())
        .output()
        .await
        .map_err(|e| WorktreeError::IoError {
            cause: format!("spawning `git stash push` failed: {e}"),
        })?;
    if !out.status.success() {
        return Err(WorktreeError::GitCommandFailed {
            command: "git stash push".to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        });
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    // `git stash push` prints "No local changes to save" on a clean
    // tree and exits 0. Treat as no-op.
    if stdout.contains("No local changes to save") {
        return Ok(StashPushOutcome::NothingToStash);
    }
    // Resolve the stash ref via `git rev-parse stash@{0}` so we hold
    // an *immutable* SHA rather than the position-dependent
    // `stash@{0}` label — otherwise a manual `git stash` between
    // create and pop would shift the index under us. We still log
    // the label in the message for user debugging.
    let rev = run_git(repo_root.as_ref(), &["rev-parse", "stash@{0}"]).await?;
    let stash_ref = rev.trim().to_string();
    Ok(StashPushOutcome::Created { stash_ref })
}

/// Phase 5 Step 2 — outcome of a `git stash pop <ref>`. `Applied`
/// means the pop succeeded (no conflicts, stash entry removed).
/// `Conflicted` means the pop applied but with merge conflicts; git
/// *keeps* the stash entry in that case so the user can retry after
/// resolving. `Missing` means the ref no longer exists (someone
/// dropped the stash externally).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StashPopOutcome {
    Applied,
    Conflicted,
    Missing,
}

/// Phase 5 Step 2 — run `git stash pop <ref>` in `repo_root`.
/// Distinguishes the three outcomes above via exit code + stdout/
/// stderr probing. `ref_sha` must be the SHA returned by
/// [`stash_push`] — we take it as an argument rather than defaulting
/// to `stash@{0}` so a manual `git stash` between create and pop
/// doesn't target the wrong entry.
pub async fn stash_pop<P: AsRef<Path>>(
    repo_root: P,
    ref_sha: &str,
) -> Result<StashPopOutcome, WorktreeError> {
    // `git stash pop <sha>` doesn't work — pop takes a symbolic
    // `stash@{N}` index, not a raw SHA. Look up our entry by SHA in
    // `git stash list --format=%H` and translate to the symbolic
    // index before popping. This is what gives us the "target the
    // right entry even if the user ran `git stash` between create
    // and pop" guarantee — blind `stash@{0}` would hit the newest
    // stash, not ours.
    let list = run_git(repo_root.as_ref(), &["stash", "list", "--format=%H"]).await?;
    let index = list
        .lines()
        .map(str::trim)
        .enumerate()
        .find(|(_, sha)| *sha == ref_sha)
        .map(|(i, _)| i);
    let Some(index) = index else {
        return Ok(StashPopOutcome::Missing);
    };
    let symbolic = format!("stash@{{{index}}}");
    let out = Command::new("git")
        .args(["stash", "pop", &symbolic])
        .current_dir(repo_root.as_ref())
        .output()
        .await
        .map_err(|e| WorktreeError::IoError {
            cause: format!("spawning `git stash pop` failed: {e}"),
        })?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.success() {
        return Ok(StashPopOutcome::Applied);
    }
    // Conflicts: stash entry is preserved, exit code is non-zero.
    // Git's wording varies by version; we look for the two stable
    // phrases.
    let combined = format!("{stdout}\n{stderr}");
    if combined.contains("CONFLICT") || combined.contains("conflict") {
        return Ok(StashPopOutcome::Conflicted);
    }
    Err(WorktreeError::GitCommandFailed {
        command: format!("git stash pop {symbolic}"),
        stderr: stderr.trim().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_apple_git() {
        assert_eq!(parse_version("git version 2.50.1 (Apple Git-155)\n"), Some((2, 50)));
    }

    #[test]
    fn parse_version_vanilla() {
        assert_eq!(parse_version("git version 2.39.2\n"), Some((2, 39)));
    }

    #[test]
    fn parse_version_bogus_returns_none() {
        assert_eq!(parse_version("not git output"), None);
    }

    #[test]
    fn conflicted_files_picks_up_uu_lines() {
        let porcelain = "UU src/lib.rs\n M other.rs\nAA conflict.md\n";
        let files = parse_conflicted_files(porcelain);
        assert_eq!(
            files,
            vec![
                std::path::PathBuf::from("src/lib.rs"),
                std::path::PathBuf::from("conflict.md"),
            ]
        );
    }

    #[test]
    fn conflicted_files_ignores_non_conflict() {
        let porcelain = " M clean.rs\n?? untracked.txt\n";
        assert!(parse_conflicted_files(porcelain).is_empty());
    }

    #[test]
    fn dirty_files_reports_tracked_changes() {
        let porcelain = " M src/lib.rs\nM  staged.rs\nMM both.rs\nA  new.rs\n D deleted.rs\n";
        let files = parse_dirty_files(porcelain);
        assert_eq!(
            files,
            vec![
                std::path::PathBuf::from("src/lib.rs"),
                std::path::PathBuf::from("staged.rs"),
                std::path::PathBuf::from("both.rs"),
                std::path::PathBuf::from("new.rs"),
                std::path::PathBuf::from("deleted.rs"),
            ]
        );
    }

    #[test]
    fn dirty_files_skips_untracked_and_ignored() {
        let porcelain = " M tracked.rs\n?? untracked.txt\n!! ignored.log\n";
        assert_eq!(
            parse_dirty_files(porcelain),
            vec![std::path::PathBuf::from("tracked.rs")]
        );
    }

    #[test]
    fn dirty_files_keeps_rename_destination() {
        let porcelain = "R  old/path.rs -> new/path.rs\n";
        assert_eq!(
            parse_dirty_files(porcelain),
            vec![std::path::PathBuf::from("new/path.rs")]
        );
    }

    #[test]
    fn dirty_files_empty_on_clean_repo() {
        assert!(parse_dirty_files("").is_empty());
        assert!(parse_dirty_files("?? only-untracked\n").is_empty());
    }
}
