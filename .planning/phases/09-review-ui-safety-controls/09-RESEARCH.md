# Phase 9: Review UI + Safety Controls - Research

**Researched:** 2026-03-06
**Domain:** Git diff generation (Rust/git2), React diff rendering, selective file-level merge
**Confidence:** HIGH

## Summary

Phase 9 implements the final two requirements (SAFE-01, SAFE-02): a unified diff view for reviewing tool-generated changes, and file-level accept/reject before merging to main. The existing codebase already has the complete worktree and merge infrastructure (Phase 5), conflict detection (SAFE-03/04), and status panel (SAFE-05/06). This phase adds a review gate between task completion and merge.

The technical challenge breaks into two parts: (1) a Rust backend command using git2's `diff_tree_to_tree` to generate per-file unified diffs between a worktree branch and the default branch, and (2) a React frontend component that renders these diffs and lets users accept/reject individual files. The existing `merge_worktree` command must be modified to accept a list of accepted file paths, building a selective tree rather than doing a full fast-forward merge.

**Primary recommendation:** Use git2's `Diff::tree_to_tree` + `print(DiffFormat::Patch)` for diff generation on the backend, render diffs with a custom lightweight component using `<pre>` with line-level coloring (no external diff library needed since the backend provides unified diff text), and modify `merge_worktree` to accept an optional file filter for selective merging.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SAFE-01 | User can view unified diff of all changes made by a tool before committing | git2 `diff_tree_to_tree` generates per-file unified diffs; new `get_worktree_diff` IPC command returns structured diff data; DiffReview component renders diffs |
| SAFE-02 | User can accept or reject changes at file level | Modified `merge_worktree` accepts `accepted_files: Vec<String>` parameter; builds selective tree from accepted files only; rejected files stay on worktree branch |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| git2 | 0.20 | Diff generation, selective tree building | Already in project; `diff_tree_to_tree` + `Diff::print(Patch)` is the canonical way to get unified diffs |
| React | 19.1 | Diff viewer UI | Already in project |
| zustand | 5.x | Review state management | Already in project for task/process stores |
| tauri-specta | rc.21 | Type-safe IPC for diff data | Already in project |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none needed) | - | - | The backend generates unified diff text; rendering colored `<pre>` blocks requires zero external diff libraries |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Custom diff renderer | react-diff-viewer-continued | Adds 200KB+ dependency; requires oldValue/newValue text pairs (not unified diff input); overkill for read-only file diff display |
| git2 tree building | Shell out to `git checkout` | Breaks the all-git2 pattern established in Phase 5; process spawning overhead |

**Installation:**
```bash
# No new dependencies needed
```

## Architecture Patterns

### Recommended Project Structure
```
src-tauri/src/
  commands/
    worktree.rs          # Add get_worktree_diff, modify merge_worktree
  worktree/
    diff.rs              # NEW: diff generation logic
    mod.rs               # Add pub mod diff

src/
  components/
    review/
      DiffReview.tsx     # Main review panel (file list + diff view)
      FileDiffView.tsx   # Single file unified diff renderer
  hooks/
    useWorktree.ts       # Add getWorktreeDiff, selective merge methods
  stores/
    taskStore.ts         # Add 'review' status to TaskStatus type
```

