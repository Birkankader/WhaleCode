# Phase 5: Worktree Isolation + Conflict Detection - Research

**Researched:** 2026-03-06
**Domain:** Git worktree lifecycle management, merge conflict detection
**Confidence:** HIGH

## Summary

Phase 5 requires building a git worktree manager that creates isolated working directories per tool task, detects file-level conflicts between concurrent worktrees before any merge to main, and cleans up abandoned worktrees on crash recovery. The core technology is the `git2` Rust crate (v0.20.4), which provides native libgit2 bindings for worktree creation, listing, pruning, and merge-tree conflict simulation -- all without shelling out to the git CLI.

The conflict detection strategy uses `repo.merge_trees()` to perform a read-only three-way merge between worktree branch tips. The resulting `Index` exposes `has_conflicts()` and `conflicts()` iterator to identify exactly which files conflict. This approach is proven by tools like Clash (Rust, 2025) and is 100% read-only -- no repository state is modified during detection. The worktree lifecycle (create -> run tool -> detect conflicts -> report -> cleanup) integrates cleanly into the existing process manager by wrapping `spawn_with_env` with a worktree-aware layer that sets `cwd` to the worktree path.

**Primary recommendation:** Use `git2` crate for all git operations (worktree CRUD, merge-tree conflict detection, branch management). Shell out to `git` CLI only as a fallback for `worktree add` if `git2`'s `repo.worktree()` proves insufficient. Keep worktree metadata in AppState alongside process entries so the conflict checker can enumerate active worktrees at any time.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PROC-04 | Each tool process runs in its own git worktree, isolated from other tools | WorktreeManager creates dedicated worktree per task via git2; spawn_with_env gets worktree path as cwd |
| SAFE-03 | App detects when two tools have modified the same file and alerts the user | merge_trees() three-way merge simulation with has_conflicts() + conflicts() iterator identifies overlapping files |
| SAFE-04 | Conflict detection happens before merge back to main branch | ConflictDetector runs as a pre-merge gate; merge IPC command calls detect first, blocks on conflict |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| git2 | 0.20.4 | All git operations: worktree CRUD, merge-tree, branch ops | Official Rust libgit2 bindings, maintained by rust-lang org, no CLI dependency |
| rusqlite | 0.38 (existing) | Worktree metadata persistence for crash recovery | Already in project, proven in Phase 4 |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| uuid | 1 (existing) | Unique worktree/branch names | Already in project |
| chrono | 0.4 (existing) | Timestamps for worktree creation tracking | Already in project |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| git2 crate | std::process::Command("git") | CLI is simpler for worktree add but harder for merge-tree simulation; git2 is all-in-one |
| git2 merge_trees | gix crate | gix is pure Rust (no C deps) but heavier API surface; git2 is more mature and better documented |

**Installation:**
```bash
cd src-tauri && cargo add git2@0.20 --features vendored
```

Note: Use `vendored` feature to bundle libgit2 C library (avoids system dependency). This is standard practice for Tauri apps.

## Architecture Patterns

### Recommended Project Structure
```
src-tauri/src/
├── worktree/
│   ├── mod.rs           # Module exports
│   ├── manager.rs       # WorktreeManager: create, remove, list, cleanup
│   ├── conflict.rs      # ConflictDetector: merge-tree simulation, file overlap detection
│   └── models.rs        # WorktreeEntry, ConflictReport, ConflictFile
├── commands/
│   └── worktree.rs      # IPC commands: create_worktree, check_conflicts, merge_worktree, cleanup_worktrees
```

