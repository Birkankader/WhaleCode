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
}
