//! Local-only gitignore management.
//!
//! WhaleCode writes two paths inside the user's repo —
//! `.whalecode-worktrees/` (transient worktrees) and `.whalecode/`
//! (shared notes, templates). Neither should pollute `git status` or
//! make it into commits. But we also can't touch the user's
//! `.gitignore`: that file belongs to them, is tracked in git, and
//! modifying it would show up as a diff in the first commit after
//! WhaleCode ran.
//!
//! Git ships `.git/info/exclude` for exactly this case. It lives
//! inside `.git/`, is never committed, and git honors it alongside
//! `.gitignore`. We append our entries there on startup,
//! idempotently — existing entries are left alone, and calling twice
//! in a row produces the same file.

use std::path::Path;

use tokio::io::AsyncWriteExt;

/// Marker header we write on first touch so the entries are clearly
/// ours and a curious user opening the file sees why they're there.
const HEADER: &str = "# Added by WhaleCode — local-only, never committed.";

/// Ensure each entry in `entries` is present in
/// `{repo_root}/.git/info/exclude`. Creates the file if it doesn't
/// exist yet (git ships it by default on `git init`, but we don't
/// assume). Duplicate entries are not appended.
///
/// Match is byte-exact on trimmed lines: `"/foo"` and `"foo"` are
/// treated as different, which matches how git itself reads the
/// file. Callers should pick a form and stick with it.
pub async fn ensure_local_gitignore(
    repo_root: &Path,
    entries: &[&str],
) -> std::io::Result<()> {
    let info_dir = repo_root.join(".git").join("info");
    let exclude_path = info_dir.join("exclude");

    // `.git/info/` is standard but not strictly guaranteed — some
    // people run with GIT_DIR pointed elsewhere, or work inside a
    // worktree where `.git` is a pointer file. In those rare cases
    // we just skip — failing to add a local ignore is never worth
    // blocking WhaleCode startup.
    if !repo_root.join(".git").is_dir() {
        return Ok(());
    }
    tokio::fs::create_dir_all(&info_dir).await?;

    let existing = match tokio::fs::read_to_string(&exclude_path).await {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };

    let present: std::collections::HashSet<&str> = existing
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();

    let missing: Vec<&str> = entries
        .iter()
        .copied()
        .filter(|e| !present.contains(e))
        .collect();

    if missing.is_empty() {
        return Ok(());
    }

    // Open for append. Ensure a newline separator before our block
    // if the file's last byte isn't one — git tolerates either but
    // mixed endings look sloppy if the user opens the file.
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&exclude_path)
        .await?;

    let needs_leading_newline = !existing.is_empty() && !existing.ends_with('\n');
    let header_missing = !existing.contains(HEADER);

    let mut block = String::new();
    if needs_leading_newline {
        block.push('\n');
    }
    if header_missing {
        // Surround our header with blank lines if there's prior
        // content, so our block is visually separable.
        if !existing.is_empty() {
            block.push('\n');
        }
        block.push_str(HEADER);
        block.push('\n');
    }
    for entry in &missing {
        block.push_str(entry);
        block.push('\n');
    }

    file.write_all(block.as_bytes()).await?;
    file.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn fake_repo() -> (TempDir, std::path::PathBuf) {
        let td = tempfile::tempdir().unwrap();
        let path = td.path().to_path_buf();
        tokio::fs::create_dir_all(path.join(".git").join("info"))
            .await
            .unwrap();
        (td, path)
    }

    #[tokio::test]
    async fn creates_file_when_missing_and_appends_entries() {
        let (_td, repo) = fake_repo().await;
        ensure_local_gitignore(&repo, &[".whalecode-worktrees/", ".whalecode/"])
            .await
            .unwrap();
        let body = tokio::fs::read_to_string(repo.join(".git/info/exclude"))
            .await
            .unwrap();
        assert!(body.contains(".whalecode-worktrees/"));
        assert!(body.contains(".whalecode/"));
        assert!(body.contains("WhaleCode"));
    }

    #[tokio::test]
    async fn idempotent_second_call_is_noop() {
        let (_td, repo) = fake_repo().await;
        ensure_local_gitignore(&repo, &[".whalecode/"])
            .await
            .unwrap();
        let first = tokio::fs::read_to_string(repo.join(".git/info/exclude"))
            .await
            .unwrap();

        ensure_local_gitignore(&repo, &[".whalecode/"])
            .await
            .unwrap();
        let second = tokio::fs::read_to_string(repo.join(".git/info/exclude"))
            .await
            .unwrap();

        assert_eq!(first, second, "second call should not modify the file");
    }

    #[tokio::test]
    async fn appends_without_touching_existing_entries() {
        let (_td, repo) = fake_repo().await;
        let existing = "# user's own entries\nnode_modules/\nmy_secret.env\n";
        tokio::fs::write(repo.join(".git/info/exclude"), existing)
            .await
            .unwrap();

        ensure_local_gitignore(&repo, &[".whalecode/"])
            .await
            .unwrap();

        let body = tokio::fs::read_to_string(repo.join(".git/info/exclude"))
            .await
            .unwrap();
        // Original content still present verbatim at the start.
        assert!(body.starts_with(existing));
        // New entry appended.
        assert!(body.contains(".whalecode/"));
    }

    #[tokio::test]
    async fn skips_entries_already_present() {
        let (_td, repo) = fake_repo().await;
        let existing = ".whalecode/\n";
        tokio::fs::write(repo.join(".git/info/exclude"), existing)
            .await
            .unwrap();

        ensure_local_gitignore(&repo, &[".whalecode/", ".whalecode-worktrees/"])
            .await
            .unwrap();

        let body = tokio::fs::read_to_string(repo.join(".git/info/exclude"))
            .await
            .unwrap();
        // `.whalecode/` wasn't re-appended (still appears exactly once
        // as a whole-line entry — substring count works because
        // `.whalecode-worktrees/` doesn't contain the literal
        // `.whalecode/` with trailing slash).
        assert_eq!(body.matches(".whalecode/").count(), 1);
        assert!(body.contains(".whalecode-worktrees/"));
    }

    #[tokio::test]
    async fn missing_git_dir_is_noop() {
        let td = tempfile::tempdir().unwrap();
        // No `.git` dir — treat as "not a repo" and silently skip.
        let result = ensure_local_gitignore(td.path(), &[".whalecode/"]).await;
        assert!(result.is_ok());
        assert!(tokio::fs::metadata(td.path().join(".git/info/exclude"))
            .await
            .is_err());
    }
}
