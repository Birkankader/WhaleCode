# Git View — Design Document

**Date:** 2026-03-13
**Status:** Approved

## Purpose

Add a full-screen "Git" tab to WhaleCode so users can see the git status of their project directory, stage/unstage files, commit with a message, pull, push, view inline diffs, and see recent commit history — all without leaving the app.

## Scope

- **Target repo:** The main project directory selected in SetupPanel (`projectDir`).
- **Worktree branches are out of scope** — those are handled in TaskDetail.

## Architecture

### Backend: Hybrid git2 + CLI

New module: `src-tauri/src/commands/git.rs`

| Command | Mechanism | Purpose |
|---------|-----------|---------|
| `git_status(project_dir)` → `GitStatusReport` | git2 | Branch, ahead/behind, staged/unstaged/untracked files |
| `git_stage_files(project_dir, paths)` → `()` | git2 | Add files to index |
| `git_unstage_files(project_dir, paths)` → `()` | git2 | Remove files from index |
| `git_commit(project_dir, message)` → `String` | git2 | Create commit, return short hash |
| `git_diff_file(project_dir, path)` → `String` | git2 | Unified diff for a single file |
| `git_pull(project_dir)` → `GitPullResult` | git CLI | Shell out to `git pull` |
| `git_push(project_dir)` → `GitPushResult` | git CLI | Shell out to `git push` |
| `git_log(project_dir, limit)` → `Vec<GitLogEntry>` | git2 | Recent commits with short hash, message, author, time |

**Rationale:** git2 for fast, type-safe local operations. CLI for push/pull where SSH/HTTPS auth is handled by the user's git credential helper.

### Data Types (specta-exported)

```rust
struct GitStatusReport {
    branch: String,
    ahead: u32,
    behind: u32,
    staged: Vec<GitFileEntry>,
    unstaged: Vec<GitFileEntry>,
    untracked: Vec<String>,
}

struct GitFileEntry {
    path: String,
    status: String,      // "modified" | "added" | "deleted" | "renamed"
    additions: u32,
    deletions: u32,
}

struct GitLogEntry {
    hash: String,        // 7-char short hash
    message: String,
    author: String,
    time_ago: String,    // relative time: "2 min ago"
}

struct GitPullResult {
    success: bool,
    message: String,
}

struct GitPushResult {
    success: bool,
    message: String,
}
```

### Frontend

**New view:** `src/components/views/GitView.tsx`

**Store additions** to `useUIStore`:
- `activeView` gains `'git'` variant

**Hook:** `src/hooks/useGitStatus.ts`
- Wraps all git commands
- Auto-refreshes on view mount and after mutations

**Tab bar:** "Git" tab added to header after "Usage"

## UI Layout

```
┌──────────────────────────────────────────────────┐
│ Branch: ● main   ▲ 3 ahead  ▼ 1 behind          │
│                                    [Pull] [Push] │
├──────────────────────────────────────────────────┤
│                                                  │
│ Staged Changes (2)                [Unstage All]  │
│ ┌──────────────────────────────────────────┐     │
│ │ ☑ M  src/orchestrator.rs        +15 -8  │     │
│ │ ☑ A  src/commands/git.rs        +120    │     │
│ └──────────────────────────────────────────┘     │
│                                                  │
│ Changes (4)                        [Stage All]   │
│ ┌──────────────────────────────────────────┐     │
│ │ ☐ M  src/App.tsx                +12 -3  │     │
│ │   ┌─ diff ───────────────────────────┐  │     │
│ │   │ - const old = true;              │  │     │
│ │   │ + const updated = false;         │  │     │
│ │   └──────────────────────────────────┘  │     │
│ │ ☐ M  src/store.ts              +5  -1  │     │
│ │ ☐ D  src/old-utils.ts               -8 │     │
│ │ ☐ ?  src/new-config.json       (new)   │     │
│ └──────────────────────────────────────────┘     │
│                                                  │
│ ┌─ Commit Message ────────────────────────┐      │
│ │ fix: process leak in orchestrator       │      │
│ └─────────────────────────────────────────┘      │
│                            [Commit Staged (2)]   │
│                                                  │
│ Recent Commits                                   │
│ ┌──────────────────────────────────────────┐     │
│ │ a3f9b2c  fix: cleanup threshold  2m ago │     │
│ │ 1e4d8a7  feat: kill_and_remove   1h ago │     │
│ │ 8b2c1f0  refactor: adapter trait 3h ago │     │
│ └──────────────────────────────────────────┘     │
└──────────────────────────────────────────────────┘
```

### UI Behaviors

- **Branch header:** Branch name with status dot (green=clean, amber=dirty). Ahead/behind pills. Pull/Push buttons.
- **Staged / Changes sections:** Collapsible. Header shows file count + bulk Stage All / Unstage All button.
- **File rows:** Checkbox toggles staging. Status badge (M=amber, A=green, D=red, ?=muted). Monospace path. Green/red +/- counts.
- **File click:** Expands inline unified diff below the row (same pattern as TaskDetail diff viewer).
- **Commit area:** Textarea + "Commit Staged (N)" button. Disabled when no staged files.
- **Recent Commits:** Last 10 commits — short hash, message, relative time.
- **Auto-refresh:** On view mount, after commit/stage/pull/push.

### Colors (matching theme.ts)

- Status M → amber (#f59e0b), A → green (#4ade80), D → red (#f87171), ? → muted (#4b4d66)
- Diff additions → bg `rgba(74, 222, 128, 0.1)`, text green
- Diff deletions → bg `rgba(248, 113, 113, 0.1)`, text red

## Error Handling

- Pull/push failures shown as toast or inline error banner
- Commit with empty message prevented (button disabled)
- Non-git directory shows "Not a git repository" message

## Testing

- Rust: Unit tests for git2 operations (status, stage, commit, log)
- Frontend: Verify view renders, staging toggles work, commit flow completes
