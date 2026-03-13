use std::fs;
use std::path::Path;
use super::models::FsEntry;

const SKIP_NAMES: &[&str] = &[
    ".git", "node_modules", "target", "__pycache__",
    ".DS_Store", "Thumbs.db", ".venv", "dist",
];

pub fn list_dir(base_path: &Path, relative_path: &str) -> Result<Vec<FsEntry>, String> {
    let full_path = if relative_path.is_empty() {
        base_path.to_path_buf()
    } else {
        base_path.join(relative_path)
    };

    if !full_path.is_dir() {
        return Err(format!("Not a directory: {}", full_path.display()));
    }

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

        if SKIP_NAMES.contains(&name.as_str()) {
            continue;
        }

        let entry_path = entry.path();
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        let is_dir = metadata.is_dir();

        let rel = entry_path
            .strip_prefix(base_path)
            .unwrap_or(&entry_path)
            .to_string_lossy()
            .to_string();

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
            size: if is_dir { 0 } else { metadata.len() as u32 },
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
