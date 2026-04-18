//! Target-repo inspection: folder-picker dialog, validation, and the tiny
//! bit of `.git` parsing needed to surface the current branch in the UI.
//!
//! We intentionally do not pull in `git2`/`gix` here — Phase 2 step 2 only
//! needs to answer "is this a git repo" and "what branch is checked out",
//! which is cheap to do with a file read. The orchestrator (step 8) will
//! shell out to `git` for anything non-trivial.
//!
//! Wire types mirrored in `src/lib/ipc.ts` — keep in sync.

use std::path::{Path, PathBuf};

use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Info returned to the frontend about a repo path. `is_git_repo` is the
/// quick gate — if false, the frontend won't save the path as `lastRepo`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    pub is_git_repo: bool,
    pub current_branch: Option<String>,
}

/// Tagged-union result from `validate_repo`. The `valid` discriminator
/// serializes as a boolean (not a string) so the wire shape matches what
/// Zod's `z.discriminatedUnion('valid', …)` expects on the TS side.
/// Serialization is hand-rolled because `#[serde(tag = "valid")]` emits
/// strings for the discriminator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RepoValidation {
    Valid { info: RepoInfo },
    Invalid { reason: RepoInvalidReason },
}

impl Serialize for RepoValidation {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2))?;
        match self {
            RepoValidation::Valid { info } => {
                map.serialize_entry("valid", &true)?;
                map.serialize_entry("info", info)?;
            }
            RepoValidation::Invalid { reason } => {
                map.serialize_entry("valid", &false)?;
                map.serialize_entry("reason", reason)?;
            }
        }
        map.end()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RepoInvalidReason {
    NotADirectory,
    NotAGitRepo,
    Inaccessible,
}

/// Pure validator. Public for testing; commands wrap it.
pub fn validate_path(path: &Path) -> RepoValidation {
    let metadata = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return RepoValidation::Invalid {
                reason: RepoInvalidReason::Inaccessible,
            };
        }
        Err(_) => {
            return RepoValidation::Invalid {
                reason: RepoInvalidReason::Inaccessible,
            };
        }
    };
    if !metadata.is_dir() {
        return RepoValidation::Invalid {
            reason: RepoInvalidReason::NotADirectory,
        };
    }
    let Some(git_dir) = git_dir_for(path) else {
        return RepoValidation::Invalid {
            reason: RepoInvalidReason::NotAGitRepo,
        };
    };
    RepoValidation::Valid {
        info: RepoInfo {
            path: path.to_string_lossy().into_owned(),
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string_lossy().into_owned()),
            is_git_repo: true,
            current_branch: read_branch(&git_dir),
        },
    }
}

/// Resolves the `.git` directory for a working tree, following a `.git` file
/// (worktree/submodule) if present. Returns `None` if neither form exists.
fn git_dir_for(repo: &Path) -> Option<PathBuf> {
    let candidate = repo.join(".git");
    let meta = std::fs::metadata(&candidate).ok()?;
    if meta.is_dir() {
        return Some(candidate);
    }
    if meta.is_file() {
        let contents = std::fs::read_to_string(&candidate).ok()?;
        for line in contents.lines() {
            if let Some(rest) = line.strip_prefix("gitdir:") {
                let p = Path::new(rest.trim());
                return Some(if p.is_absolute() {
                    p.to_path_buf()
                } else {
                    repo.join(p)
                });
            }
        }
    }
    None
}

fn read_branch(git_dir: &Path) -> Option<String> {
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();
    head.strip_prefix("ref: refs/heads/").map(|s| s.to_string())
}