### Pattern 1: Backend Diff Generation
**What:** A new IPC command `get_worktree_diff` that compares a worktree branch against the default branch and returns structured per-file diff data.
**When to use:** When a tool task completes and user wants to review changes before merging.
**Example:**
```rust
// Source: git2 docs (docs.rs/git2/0.20) + existing conflict.rs pattern
use git2::{Diff, DiffFormat, DiffOptions, Repository};

#[derive(Debug, Clone, Serialize, Type)]
pub struct FileDiff {
    pub path: String,
    pub status: String,        // "added", "modified", "deleted", "renamed"
    pub old_path: Option<String>, // for renames
    pub patch: String,         // unified diff text for this file
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct WorktreeDiffReport {
    pub branch_name: String,
    pub default_branch: String,
    pub files: Vec<FileDiff>,
    pub total_additions: u32,
    pub total_deletions: u32,
}

pub fn generate_worktree_diff(
    repo_path: &Path,
    branch_name: &str,
) -> Result<WorktreeDiffReport, String> {
    let repo = Repository::open(repo_path).map_err(|e| e.to_string())?;
    let default_branch = find_default_branch(&repo)?;

    // Get trees for both branches
    let default_commit = repo.revparse_single(&default_branch)
        .map_err(|e| e.to_string())?
        .peel_to_commit().map_err(|e| e.to_string())?;
    let branch_commit = repo.revparse_single(branch_name)
        .map_err(|e| e.to_string())?
        .peel_to_commit().map_err(|e| e.to_string())?;

    let default_tree = default_commit.tree().map_err(|e| e.to_string())?;
    let branch_tree = branch_commit.tree().map_err(|e| e.to_string())?;

    // Generate diff: default -> branch (shows what the tool changed)
    let mut opts = DiffOptions::new();
    opts.context_lines(3);
    let diff = repo.diff_tree_to_tree(
        Some(&default_tree), Some(&branch_tree), Some(&mut opts)
    ).map_err(|e| e.to_string())?;

    // Iterate deltas to build per-file diffs
    let mut files = Vec::new();
    for (idx, delta) in diff.deltas().enumerate() {
        let path = delta.new_file().path()
            .unwrap_or(delta.old_file().path().unwrap_or(Path::new("unknown")))
            .to_string_lossy().to_string();

        // Get patch text for this specific file
        let mut patch_text = String::new();
        if let Ok(patch) = git2::Patch::from_diff(&diff, idx) {
            if let Some(patch) = patch {
                let buf = patch.to_buf().map_err(|e| e.to_string())?;
                patch_text = String::from_utf8_lossy(&buf).to_string();
            }
        }

        let status = match delta.status() {
            git2::Delta::Added => "added",
            git2::Delta::Deleted => "deleted",
            git2::Delta::Modified => "modified",
            git2::Delta::Renamed => "renamed",
            _ => "modified",
        };

        let (additions, deletions) = count_lines(&patch_text);

        files.push(FileDiff {
            path,
            status: status.to_string(),
            old_path: if delta.status() == git2::Delta::Renamed {
                delta.old_file().path().map(|p| p.to_string_lossy().to_string())
            } else { None },
            patch: patch_text,
            additions,
            deletions,
        });
    }

    // ... build and return WorktreeDiffReport
}
```

### Pattern 2: Selective File Merge
**What:** Modified `merge_worktree` that accepts a list of accepted file paths. Instead of fast-forwarding the entire branch, it builds a new tree containing only the accepted files from the worktree branch, merged with the default branch tree.
**When to use:** When user has reviewed diffs and accepted some files but rejected others.
**Example:**
```rust
// Build a new tree with selective file inclusion
// For each accepted file: use the version from the worktree branch tree
// For each rejected file: keep the version from the default branch tree
// Create a new commit with this selective tree on the default branch

pub fn selective_merge(
    repo: &Repository,
    default_tree: &Tree,
    branch_tree: &Tree,
    accepted_files: &[String],
    default_branch: &str,
    branch_name: &str,
) -> Result<(), String> {
    let mut builder = repo.treebuilder(Some(default_tree))
        .map_err(|e| e.to_string())?;

    for file_path in accepted_files {
        // Find the entry in the branch tree
        if let Ok(entry) = branch_tree.get_path(Path::new(file_path)) {
            builder.insert(file_path, entry.id(), entry.filemode() as i32)
                .map_err(|e| e.to_string())?;
        }
        // Handle deletions: if file exists in default but not in branch,
        // and user accepted the deletion, remove from builder
    }

    let new_tree_id = builder.write().map_err(|e| e.to_string())?;
    let new_tree = repo.find_tree(new_tree_id).map_err(|e| e.to_string())?;

    // Create merge commit on default branch
    // ...
}
```