### Pattern 1: Worktree Lifecycle Manager
**What:** A `WorktreeManager` struct that wraps git2::Repository and manages the full lifecycle of worktrees -- creation, tracking, conflict checking, and cleanup.
**When to use:** Every time a tool task is dispatched.
**Example:**
```rust
// Source: git2 docs + git2-rs/src/worktree.rs test patterns
use git2::{Repository, WorktreeAddOptions};
use std::path::PathBuf;

pub struct WorktreeEntry {
    pub task_id: String,
    pub worktree_name: String,
    pub branch_name: String,
    pub path: PathBuf,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

pub struct WorktreeManager {
    repo_path: PathBuf,
}

impl WorktreeManager {
    /// Create a new worktree for a task
    pub fn create_for_task(&self, task_id: &str) -> Result<WorktreeEntry, String> {
        let repo = Repository::open(&self.repo_path).map_err(|e| e.to_string())?;
        let worktree_name = format!("whalecode-{}", &task_id[..8]);
        let branch_name = format!("whalecode/task/{}", &task_id[..8]);
        let worktree_path = self.repo_path.join("..").join(".whalecode-worktrees").join(&worktree_name);

        // Create branch from HEAD
        let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
        let branch = repo.branch(&branch_name, &head_commit, false).map_err(|e| e.to_string())?;

        // Create worktree with options
        let mut opts = WorktreeAddOptions::new();
        let branch_ref = branch.into_reference();
        opts.reference(Some(&branch_ref));
        repo.worktree(&worktree_name, &worktree_path, Some(&opts))
            .map_err(|e| e.to_string())?;

        Ok(WorktreeEntry {
            task_id: task_id.to_string(),
            worktree_name,
            branch_name,
            path: worktree_path,
            created_at: chrono::Utc::now(),
        })
    }
}
```

### Pattern 2: Pre-Merge Conflict Detection via merge_trees
**What:** Before allowing a worktree's changes to merge back to main, simulate the merge using `repo.merge_trees()` and check for conflicts.
**When to use:** After a tool task completes, before the user can merge.
**Example:**
```rust
// Source: git2-rs/examples/pull.rs + git2 docs
use git2::{Repository, MergeOptions};

pub struct ConflictFile {
    pub path: String,
}

pub struct ConflictReport {
    pub has_conflicts: bool,
    pub conflicting_files: Vec<ConflictFile>,
    pub worktree_a: String,
    pub worktree_b: String,
}

/// Check if two worktree branches would conflict when merged to main
pub fn detect_conflicts(
    repo: &Repository,
    branch_a: &str,
    branch_b: &str,
) -> Result<ConflictReport, String> {
    let commit_a = repo.revparse_single(branch_a)
        .map_err(|e| e.to_string())?
        .peel_to_commit()
        .map_err(|e| e.to_string())?;
    let commit_b = repo.revparse_single(branch_b)
        .map_err(|e| e.to_string())?
        .peel_to_commit()
        .map_err(|e| e.to_string())?;

    // Find common ancestor (merge base)
    let merge_base = repo.merge_base(commit_a.id(), commit_b.id())
        .map_err(|e| e.to_string())?;
    let ancestor = repo.find_commit(merge_base)
        .map_err(|e| e.to_string())?
        .tree()
        .map_err(|e| e.to_string())?;

    let tree_a = commit_a.tree().map_err(|e| e.to_string())?;
    let tree_b = commit_b.tree().map_err(|e| e.to_string())?;

    // Simulate three-way merge (read-only!)
    let index = repo.merge_trees(&ancestor, &tree_a, &tree_b, None)
        .map_err(|e| e.to_string())?;

    let mut conflicting_files = Vec::new();
    if index.has_conflicts() {
        let conflicts = index.conflicts().map_err(|e| e.to_string())?;
        for conflict in conflicts {
            let conflict = conflict.map_err(|e| e.to_string())?;
            // Each conflict has ancestor, our, their entries
            let path = conflict.our
                .or(conflict.their)
                .or(conflict.ancestor)
                .map(|e| String::from_utf8_lossy(&e.path).to_string())
                .unwrap_or_default();
            conflicting_files.push(ConflictFile { path });
        }
    }

    Ok(ConflictReport {
        has_conflicts: !conflicting_files.is_empty(),
        conflicting_files,
        worktree_a: branch_a.to_string(),
        worktree_b: branch_b.to_string(),
    })
}
```

### Pattern 3: Crash Recovery via Stale Worktree Detection
**What:** On app startup, scan for worktrees created by WhaleCode that no longer have an active process, and clean them up.
**When to use:** In `tauri::Builder::setup()` during app initialization.
**Example:**
```rust
// Source: git2 Worktree::validate() + prune() docs
pub fn cleanup_stale_worktrees(repo_path: &std::path::Path) -> Result<Vec<String>, String> {
    let repo = Repository::open(repo_path).map_err(|e| e.to_string())?;
    let worktrees = repo.worktrees().map_err(|e| e.to_string())?;
    let mut cleaned = Vec::new();

    for name in worktrees.iter() {
        let name = name.unwrap_or("");
        if !name.starts_with("whalecode-") {
            continue; // Not ours
        }
        if let Ok(wt) = repo.find_worktree(name) {
            // validate() fails if worktree dir is missing or corrupt
            if wt.validate().is_err() || wt.is_prunable(None).unwrap_or(false) {
                let mut opts = git2::WorktreePruneOptions::new();
                // Force prune even if worktree has changes (it's abandoned)
                if let Ok(()) = wt.prune(Some(&mut opts)) {
                    cleaned.push(name.to_string());
                }
            }
        }
    }

    Ok(cleaned)
}
```

