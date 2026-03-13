# Code View + Git Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a file explorer + Shiki-highlighted code viewer as a "Code" tab, and fix git status error on non-repo directories.

**Architecture:** Rust backend module `fs_explorer` provides `list_dir` and `read_file_content` functions. Frontend `CodeView.tsx` with split layout (file tree + code panel). Shiki lazy-loaded for syntax highlighting. Git fix uses `Repository::discover()`.

**Tech Stack:** Rust (std::fs, ignore crate), Shiki (npm), React + Zustand + Tailwind CSS 4, tauri-specta.

---

### Task 1: Fix Git Error — Use `discover()` Instead of `open()`

**Files:**
- Modify: `src-tauri/src/git/status.rs` (line 80)
- Modify: `src-tauri/src/git/operations.rs` (lines 6, 20, 41)
- Modify: `src-tauri/src/git/diff.rs` (line with `Repository::open`)
- Modify: `src-tauri/src/git/log.rs` (line with `Repository::open`)

**Step 1: Replace `Repository::open` with `Repository::discover` in status.rs**

In `src-tauri/src/git/status.rs`, line 80, change:
```rust
let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repo: {}", e))?;
```
to:
```rust
let repo = Repository::discover(repo_path)
    .map_err(|_| format!("No git repository found at or above '{}'", repo_path.display()))?;
```

**Step 2: Do the same in operations.rs**

In `src-tauri/src/git/operations.rs`, replace all three `Repository::open(repo_path)` calls with `Repository::discover(repo_path)` and the same user-friendly error message.

**Step 3: Do the same in diff.rs and log.rs**

Replace `Repository::open(repo_path)` with `Repository::discover(repo_path)` in both files.

**Step 4: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -- --skip credentials 2>&1 | tail -10`
Expected: All tests pass (discover works the same as open when `.git` is in the given dir).

**Step 5: Commit**

```bash
git add src-tauri/src/git/
git commit -m "fix(git): use discover() to find repo in parent directories"
```

---

### Task 2: FS Explorer Backend — Models + list_dir

**Files:**
- Create: `src-tauri/src/fs_explorer/mod.rs`
- Create: `src-tauri/src/fs_explorer/models.rs`
- Create: `src-tauri/src/fs_explorer/list.rs`
- Modify: `src-tauri/src/lib.rs` (line 13, add `mod fs_explorer;`)
- Modify: `src-tauri/Cargo.toml` (add `ignore` crate)

**Step 1: Add ignore crate to Cargo.toml**

In `src-tauri/Cargo.toml`, add under `[dependencies]` after the `git2` line:
```toml
ignore = "0.4"
```

**Step 2: Create models**

Create `src-tauri/src/fs_explorer/mod.rs`:
```rust
pub mod models;
pub mod list;
pub mod read;
```

Create `src-tauri/src/fs_explorer/models.rs`:
```rust
use serde::Serialize;
use specta::Type;

#[derive(Debug, Clone, Serialize, Type)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub extension: String,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct FileContent {
    pub content: String,
    pub truncated: bool,
    pub size: u64,
    pub language: String,
}
```

**Step 3: Implement list_dir**

Create `src-tauri/src/fs_explorer/list.rs`:
```rust
use std::fs;
use std::path::Path;
use super::models::FsEntry;

/// Default directories/files to always skip (regardless of .gitignore).
const SKIP_NAMES: &[&str] = &[
    ".git", "node_modules", "target", "__pycache__",
    ".DS_Store", "Thumbs.db", ".venv", "dist",
];