### Pattern 3: Review State Flow
**What:** TaskStore gets a new `'review'` status. When a tool task completes, status transitions to `'review'` instead of immediately allowing merge. The DiffReview panel appears for tasks in review state.
**When to use:** Every task completion triggers review flow.
**Flow:**
```
running -> completed -> review (user opens diff) -> merged | partial-merged
                                                  -> (user can also dismiss/discard)
```

### Anti-Patterns to Avoid
- **Generating diffs on the frontend:** Never send file contents over IPC and diff client-side. git2 is already available on the backend and generates diffs efficiently.
- **Full branch fast-forward when files are rejected:** The existing `merge_worktree` does a full FF merge. When some files are rejected, this must NOT be used -- selective tree building is required.
- **Auto-merge after task completion:** Requirement explicitly states "no change is ever committed without explicit user action." The merge button must only appear after review.
- **Storing diff results in SQLite:** Diffs are ephemeral and re-computable. Generate on demand, do not persist.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Unified diff generation | Custom text diffing | git2 `diff_tree_to_tree` + `Patch::to_buf()` | git2 handles all edge cases: binary files, renames, mode changes, empty files |
| Tree manipulation for selective merge | Manual file copying between worktrees | git2 `TreeBuilder` | Atomic operation, no filesystem side effects, handles nested paths |
| Diff text parsing for coloring | Regex-based line parser | Simple startsWith('+'/'-'/' ') check | Unified diff format is trivially parseable for display coloring |

**Key insight:** The backend (git2) does all the heavy lifting. The frontend is purely a display and selection layer -- it receives pre-formatted unified diff text and renders it with syntax coloring by line prefix.

## Common Pitfalls

### Pitfall 1: TreeBuilder Doesn't Handle Nested Paths
**What goes wrong:** `TreeBuilder::insert` works on flat entries within a single tree level. Nested paths like `src/commands/worktree.rs` require recursive tree building.
**Why it happens:** Git trees are hierarchical -- each directory is its own tree object.
**How to avoid:** For selective merge, use `repo.index()` to build the merge result. Copy the default branch index, then overwrite entries for accepted files from the worktree branch index. This handles nesting automatically.
**Warning signs:** Files in subdirectories silently missing after selective merge.

### Pitfall 2: Auto-Commit Timing
**What goes wrong:** `get_worktree_diff` shows stale diffs if the tool made changes that weren't auto-committed.
**Why it happens:** Tools write to the worktree filesystem but may not git-commit before the diff is requested.
**How to avoid:** Always call `auto_commit_worktree` before generating diffs, same pattern used in `check_worktree_conflicts`.
**Warning signs:** User sees empty diff even though tool made changes.

### Pitfall 3: Specta Type Constraints
**What goes wrong:** New types fail to serialize through tauri-specta.
**Why it happens:** specta requires `Type` derive on all IPC types; String is preferred over PathBuf for paths.
**How to avoid:** Use `String` for all path fields (not `PathBuf`); use `u32` not `usize` for numeric fields. Follow existing patterns in `models.rs`.
**Warning signs:** Compile errors mentioning `BigIntForbidden` or missing `Type` impl.

### Pitfall 4: Large Diffs Causing UI Lag
**What goes wrong:** A tool modifies hundreds of files or generates very large patches; IPC serialization and DOM rendering become slow.
**Why it happens:** Unified diff text for large files can be 100KB+ per file.
**How to avoid:** Truncate patch text for individual files beyond a threshold (e.g., 50KB) with a "diff too large" message. Paginate the file list. Consider lazy rendering -- only render visible file diffs.
**Warning signs:** UI freezes when opening diff review for a large task.

