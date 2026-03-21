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