/// List directory contents, respecting .gitignore and skipping common junk dirs.
/// Returns entries sorted: directories first, then files, both alphabetical.
pub fn list_dir(base_path: &Path, relative_path: &str) -> Result<Vec<FsEntry>, String> {
    let full_path = if relative_path.is_empty() {
        base_path.to_path_buf()
    } else {
        base_path.join(relative_path)
    };

    if !full_path.is_dir() {
        return Err(format!("Not a directory: {}", full_path.display()));
    }

    // Build gitignore matcher from base_path
    let gitignore = build_gitignore(base_path);

    let mut dirs: Vec<FsEntry> = Vec::new();
    let mut files: Vec<FsEntry> = Vec::new();

    let entries = fs::read_dir(&full_path)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden and junk directories/files
        if SKIP_NAMES.contains(&name.as_str()) {
            continue;
        }

        let entry_path = entry.path();
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        let is_dir = metadata.is_dir();

        // Compute relative path from base for gitignore matching
        let rel = entry_path
            .strip_prefix(base_path)
            .unwrap_or(&entry_path)
            .to_string_lossy()
            .to_string();

        // Check gitignore
        if let Some(ref gi) = gitignore {
            if gi.matched_path_or_any_parents(&rel, is_dir).is_ignore() {
                continue;
            }
        }

        let extension = entry_path
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default();

        let fs_entry = FsEntry {
            name: name.clone(),
            path: rel,
            is_dir,
            size: if is_dir { 0 } else { metadata.len() },
            extension,
        };

        if is_dir {
            dirs.push(fs_entry);
        } else {
            files.push(fs_entry);
        }
    }

    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    dirs.extend(files);
    Ok(dirs)
}

/// Build a gitignore matcher from the repo root's .gitignore file.
fn build_gitignore(base_path: &Path) -> Option<ignore::gitignore::Gitignore> {
    let gitignore_path = base_path.join(".gitignore");
    if !gitignore_path.exists() {
        return None;
    }
    let mut builder = ignore::gitignore::GitignoreBuilder::new(base_path);
    builder.add(&gitignore_path);
    builder.build().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_list_dir_basic() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("subdir")).unwrap();
        fs::write(dir.path().join("file.txt"), "hello").unwrap();
        fs::write(dir.path().join("code.rs"), "fn main() {}").unwrap();

        let entries = list_dir(dir.path(), "").unwrap();
        // Dirs first, then files
        assert!(entries[0].is_dir);
        assert_eq!(entries[0].name, "subdir");
        assert_eq!(entries.len(), 3);
    }

    #[test]
    fn test_list_dir_skips_node_modules() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("node_modules")).unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();

        let entries = list_dir(dir.path(), "").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "src");
    }

    #[test]
    fn test_list_dir_respects_gitignore() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(".gitignore"), "*.log\nbuild/\n").unwrap();
        fs::write(dir.path().join("app.rs"), "code").unwrap();
        fs::write(dir.path().join("debug.log"), "log stuff").unwrap();
        fs::create_dir(dir.path().join("build")).unwrap();

        let entries = list_dir(dir.path(), "").unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"app.rs"));
        assert!(names.contains(&".gitignore"));
        assert!(!names.contains(&"debug.log"));
        assert!(!names.contains(&"build"));
    }

    #[test]
    fn test_list_dir_not_a_directory() {
        let dir = TempDir::new().unwrap();
        let result = list_dir(dir.path(), "nonexistent");
        assert!(result.is_err());
    }
}
```

**Step 4: Register module in lib.rs**

In `src-tauri/src/lib.rs`, after line 13 (`mod git;`), add:
```rust
mod fs_explorer;
```

**Step 5: Build and test**

Run: `cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5`
Expected: Compiles (warnings OK).

Run: `cargo test --manifest-path src-tauri/Cargo.toml fs_explorer::list -- --nocapture 2>&1 | tail -15`
Expected: 4 tests pass.

**Step 6: Commit**

```bash
git add src-tauri/src/fs_explorer/ src-tauri/Cargo.toml src-tauri/src/lib.rs
git commit -m "feat(fs): add fs_explorer module with list_dir"
```

---

### Task 3: FS Explorer Backend — read_file_content

**Files:**
- Create: `src-tauri/src/fs_explorer/read.rs`

**Step 1: Implement read_file_content**

Create `src-tauri/src/fs_explorer/read.rs`:
```rust
use std::fs;
use std::io::Read;
use std::path::Path;
use super::models::FileContent;

const MAX_FILE_SIZE: u64 = 1_048_576; // 1MB
const BINARY_CHECK_SIZE: usize = 8192;