### Pattern 4: Integration with Process Manager
**What:** Wrap the existing `spawn_with_env` call so the tool runs inside a worktree.
**When to use:** In the `spawn_claude_task` command (and future tool commands).
**Example:**
```rust
// In commands/claude.rs - modified spawn flow:
// 1. Create worktree for this task
// 2. Set cwd to worktree path (instead of project_dir)
// 3. Spawn tool process in worktree
// 4. On task completion, check conflicts before allowing merge

// The key change: project_dir -> worktree_path in the spawn call
crate::process::manager::spawn_with_env(
    &cmd.cmd,
    &args,
    worktree_entry.path.to_str().unwrap(), // <-- worktree path, not project_dir
    &env_refs,
    on_event,
    state,
)
.await
```

### Anti-Patterns to Avoid
- **Shelling out to `git worktree add`:** Loses error handling granularity, harder to test, adds PATH dependency. Use git2 native API.
- **Checking conflicts after merge:** Defeats the entire purpose of SAFE-04. Conflict detection MUST run as a gate BEFORE merge.
- **Worktrees in the project directory:** Place worktrees in a sibling directory (e.g., `../.whalecode-worktrees/`) to avoid cluttering the project and confusing IDEs.
- **Global worktree state only in memory:** If the app crashes, in-memory state is lost. Persist worktree entries to SQLite so crash recovery knows what to clean up.
- **Locking the main branch during tool execution:** Kills parallelism. Worktrees exist precisely so multiple tools can work simultaneously.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Three-way merge conflict detection | Custom file diff comparison | git2 `merge_trees()` + `has_conflicts()` | Handles binary files, renames, mode changes, encoding |
| Worktree creation/cleanup | Manual directory + .git file management | git2 `repo.worktree()` + `wt.prune()` | Git internal refs, HEAD management, lock files are complex |
| Branch management per worktree | Manual ref manipulation | git2 `repo.branch()` + `WorktreeAddOptions::reference()` | Reflog, symref updates, packed-refs |
| Merge base finding | Walking commit graph manually | git2 `repo.merge_base()` | Handles octopus merges, criss-cross, graph complexity |

**Key insight:** Git internals are a minefield of edge cases (packed refs, shallow clones, submodules, symlinks). The git2 crate handles all of these; hand-rolling any git operation is a guaranteed source of subtle bugs.

## Common Pitfalls

### Pitfall 1: Worktree Path Already Exists
**What goes wrong:** `repo.worktree()` fails if the target directory already exists (from a previous crash).
**Why it happens:** App crashed between creating the directory and registering the worktree, or user manually created the directory.
**How to avoid:** Before creating a worktree, check if the path exists. If it does, try to prune the old worktree first, then remove the directory.
**Warning signs:** "worktree already exists" or "path already exists" errors from git2.

### Pitfall 2: Branch Already Checked Out
**What goes wrong:** Git prevents the same branch from being checked out in multiple worktrees simultaneously.
**Why it happens:** Worktree was not properly cleaned up, or branch name collision.
**How to avoid:** Use unique branch names per task (include task_id). On cleanup, delete the branch after pruning the worktree.
**Warning signs:** "already checked out" error from git2.

### Pitfall 3: Worktree on Detached HEAD
**What goes wrong:** If the main repo is on a detached HEAD, creating a worktree branch from HEAD succeeds but merge-base calculations can fail.
**Why it happens:** User checked out a specific commit rather than a branch.
**How to avoid:** Always resolve HEAD to the default branch (main/master) when calculating merge bases. Store the base branch name in WorktreeEntry.
**Warning signs:** "no merge base found" errors.

### Pitfall 4: Large Repos and Worktree Creation Time
**What goes wrong:** Creating a worktree triggers a checkout, which for large repos can take seconds.
**Why it happens:** Git must copy/link the working tree files.
**How to avoid:** Create worktrees asynchronously (spawn_blocking). Show a "preparing workspace" status in the UI while the worktree is being set up.
**Warning signs:** UI freeze when dispatching a task.