### Pitfall 5: Merge After Partial Accept Creates Orphan Changes
**What goes wrong:** User accepts some files, rejects others. The worktree branch still contains all changes. If the user later merges the same worktree, rejected files get included.
**Why it happens:** Selective merge creates a new commit on default branch but doesn't modify the worktree branch.
**How to avoid:** After a selective merge, clean up the worktree entirely (remove worktree + branch). Rejected changes are intentionally discarded. Make this clear in the UI with a confirmation dialog.
**Warning signs:** Previously rejected changes appearing in a later merge.

## Code Examples

### IPC Command: Get Worktree Diff
```rust
// Source: existing worktree.rs command pattern + git2 Diff API
#[tauri::command]
#[specta::specta]
pub async fn get_worktree_diff(
    project_dir: String,
    branch_name: String,
) -> Result<WorktreeDiffReport, String> {
    let project_path = std::path::PathBuf::from(project_dir);
    let branch = branch_name.clone();
    tokio::task::spawn_blocking(move || {
        // Auto-commit any pending changes first
        let manager = WorktreeManager::new(project_path.clone());
        let base_dir = manager.worktree_base_dir();
        if let Some(prefix) = branch.strip_prefix("whalecode/task/") {
            let wt_path = base_dir.join(format!("whalecode-{}", prefix));
            if wt_path.exists() {
                let _ = conflict::auto_commit_worktree(&wt_path);
            }
        }
        diff::generate_worktree_diff(&project_path, &branch)
    })
    .await
    .map_err(|e| format!("Diff task failed: {}", e))?
}
```

### IPC Command: Selective Merge
```rust
// Modified merge_worktree signature
#[tauri::command]
#[specta::specta]
pub async fn merge_worktree(
    project_dir: String,
    branch_name: String,
    accepted_files: Option<Vec<String>>, // None = accept all (backward compat)
) -> Result<(), String> {
    // ... existing conflict checks ...
    // If accepted_files is Some, do selective merge
    // If accepted_files is None, do full fast-forward (existing behavior)
}
```

### Frontend: Diff Line Renderer
```typescript
// Simple unified diff line renderer -- no library needed
function DiffLine({ line }: { line: string }) {
  let className = 'text-zinc-300'; // context line
  if (line.startsWith('+')) {
    className = 'text-green-400 bg-green-900/20';
  } else if (line.startsWith('-')) {
    className = 'text-red-400 bg-red-900/20';
  } else if (line.startsWith('@@')) {
    className = 'text-cyan-400 bg-cyan-900/10';
  } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
    className = 'text-zinc-500';
  }

  return (
    <div className={`px-4 font-mono text-xs leading-5 whitespace-pre ${className}`}>
      {line}
    </div>
  );
}
```