/// Map file extension to a language identifier for Shiki.
fn extension_to_language(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "py" => "python",
        "rb" => "ruby",
        "go" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" => "cpp",
        "cs" => "csharp",
        "swift" => "swift",
        "kt" | "kts" => "kotlin",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" | "sass" => "scss",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "xml" => "xml",
        "md" | "mdx" => "markdown",
        "sql" => "sql",
        "sh" | "bash" | "zsh" => "bash",
        "dockerfile" => "dockerfile",
        "graphql" | "gql" => "graphql",
        "vue" => "vue",
        "svelte" => "svelte",
        _ => "text",
    }
}

/// Check if file content appears to be binary by looking for null bytes.
fn is_binary(buf: &[u8]) -> bool {
    buf.contains(&0)
}

/// Read file content with size limits and binary detection.
pub fn read_file_content(base_path: &Path, relative_path: &str) -> Result<FileContent, String> {
    let full_path = base_path.join(relative_path);

    if !full_path.is_file() {
        return Err(format!("Not a file: {}", full_path.display()));
    }

    let metadata = fs::metadata(&full_path)
        .map_err(|e| format!("Failed to read metadata: {}", e))?;
    let size = metadata.len();

    let extension = full_path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    let language = extension_to_language(&extension).to_string();

    // Check for binary
    let mut file = fs::File::open(&full_path)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    let mut check_buf = vec![0u8; BINARY_CHECK_SIZE.min(size as usize)];
    let bytes_read = file.read(&mut check_buf)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    if is_binary(&check_buf[..bytes_read]) {
        return Ok(FileContent {
            content: "(binary file)".to_string(),
            truncated: false,
            size,
            language: "binary".to_string(),
        });
    }

    // Read full content (up to max size)
    let truncated = size > MAX_FILE_SIZE;
    let read_size = if truncated { MAX_FILE_SIZE as usize } else { size as usize };

    let content = if truncated {
        let mut buf = vec![0u8; read_size];
        let mut file = fs::File::open(&full_path)
            .map_err(|e| format!("Failed to open file: {}", e))?;
        file.read(&mut buf)
            .map_err(|e| format!("Failed to read file: {}", e))?;
        String::from_utf8_lossy(&buf).to_string()
    } else {
        fs::read_to_string(&full_path)
            .map_err(|e| format!("Failed to read file: {}", e))?
    };

    Ok(FileContent {
        content,
        truncated,
        size,
        language,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_read_text_file() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("hello.rs"), "fn main() {}").unwrap();
        let result = read_file_content(dir.path(), "hello.rs").unwrap();
        assert_eq!(result.content, "fn main() {}");
        assert_eq!(result.language, "rust");
        assert!(!result.truncated);
    }

    #[test]
    fn test_read_binary_file() {
        let dir = TempDir::new().unwrap();
        let mut data = vec![0u8; 100];
        data[50] = 0; // null byte
        fs::write(dir.path().join("image.png"), &data).unwrap();
        let result = read_file_content(dir.path(), "image.png").unwrap();
        assert_eq!(result.content, "(binary file)");
        assert_eq!(result.language, "binary");
    }

    #[test]
    fn test_read_nonexistent_file() {
        let dir = TempDir::new().unwrap();
        let result = read_file_content(dir.path(), "nope.txt");
        assert!(result.is_err());
    }

    #[test]
    fn test_extension_mapping() {
        assert_eq!(extension_to_language("ts"), "typescript");
        assert_eq!(extension_to_language("py"), "python");
        assert_eq!(extension_to_language("rs"), "rust");
        assert_eq!(extension_to_language("xyz"), "text");
    }
}
```

**Step 2: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml fs_explorer::read -- --nocapture 2>&1 | tail -15`
Expected: 4 tests pass.

**Step 3: Commit**

```bash
git add src-tauri/src/fs_explorer/read.rs
git commit -m "feat(fs): add read_file_content with binary detection"
```

---

### Task 4: Tauri Commands for FS Explorer

**Files:**
- Create: `src-tauri/src/commands/fs_explorer.rs`
- Modify: `src-tauri/src/commands/mod.rs` (lines 13, 65-67)
- Modify: `src-tauri/src/lib.rs` (lines 27-28, 86-87)

**Step 1: Create command file**

