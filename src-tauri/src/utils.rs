/// Validate that a project directory path exists and is a real directory.
pub fn validate_project_dir(dir: &std::path::Path) -> Result<(), String> {
    if !dir.is_dir() {
        return Err(format!(
            "Project directory does not exist: {}",
            dir.display()
        ));
    }
    Ok(())
}

/// UTF-8-safe string truncation without ellipsis.
pub fn truncate_str(s: &str, max: usize) -> String {
    // Fast path: if byte length fits, char count also fits (1+ byte per char)
    if s.len() <= max {
        return s.to_string();
    }
    match s.char_indices().nth(max) {
        Some((idx, _)) => s[..idx].to_string(),
        None => s.to_string(), // fewer than max chars total
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_project_dir_valid() {
        let dir = std::env::temp_dir();
        assert!(validate_project_dir(&dir).is_ok());
    }

    #[test]
    fn test_validate_project_dir_nonexistent() {
        let dir = std::path::Path::new("/nonexistent/path/that/does/not/exist");
        assert!(validate_project_dir(dir).is_err());
    }

    #[test]
    fn test_validate_project_dir_file_not_dir() {
        let file = std::env::temp_dir().join("whalecode_test_validate_file");
        std::fs::write(&file, "test").unwrap();
        assert!(validate_project_dir(&file).is_err());
        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn test_truncate_str_short() {
        assert_eq!(truncate_str("hello", 10), "hello");
    }

    #[test]
    fn test_truncate_str_exact() {
        assert_eq!(truncate_str("hello", 5), "hello");
    }

    #[test]
    fn test_truncate_str_long() {
        assert_eq!(truncate_str("hello world", 5), "hello");
    }

    #[test]
    fn test_truncate_str_multibyte() {
        // 2-byte UTF-8 chars
        let s = "äöü";
        assert_eq!(truncate_str(s, 2), "äö");
    }
}