### Pitfall 5: Conflict Detection on Uncommitted Changes
**What goes wrong:** `merge_trees()` works on committed trees, not the working directory. If a tool has modified files but not committed them, conflicts won't be detected.
**Why it happens:** AI tools (Claude Code, Gemini) typically commit their changes, but if they don't, the worktree has uncommitted modifications.
**How to avoid:** After a tool completes, auto-commit any uncommitted changes in the worktree before running conflict detection. Use a "whalecode auto-commit" message.
**Warning signs:** Conflict detection reports "no conflicts" but manual inspection shows overlapping file changes.

### Pitfall 6: Worktree Cleanup Deletes Unmerged Work
**What goes wrong:** Pruning a worktree with unmerged changes silently discards those changes.
**Why it happens:** `prune()` removes the worktree directory without checking for uncommitted work.
**How to avoid:** Before pruning, check if the worktree branch has commits not in main. Warn the user if unmerged work exists. Only auto-prune truly stale/abandoned worktrees (those without active processes AND older than a threshold).
**Warning signs:** User complains about lost work after a crash recovery.

## Code Examples

### Opening a Repository and Listing Worktrees
```rust
// Source: git2 docs
use git2::Repository;

let repo = Repository::open("/path/to/project")?;
let worktrees = repo.worktrees()?;
for name in worktrees.iter() {
    if let Some(name) = name {
        let wt = repo.find_worktree(name)?;
        println!("Worktree: {} at {:?}", name, wt.path());
        match wt.validate() {
            Ok(()) => println!("  Status: valid"),
            Err(e) => println!("  Status: invalid - {}", e),
        }
    }
}
```

### Fast-Forward Merge of Worktree Branch to Main
```rust
// Source: git2 docs + pull.rs example
pub fn fast_forward_merge(
    repo: &Repository,
    branch_name: &str,
) -> Result<(), String> {
    let branch_commit = repo.revparse_single(branch_name)
        .map_err(|e| e.to_string())?
        .peel_to_commit()
        .map_err(|e| e.to_string())?;

    let mut main_ref = repo.find_reference("refs/heads/main")
        .or_else(|_| repo.find_reference("refs/heads/master"))
        .map_err(|e| e.to_string())?;

    // Check if fast-forward is possible
    let main_commit = main_ref.peel_to_commit().map_err(|e| e.to_string())?;
    if !repo.graph_descendant_of(branch_commit.id(), main_commit.id())
        .unwrap_or(false)
    {
        return Err("Cannot fast-forward: branch has diverged from main".to_string());
    }

    main_ref.set_target(branch_commit.id(), "whalecode: merge task branch")
        .map_err(|e| e.to_string())?;

    Ok(())
}
```