Create `src-tauri/src/commands/fs_explorer.rs`:
```rust
use crate::fs_explorer::{list, models::*, read};

#[tauri::command]
#[specta::specta]
pub async fn list_directory(
    project_dir: String,
    relative_path: String,
) -> Result<Vec<FsEntry>, String> {
    let base = super::expand_tilde(&project_dir);
    tokio::task::spawn_blocking(move || list::list_dir(&base, &relative_path))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
#[specta::specta]
pub async fn read_file(
    project_dir: String,
    relative_path: String,
) -> Result<FileContent, String> {
    let base = super::expand_tilde(&project_dir);
    tokio::task::spawn_blocking(move || read::read_file_content(&base, &relative_path))
        .await
        .map_err(|e| format!("Task failed: {}", e))?
}
```

**Step 2: Register in commands/mod.rs**

After line 13 (`pub mod git;`), add:
```rust
pub mod fs_explorer;
```

After line 67 (the git `pub use` block), add:
```rust
pub use fs_explorer::{list_directory, read_file};
```

**Step 3: Register in lib.rs**

In `src-tauri/src/lib.rs`, add to the `use commands::{ ... }` block (after line 28):
```rust
    list_directory, read_file,
```

Add to the `collect_commands!` macro (after line 86, `git_push`):
```rust
        list_directory,
        read_file,
```

**Step 4: Build**

Run: `cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5`
Expected: Compiles successfully.

**Step 5: Commit**

```bash
git add src-tauri/src/commands/fs_explorer.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(fs): register list_directory and read_file Tauri commands"
```

---

### Task 5: Frontend — Install Shiki + Create useFileExplorer Hook

**Files:**
- Modify: `package.json` (add shiki dependency)
- Modify: `src/stores/uiStore.ts` (line 3, add 'code' to AppView)
- Create: `src/hooks/useFileExplorer.ts`

**Step 1: Install Shiki**

Run: `npm install shiki --save`

**Step 2: Add 'code' to AppView type**

In `src/stores/uiStore.ts`, line 3, change:
```typescript
export type AppView = 'kanban' | 'terminal' | 'usage' | 'review' | 'done' | 'settings' | 'git';
```
to:
```typescript
export type AppView = 'kanban' | 'terminal' | 'usage' | 'review' | 'done' | 'settings' | 'git' | 'code';
```

**Step 3: Create useFileExplorer hook**

Create `src/hooks/useFileExplorer.ts`:
```typescript
import { useState, useCallback } from 'react';
import { commands } from '../bindings';
import type { FsEntry, FileContent } from '../bindings';

interface TreeNode {
  entry: FsEntry;
  children: TreeNode[] | null; // null = not loaded yet
  expanded: boolean;
}

export function useFileExplorer(projectDir: string) {
  const [rootEntries, setRootEntries] = useState<TreeNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(async (relativePath: string): Promise<TreeNode[]> => {
    const result = await commands.listDirectory(projectDir, relativePath);
    if (result.status === 'ok') {
      return result.data.map((entry: FsEntry) => ({
        entry,
        children: entry.is_dir ? null : undefined,
        expanded: false,
      })) as TreeNode[];
    }
    throw new Error(result.error as string);
  }, [projectDir]);

  const loadRoot = useCallback(async () => {
    if (!projectDir) return;
    setLoading(true);
    setError(null);
    try {
      const nodes = await loadDir('');
      setRootEntries(nodes);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectDir, loadDir]);

  const toggleDir = useCallback(async (path: string) => {
    const updateNodes = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
      const result: TreeNode[] = [];
      for (const node of nodes) {
        if (node.entry.path === path) {
          if (node.expanded) {
            // Collapse
            result.push({ ...node, expanded: false });
          } else {
            // Expand — load children if needed
            let children = node.children;
            if (children === null) {
              try {
                children = await loadDir(path);
              } catch {
                children = [];
              }
            }
            result.push({ ...node, children, expanded: true });
          }
        } else if (node.children && node.expanded) {
          // Recurse into expanded children
          result.push({ ...node, children: await updateNodes(node.children) });
        } else {
          result.push(node);
        }
      }
      return result;
    };

    setRootEntries(prev => {
      // We need async update, so trigger it
      updateNodes(prev).then(setRootEntries);
      return prev;
    });
  }, [loadDir]);

  const selectFile = useCallback(async (relativePath: string) => {
    setSelectedFile(relativePath);
    setFileContent(null);
    const result = await commands.readFile(projectDir, relativePath);
    if (result.status === 'ok') {
      setFileContent(result.data);
    } else {
      setError(result.error as string);
    }
  }, [projectDir]);

  return {
    rootEntries, selectedFile, fileContent, loading, error,
    loadRoot, toggleDir, selectFile,
  };
}
```

