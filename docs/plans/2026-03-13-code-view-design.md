# Code View Design

**Date:** 2026-03-13
**Goal:** Add a file explorer + syntax-highlighted code viewer as a separate "Code" tab.
**Includes:** Fix for git status error on non-repo directories.

---

## Architecture

### Backend (Rust)

New module `src-tauri/src/fs_explorer/` with two core functions:

- **`list_dir(path: &Path) -> Vec<FsEntry>`**
  - Returns directory contents: name, full path, is_dir, size, extension
  - Respects `.gitignore` patterns via the `ignore` crate
  - Sorts: directories first, then files alphabetically
  - Skips hidden dirs (`.git`, `node_modules`, `target`, etc.)

- **`read_file_content(path: &Path, max_bytes: u64) -> FileContent`**
  - Returns file content as UTF-8 string
  - Binary detection: checks first 8KB for null bytes
  - Max size: 1MB (returns truncated flag if exceeded)
  - Returns metadata: size, extension, truncated bool

### Data Models

```
FsEntry { name, path, is_dir, size, extension }
FileContent { content, truncated, size, language }
```

### Tauri Commands

Two commands registered in `commands/fs_explorer.rs`:
- `list_directory(project_dir, relative_path)` → `Vec<FsEntry>`
- `read_file_content(project_dir, relative_path)` → `FileContent`

### Frontend

- **`CodeView.tsx`** — Split layout:
  - Left: `FileTree` (collapsible, lazy-loaded directories)
  - Right: `CodePanel` (Shiki-highlighted code with line numbers)
- **`useFileExplorer.ts`** — Tree state management (expanded dirs, selected file)
- **Shiki** — Lazy-loaded, dark theme matching app palette
- **Tab:** `{ key: 'code', label: 'Code', icon: '◈' }` in AppShell

---

## Git Error Fix

**Problem:** `git_status` fails with "could not find repository" when `projectDir` is not a git repo.

**Fix:** In `get_status()`, use `Repository::discover()` instead of `Repository::open()`. This searches parent directories for `.git`. If still not found, return a user-friendly error.

Also: GitView should handle the error gracefully with an informative message instead of a red banner.

---

## Decisions

- Read-only viewer (no editing)
- Shiki for syntax highlighting (lazy-loaded)
- Rust backend for file ops (matches existing pattern)
- Separate "Code" tab (not merged with Git)
- `.gitignore`-aware directory listing
