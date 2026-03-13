use std::fs;
use std::io::Read;
use std::path::Path;
use super::models::FileContent;

const MAX_FILE_SIZE: u64 = 1_048_576; // 1MB
const BINARY_CHECK_SIZE: usize = 8192;

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

fn is_binary(buf: &[u8]) -> bool {
    buf.contains(&0)
}

pub fn read_file_content(base_path: &Path, relative_path: &str) -> Result<FileContent, String> {
    let full_path = base_path.join(relative_path);

    if !full_path.is_file() {
        return Err(format!("Not a file: {}", full_path.display()));
    }

    let metadata = fs::metadata(&full_path)
        .map_err(|e| format!("Failed to read metadata: {}", e))?;
    let file_size = metadata.len();
    let size = file_size as u32;

    let extension = full_path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    let language = extension_to_language(&extension).to_string();

    let mut file = fs::File::open(&full_path)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    let mut check_buf = vec![0u8; BINARY_CHECK_SIZE.min(file_size as usize)];
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

    let truncated = file_size > MAX_FILE_SIZE;
    let content = if truncated {
        let read_size = MAX_FILE_SIZE as usize;
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
        data[50] = 0;
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