**Step 4: Commit**

```bash
git add package.json package-lock.json src/stores/uiStore.ts src/hooks/useFileExplorer.ts
git commit -m "feat(code): add Shiki, useFileExplorer hook, and code AppView type"
```

---

### Task 6: Frontend — CodeView Component

**Files:**
- Create: `src/components/views/CodeView.tsx`
- Modify: `src/components/layout/AppShell.tsx` (line 70)
- Modify: `src/routes/index.tsx` (lines 10, 53)

**Step 1: Create CodeView component**

Create `src/components/views/CodeView.tsx`:
```tsx
import { useEffect, useState, useCallback, useMemo } from 'react';
import { C } from '@/lib/theme';
import { useUIStore } from '@/stores/uiStore';
import { useFileExplorer } from '@/hooks/useFileExplorer';
import type { FileContent } from '@/bindings';

/* ── Shiki lazy loader ────────────────────────────────── */

let shikiHighlighterPromise: Promise<any> | null = null;

async function getHighlighter() {
  if (!shikiHighlighterPromise) {
    shikiHighlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({
        themes: ['github-dark-default'],
        langs: [
          'typescript', 'javascript', 'rust', 'python', 'json', 'yaml',
          'toml', 'html', 'css', 'markdown', 'bash', 'sql', 'go',
          'java', 'c', 'cpp', 'ruby', 'swift', 'kotlin', 'vue',
          'svelte', 'graphql', 'dockerfile', 'scss',
        ],
      })
    );
  }
  return shikiHighlighterPromise;
}

/* ── File icon helper ─────────────────────────────────── */

function fileIcon(entry: { is_dir: boolean; extension: string; name: string }): string {
  if (entry.is_dir) return '📁';
  const ext = entry.extension.toLowerCase();
  const map: Record<string, string> = {
    rs: '🦀', ts: '🔷', tsx: '🔷', js: '🟨', jsx: '🟨',
    py: '🐍', json: '📋', md: '📝', toml: '⚙️', yaml: '⚙️', yml: '⚙️',
    html: '🌐', css: '🎨', scss: '🎨', svg: '🖼️', png: '🖼️', jpg: '🖼️',
  };
  return map[ext] ?? '📄';
}

/* ── Tree Item Component ──────────────────────────────── */

interface TreeNode {
  entry: { name: string; path: string; is_dir: boolean; extension: string; size: number };
  children: TreeNode[] | null;
  expanded: boolean;
}

function TreeItem({
  node,
  depth,
  selectedFile,
  onToggleDir,
  onSelectFile,
}: {
  node: TreeNode;
  depth: number;
  selectedFile: string | null;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const isSelected = node.entry.path === selectedFile;

  return (
    <>
      <div
        className="flex items-center gap-1.5 py-1 px-2 cursor-pointer transition-colors text-xs"
        style={{
          paddingLeft: depth * 16 + 8,
          background: isSelected ? C.accentSoft : 'transparent',
          color: isSelected ? C.accentText : C.textPrimary,
        }}
        onClick={() => {
          if (node.entry.is_dir) onToggleDir(node.entry.path);
          else onSelectFile(node.entry.path);
        }}
      >
        {node.entry.is_dir && (
          <span
            className="text-[9px] flex-shrink-0 transition-transform"
            style={{
              color: C.textMuted,
              transform: node.expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            }}
          >
            ▶
          </span>
        )}
        <span className="flex-shrink-0">{fileIcon(node.entry)}</span>
        <span className="truncate font-mono">{node.entry.name}</span>
        {!node.entry.is_dir && node.entry.size > 0 && (
          <span className="ml-auto text-[10px] flex-shrink-0" style={{ color: C.textMuted }}>
            {node.entry.size > 1024
              ? `${(node.entry.size / 1024).toFixed(0)}KB`
              : `${node.entry.size}B`}
          </span>
        )}
      </div>
      {node.expanded && node.children?.map((child) => (
        <TreeItem
          key={child.entry.path}
          node={child}
          depth={depth + 1}
          selectedFile={selectedFile}
          onToggleDir={onToggleDir}
          onSelectFile={onSelectFile}
        />
      ))}
    </>
  );
}

/* ── Code Panel with Shiki ────────────────────────────── */

function CodePanel({ fileContent, filePath }: { fileContent: FileContent | null; filePath: string | null }) {
  const [highlightedHtml, setHighlightedHtml] = useState<string>('');
  const [highlighterReady, setHighlighterReady] = useState(false);

  useEffect(() => {
    if (!fileContent || fileContent.language === 'binary' || !fileContent.content) {
      setHighlightedHtml('');
      return;
    }

    let cancelled = false;

    getHighlighter().then((highlighter) => {
      if (cancelled) return;
      setHighlighterReady(true);

      try {
        // Check if language is supported, fall back to 'text'
        const langs = highlighter.getLoadedLanguages();
        const lang = langs.includes(fileContent.language) ? fileContent.language : 'text';

        const html = highlighter.codeToHtml(fileContent.content, {
          lang,
          theme: 'github-dark-default',
        });
        if (!cancelled) setHighlightedHtml(html);
      } catch {
        // Fallback: plain text
        if (!cancelled) setHighlightedHtml('');
      }
    });

    return () => { cancelled = true; };
  }, [fileContent]);

  if (!filePath) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: C.bg }}>
        <div className="text-center">
          <div className="text-2xl mb-2">◈</div>
          <div className="text-sm" style={{ color: C.textMuted }}>
            Select a file to view
          </div>
        </div>
      </div>
    );
  }

  if (!fileContent) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: C.bg }}>
        <span className="text-xs" style={{ color: C.textMuted }}>Loading...</span>
      </div>
    );
  }

  if (fileContent.language === 'binary') {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: C.bg }}>
        <span className="text-xs" style={{ color: C.textMuted }}>Binary file — cannot display</span>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: C.bg }}>
      {/* File header */}
      <div
        className="flex items-center gap-2 px-4 py-2 border-b flex-shrink-0"
        style={{ borderColor: C.border, background: C.panel }}
      >
        <span className="text-xs font-mono" style={{ color: C.textPrimary }}>
          {filePath}
        </span>
        <div className="flex-1" />
        <span className="text-[10px]" style={{ color: C.textMuted }}>
          {fileContent.language}
        </span>
        <span className="text-[10px]" style={{ color: C.textMuted }}>
          {fileContent.size > 1024
            ? `${(fileContent.size / 1024).toFixed(1)}KB`
            : `${fileContent.size}B`}
        </span>
        {fileContent.truncated && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full"
            style={{ background: C.amberBg, color: C.amber }}
          >
            truncated
          </span>
        )}
      </div>

      {/* Code content */}
      <div className="flex-1 overflow-auto">
        {highlightedHtml ? (
          <div
            className="shiki-container text-[12px] leading-[20px] p-4"
            style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          <pre
            className="text-[12px] leading-[20px] p-4 font-mono whitespace-pre"
            style={{ color: C.textPrimary, margin: 0 }}
          >
            {fileContent.content}
          </pre>
        )}
      </div>
    </div>
  );
}

/* ── Main CodeView ────────────────────────────────────── */

export function CodeView() {
  const projectDir = useUIStore((s) => s.projectDir);
  const {
    rootEntries, selectedFile, fileContent, loading, error,
    loadRoot, toggleDir, selectFile,
  } = useFileExplorer(projectDir);

  useEffect(() => {
    loadRoot();
  }, [loadRoot]);

  if (!projectDir) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: C.bg }}>
        <div className="text-center">
          <div className="text-2xl mb-2">◈</div>
          <div className="text-sm font-medium" style={{ color: C.textSecondary }}>
            No project directory selected
          </div>
          <div className="text-xs mt-1" style={{ color: C.textMuted }}>
            Launch a session to browse code
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex overflow-hidden" style={{ background: C.bg }}>
      {/* File tree sidebar */}
      <div
        className="flex flex-col overflow-hidden border-r flex-shrink-0"
        style={{ width: 260, borderColor: C.border, background: C.panel }}
      >
        {/* Tree header */}
        <div
          className="flex items-center gap-2 px-3 py-2 border-b flex-shrink-0"
          style={{ borderColor: C.border }}
        >
          <span className="text-xs font-semibold" style={{ color: C.textPrimary }}>
            {projectDir.split('/').pop()}
          </span>
          <div className="flex-1" />
          <button
            onClick={loadRoot}
            disabled={loading}
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ color: C.textMuted }}
          >
            {loading ? '⟳' : '↻'}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="px-3 py-1 text-[10px]" style={{ color: C.red }}>
            {error}
          </div>
        )}

        {/* Tree */}
        <div className="flex-1 overflow-y-auto py-1">
          {rootEntries.map((node) => (
            <TreeItem
              key={node.entry.path}
              node={node}
              depth={0}
              selectedFile={selectedFile}
              onToggleDir={toggleDir}
              onSelectFile={selectFile}
            />
          ))}
          {rootEntries.length === 0 && !loading && (
            <div className="px-3 py-4 text-xs text-center" style={{ color: C.textMuted }}>
              Empty directory
            </div>
          )}
        </div>
      </div>

      {/* Code panel */}
      <CodePanel fileContent={fileContent} filePath={selectedFile} />
    </div>
  );
}
```