### Frontend: File Accept/Reject Toggle
```typescript
// Per-file checkbox in the file list sidebar
function FileEntry({
  file,
  accepted,
  onToggle,
}: {
  file: FileDiff;
  accepted: boolean;
  onToggle: () => void;
}) {
  const statusIcon = {
    added: '+',
    modified: 'M',
    deleted: 'D',
    renamed: 'R',
  }[file.status] ?? '?';

  const statusColor = {
    added: 'text-green-400',
    modified: 'text-yellow-400',
    deleted: 'text-red-400',
    renamed: 'text-blue-400',
  }[file.status] ?? 'text-zinc-400';

  return (
    <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-800/50 cursor-pointer">
      <input
        type="checkbox"
        checked={accepted}
        onChange={onToggle}
        className="rounded border-zinc-600"
      />
      <span className={`text-xs font-mono w-4 ${statusColor}`}>{statusIcon}</span>
      <span className="text-xs font-mono text-zinc-300 truncate">{file.path}</span>
      <span className="text-xs text-zinc-600 ml-auto">
        +{file.additions} -{file.deletions}
      </span>
    </label>
  );
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Shell out to `git diff` | git2 `diff_tree_to_tree` | git2 0.14+ | No subprocess overhead, full control over output format |
| react-diff-viewer (unmaintained) | react-diff-viewer-continued | 2023 | Fork with active maintenance, React 18/19 support |
| Full branch merge only | Selective tree/index merge | Always available in git2 | Enables per-file accept/reject without cherry-pick complexity |

**Deprecated/outdated:**
- react-diff-viewer (original): Last published 6 years ago, unmaintained. Use react-diff-viewer-continued if an external library is needed, but for this use case custom rendering is simpler.

## Open Questions

1. **What happens to rejected files after selective merge?**
   - What we know: The worktree branch still contains all files. The selective merge only applies accepted files to the default branch.
   - What's unclear: Should the worktree be cleaned up immediately, or should the user be able to re-review?
   - Recommendation: Clean up worktree after any merge (full or selective). Rejected changes are discarded. Show a confirmation dialog: "X files will be discarded. Continue?"

2. **Should the review panel be a modal or inline?**
   - What we know: The existing UI uses the modal overlay pattern for settings and inline panels for prompt preview.
   - What's unclear: Diff review is a large, content-heavy view that benefits from full-screen space.
   - Recommendation: Use a full-height panel that replaces the terminal output area when in review mode (similar to how ProcessPanel already manages visibility). Not a modal -- users need space to read diffs.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework (Rust) | cargo test (built-in) |
| Framework (Frontend) | vitest 2.x with jsdom |
| Config file (Rust) | Cargo.toml [dev-dependencies] |
| Config file (Frontend) | vite.config.ts test section |
| Quick run command (Rust) | `cd src-tauri && cargo test worktree --lib` |
| Quick run command (Frontend) | `npx vitest run src/tests/` |
| Full suite command | `cd src-tauri && cargo test && cd .. && npx vitest run` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SAFE-01 | generate_worktree_diff returns per-file patches | unit (Rust) | `cd src-tauri && cargo test diff::tests -x` | No -- Wave 0 |
| SAFE-01 | DiffReview renders file list and patch text | unit (Frontend) | `npx vitest run src/tests/review.test.tsx` | No -- Wave 0 |
| SAFE-02 | selective merge applies only accepted files | unit (Rust) | `cd src-tauri && cargo test diff::tests::selective -x` | No -- Wave 0 |
| SAFE-02 | merge_worktree with accepted_files param works | unit (Rust) | `cd src-tauri && cargo test worktree::merge -x` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `cd src-tauri && cargo test worktree --lib && cd .. && npx vitest run`
- **Per wave merge:** Full suite
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src-tauri/src/worktree/diff.rs` -- diff generation logic + tests
- [ ] `src/tests/review.test.tsx` -- DiffReview component tests
- [ ] Test helpers for creating repos with diverged branches (partially exists in `conflict.rs` tests -- reuse)

## Sources

### Primary (HIGH confidence)
- [git2 Diff struct docs](https://docs.rs/git2/latest/git2/struct.Diff.html) -- diff_tree_to_tree, print, deltas API
- [git2-rs diff example](https://github.com/rust-lang/git2-rs/blob/master/examples/diff.rs) -- tree resolution, DiffFormat::Patch usage
- [git2 DiffOptions](https://docs.rs/git2/latest/git2/struct.DiffOptions.html) -- context_lines configuration
- Existing codebase: `src-tauri/src/worktree/conflict.rs` -- established pattern for tree comparison with git2
- Existing codebase: `src-tauri/src/commands/worktree.rs` -- IPC command patterns, merge_worktree implementation

### Secondary (MEDIUM confidence)
- [react-diff-viewer-continued](https://github.com/Aeolun/react-diff-viewer-continued) -- evaluated but not recommended for this use case (takes oldValue/newValue, not unified diff input)

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries already in project, git2 diff API is well-documented
- Architecture: HIGH -- follows established patterns from Phase 5 (worktree commands, conflict detection)
- Pitfalls: HIGH -- identified from direct codebase analysis (specta constraints, auto-commit timing, tree nesting)

**Research date:** 2026-03-06
**Valid until:** 2026-04-06 (stable domain, no fast-moving dependencies)