### IPC Command for Conflict Check (Frontend-Facing)
```rust
// Tauri command that the frontend calls before allowing merge
#[tauri::command]
#[specta::specta]
pub async fn check_worktree_conflicts(
    task_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<ConflictReport, String> {
    // Look up worktree entry for this task
    // Compare its branch against all other active worktree branches
    // Return ConflictReport with file-level details
    todo!()
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Single working directory per agent | Git worktree per agent | 2024-2025 (Claude Code, Codex) | Enables true parallel execution without file conflicts |
| Post-merge conflict detection | Pre-merge conflict simulation via merge-tree | 2025 (Clash tool) | Catches conflicts before wasted merge effort |
| Manual worktree management | Automated lifecycle with crash recovery | 2025-2026 | Required for production-grade multi-agent orchestration |

**Deprecated/outdated:**
- `git stash` for isolation: Doesn't work for parallel execution; stashes are sequential
- File-level locking: Too coarse-grained; prevents legitimate non-conflicting edits to different parts of same file

## Open Questions

1. **Worktree storage location**
   - What we know: Worktrees should not be inside the project directory
   - What's unclear: Best location -- sibling directory vs. temp directory vs. app data directory
   - Recommendation: Use `{project_dir}/../.whalecode-worktrees/{task-id}` for proximity to project. If project is at filesystem root, fall back to app data directory.

2. **Auto-commit strategy for uncommitted tool changes**
   - What we know: merge_trees needs committed trees; tools may leave uncommitted changes
   - What's unclear: Whether Claude Code always commits its changes or sometimes leaves them uncommitted
   - Recommendation: After tool exit, check for uncommitted changes in worktree. If found, create an auto-commit. This ensures conflict detection always has committed state to work with.

3. **Pairwise vs. hub-and-spoke conflict detection**
   - What we know: Clash does pairwise (N^2) checks between all worktrees
   - What's unclear: Whether we need pairwise or just each-vs-main
   - Recommendation: Start with each-worktree-vs-main (simpler, O(N)). If two worktrees both conflict with main in the same file, that's also a worktree-to-worktree conflict. Pairwise can be added later if needed.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Rust: cargo test; Frontend: vitest |
| Config file | src-tauri/Cargo.toml; vitest via package.json |
| Quick run command | `cd src-tauri && cargo test -- --lib worktree` |
| Full suite command | `cd src-tauri && cargo test && cd .. && npm test` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PROC-04 | Worktree created per task, tool runs inside it | unit + integration | `cd src-tauri && cargo test worktree::manager -x` | No -- Wave 0 |
| SAFE-03 | Overlapping file changes detected between worktrees | unit | `cd src-tauri && cargo test worktree::conflict -x` | No -- Wave 0 |
| SAFE-04 | Conflict check runs before merge, blocks on conflict | unit | `cd src-tauri && cargo test worktree::conflict::pre_merge -x` | No -- Wave 0 |
| CRASH | Stale worktrees cleaned on startup | unit | `cd src-tauri && cargo test worktree::manager::cleanup -x` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `cd src-tauri && cargo test -- --lib worktree`
- **Per wave merge:** `cd src-tauri && cargo test && cd .. && npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src-tauri/src/worktree/manager.rs` -- WorktreeManager tests (create, cleanup, list)
- [ ] `src-tauri/src/worktree/conflict.rs` -- ConflictDetector tests (merge_trees, has_conflicts)
- [ ] `src-tauri/src/worktree/models.rs` -- WorktreeEntry, ConflictReport serialization
- [ ] Test helper: create temporary git repos with known file structures for deterministic conflict testing
- [ ] Framework install: `cargo add git2@0.20 --features vendored` (in Cargo.toml)

## Sources

### Primary (HIGH confidence)
- [git2 Repository docs](https://docs.rs/git2/latest/git2/struct.Repository.html) - worktree(), worktrees(), merge_trees(), merge_base() methods
- [git2 Worktree docs](https://docs.rs/git2/latest/git2/struct.Worktree.html) - validate(), prune(), is_prunable(), lock/unlock
- [git2 Index docs](https://docs.rs/git2/latest/git2/struct.Index.html) - has_conflicts(), conflicts(), conflict_get()
- [git2-rs examples/pull.rs](https://github.com/rust-lang/git2-rs/blob/master/examples/pull.rs) - merge_trees conflict detection pattern
- [git2-rs src/worktree.rs](https://github.com/rust-lang/git2-rs/blob/master/src/worktree.rs) - WorktreeAddOptions, repo.worktree() creation pattern
- [git-scm worktree docs](https://git-scm.com/docs/git-worktree) - worktree prune, repair, list behaviors

### Secondary (MEDIUM confidence)
- [Clash (GitHub)](https://github.com/clash-sh/clash) - Rust tool using gix for pairwise worktree conflict detection; validates merge-tree approach
- [libgit2 git_worktree_add](https://libgit2.org/docs/reference/main/worktree/git_worktree_add.html) - C API that git2-rs wraps

### Tertiary (LOW confidence)
- Various blog posts on parallel AI agent worktree patterns (Medium, DEV Community) - community patterns, not authoritative

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - git2 is the de facto Rust git library, maintained by rust-lang org, v0.20.4 released Feb 2026
- Architecture: HIGH - patterns proven by Clash, Claude Code worktree support, and git2-rs test suite
- Pitfalls: HIGH - based on git2 API constraints (branch checkout exclusivity, validate/prune semantics) and real-world issues (stale worktrees in Claude Code issue #26725)
- Conflict detection: HIGH - merge_trees + has_conflicts is the standard approach used by GitHub Desktop, Clash, and other merge-preview tools

**Research date:** 2026-03-06
**Valid until:** 2026-04-06 (stable domain, git2 API unlikely to change)