**Step 2: Add Code tab to AppShell**

In `src/components/layout/AppShell.tsx`, line 70, after the git tab:
```typescript
    { key: 'git', label: 'Git', icon: '⎇' },
    { key: 'code', label: 'Code', icon: '◈' },
```

**Step 3: Add CodeView route**

In `src/routes/index.tsx`, add import after line 10:
```typescript
import { CodeView } from '../components/views/CodeView';
```

After line 53 (`{activeView === 'git' && <GitView />}`), add:
```tsx
          {activeView === 'code' && <CodeView />}
```

**Step 4: Add Shiki CSS overrides**

The Shiki output uses inline styles, but we need to ensure the background matches our theme. Add a small CSS snippet. In `src/index.css` (or wherever global styles live), append:

```css
/* Shiki overrides for dark theme consistency */
.shiki-container .shiki {
  background-color: transparent !important;
}
.shiki-container .shiki code {
  counter-reset: line;
}
.shiki-container .shiki code .line::before {
  counter-increment: line;
  content: counter(line);
  display: inline-block;
  width: 2.5em;
  margin-right: 1em;
  text-align: right;
  color: #4b4d66;
  font-size: 11px;
}
```

**Step 5: Commit**

```bash
git add src/components/views/CodeView.tsx src/components/layout/AppShell.tsx src/routes/index.tsx src/index.css
git commit -m "feat(code): add CodeView with file tree and Shiki highlighting"
```

