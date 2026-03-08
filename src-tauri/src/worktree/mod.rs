pub mod models;
pub mod manager;
pub mod conflict;
pub mod diff;

/// Resolve a branch name (or commit-ish) to a commit.
///
/// Tries `find_branch` first (handles hierarchical names like `whalecode/task/abc`),
/// then falls back to `revparse_single` for commit hashes, tags, or remote branches.
pub fn resolve_branch_commit<'repo>(
    repo: &'repo git2::Repository,
    branch_name: &str,
) -> Result<git2::Commit<'repo>, String> {
    // Try local branch first (handles names with `/`)
    if let Ok(branch) = repo.find_branch(branch_name, git2::BranchType::Local) {
        return branch
            .into_reference()
            .peel_to_commit()
            .map_err(|e| format!("Failed to peel '{}' to commit: {}", branch_name, e));
    }
    // Fallback to revparse for commit hashes, tags, remote branches
    let obj = repo
        .revparse_single(branch_name)
        .map_err(|e| format!("Failed to resolve '{}': {}", branch_name, e))?;
    obj.peel_to_commit()
        .map_err(|e| format!("Failed to peel '{}' to commit: {}", branch_name, e))
}