/// Opens a native folder dialog. Returns `None` if the user cancels; a
/// `RepoInfo` (with `is_git_repo = false` if the pick isn't a git repo)
/// otherwise — the frontend gatekeeps on `is_git_repo` before saving.
#[tauri::command]
pub async fn pick_repo(app: AppHandle) -> Result<Option<RepoInfo>, String> {
    let app_clone = app.clone();
    let file_path = tauri::async_runtime::spawn_blocking(move || {
        app_clone
            .dialog()
            .file()
            .set_title("Select project repository")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| format!("dialog task failed: {e}"))?;

    let Some(fp) = file_path else { return Ok(None) };
    let path = fp.into_path().map_err(|e| format!("resolve picked path: {e}"))?;

    Ok(Some(describe(&path)))
}

#[tauri::command(rename_all = "camelCase")]
pub fn validate_repo(path: String) -> Result<RepoValidation, String> {
    Ok(validate_path(Path::new(&path)))
}

/// Builds a `RepoInfo` for a path that exists on disk, whether or not it's a
/// git repo. Used by `pick_repo` so the UI can differentiate "user cancelled"
/// from "user picked a non-repo folder".
fn describe(path: &Path) -> RepoInfo {
    let git_dir = git_dir_for(path);
    RepoInfo {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned()),
        is_git_repo: git_dir.is_some(),
        current_branch: git_dir.as_deref().and_then(read_branch),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn init_git_dir(root: &Path, branch: &str) {
        let git = root.join(".git");
        std::fs::create_dir_all(&git).unwrap();
        std::fs::write(git.join("HEAD"), format!("ref: refs/heads/{branch}\n")).unwrap();
    }

    #[test]
    fn valid_repo_returns_name_and_branch() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("my-app");
        std::fs::create_dir_all(&repo).unwrap();
        init_git_dir(&repo, "main");

        match validate_path(&repo) {
            RepoValidation::Valid { info } => {
                assert_eq!(info.name, "my-app");
                assert!(info.is_git_repo);
                assert_eq!(info.current_branch.as_deref(), Some("main"));
            }
            other => panic!("expected Valid, got {other:?}"),
        }
    }

    #[test]
    fn missing_path_is_inaccessible() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        assert_eq!(
            validate_path(&missing),
            RepoValidation::Invalid {
                reason: RepoInvalidReason::Inaccessible,
            }
        );
    }

    #[test]
    fn file_path_is_not_a_directory() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("README.md");
        std::fs::write(&file, "hi").unwrap();
        assert_eq!(
            validate_path(&file),
            RepoValidation::Invalid {
                reason: RepoInvalidReason::NotADirectory,
            }
        );
    }

    #[test]
    fn plain_directory_is_not_a_git_repo() {
        let dir = tempdir().unwrap();
        let sub = dir.path().join("plain");
        std::fs::create_dir_all(&sub).unwrap();
        assert_eq!(
            validate_path(&sub),
            RepoValidation::Invalid {
                reason: RepoInvalidReason::NotAGitRepo,
            }
        );
    }

    #[test]
    fn worktree_with_gitdir_file_is_recognized() {
        let dir = tempdir().unwrap();
        // "real" bare-ish gitdir
        let real_git = dir.path().join("real.git");
        std::fs::create_dir_all(&real_git).unwrap();
        std::fs::write(real_git.join("HEAD"), "ref: refs/heads/feature\n").unwrap();

        // worktree-style repo whose .git is a file pointing at the real gitdir
        let wt = dir.path().join("worktree");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(
            wt.join(".git"),
            format!("gitdir: {}\n", real_git.display()),
        )
        .unwrap();

        match validate_path(&wt) {
            RepoValidation::Valid { info } => {
                assert_eq!(info.current_branch.as_deref(), Some("feature"));
            }
            other => panic!("expected Valid, got {other:?}"),
        }
    }

    #[test]
    fn detached_head_returns_none_branch() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("detached");
        std::fs::create_dir_all(&repo).unwrap();
        let git = repo.join(".git");
        std::fs::create_dir_all(&git).unwrap();
        std::fs::write(git.join("HEAD"), "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n").unwrap();

        match validate_path(&repo) {
            RepoValidation::Valid { info } => {
                assert!(info.current_branch.is_none());
                assert!(info.is_git_repo);
            }
            other => panic!("expected Valid, got {other:?}"),
        }
    }

    #[test]
    fn repo_validation_serializes_as_tagged_union() {
        let dir = tempdir().unwrap();
        init_git_dir(dir.path(), "main");
        let v = validate_path(dir.path());
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(json["valid"], true);
        assert_eq!(json["info"]["isGitRepo"], true);
        assert_eq!(json["info"]["currentBranch"], "main");

        let invalid = RepoValidation::Invalid {
            reason: RepoInvalidReason::NotAGitRepo,
        };
        let json = serde_json::to_value(&invalid).unwrap();
        assert_eq!(json["valid"], false);
        assert_eq!(json["reason"], "not_a_git_repo");
    }
}