---

### Task 7: Integration Test + Polish

**Step 1: Run all Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -- --skip credentials 2>&1 | tail -20`
Expected: All existing + new tests pass (12+ new tests across fs_explorer and git fix).

**Step 2: Run the app in dev mode**

Run: `npm run tauri dev`
Expected: App launches. Verify:
- Git tab no longer shows error for non-repo dirs (shows user-friendly message)
- Code tab appears in header
- Click Code tab → file tree loads with project directory
- Click a folder → expands with lazy-loaded children
- Click a file → syntax-highlighted code in right panel
- Binary files show "(binary file)" message
- `.gitignore`'d files are hidden from tree

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat: complete code view and git error fix"
```

---

## Summary

| Task | Description | New Files | Tests |
|------|-------------|-----------|-------|
| 1 | Fix git discover error | — (modify 4 files) | Existing pass |
| 2 | FS Explorer list_dir | `fs_explorer/{mod,models,list}.rs` | 4 unit tests |
| 3 | FS Explorer read_file | `fs_explorer/read.rs` | 4 unit tests |
| 4 | Tauri commands | `commands/fs_explorer.rs` | Build check |
| 5 | Frontend hook + Shiki | `useFileExplorer.ts`, `uiStore.ts` | — |
| 6 | CodeView component | `CodeView.tsx`, route + tab + CSS | Build check |
| 7 | Integration | — | Manual verification |
