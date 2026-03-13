use std::fs;
use std::path::Path;

pub fn write_file_content(base_path: &Path, relative_path: &str, content: &str) -> Result<u32, String> {
    let full_path = base_path.join(relative_path);

    // Safety: don't allow writing outside base_path
    let canonical_base = base_path.canonicalize()
        .map_err(|e| format!("Invalid base path: {}", e))?;

    // Parent must exist for the file
    if let Some(parent) = full_path.parent() {
        if !parent.exists() {
            return Err(format!("Parent directory does not exist: {}", parent.display()));
        }
    }

    // Canonicalize parent to check containment (file itself may not exist yet)
    let parent = full_path.parent()
        .ok_or_else(|| "Invalid file path".to_string())?;
    let canonical_parent = parent.canonicalize()
        .map_err(|e| format!("Invalid path: {}", e))?;

    if !canonical_parent.starts_with(&canonical_base) {
        return Err("Cannot write outside project directory".to_string());
    }

    fs::write(&full_path, content)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(content.len() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_write_file() {
        let dir = TempDir::new().unwrap();
        let result = write_file_content(dir.path(), "test.txt", "hello world");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 11);

        let content = fs::read_to_string(dir.path().join("test.txt")).unwrap();
        assert_eq!(content, "hello world");
    }

    #[test]
    fn test_write_overwrites_existing() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("existing.txt"), "old").unwrap();

        let result = write_file_content(dir.path(), "existing.txt", "new content");
        assert!(result.is_ok());

        let content = fs::read_to_string(dir.path().join("existing.txt")).unwrap();
        assert_eq!(content, "new content");
    }

    #[test]
    fn test_write_rejects_path_traversal() {
        let dir = TempDir::new().unwrap();
        let result = write_file_content(dir.path(), "../escape.txt", "bad");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Cannot write outside"));
    }

    #[test]
    fn test_write_rejects_missing_parent() {
        let dir = TempDir::new().unwrap();
        let result = write_file_content(dir.path(), "nonexistent/dir/file.txt", "data");
        assert!(result.is_err());
    }
}
