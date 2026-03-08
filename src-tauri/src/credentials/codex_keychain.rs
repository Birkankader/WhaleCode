use keyring::Entry;

const SERVICE_NAME: &str = "com.whalecode.app";
const CODEX_API_KEY_USER: &str = "openai-api-key";

/// Retrieve the stored Codex (OpenAI) API key from the macOS Keychain.
pub fn get_codex_api_key() -> Result<String, String> {
    let entry = Entry::new(SERVICE_NAME, CODEX_API_KEY_USER)
        .map_err(|e| format!("Failed to create keychain entry: {}", e))?;
    entry
        .get_password()
        .map_err(|e| format!("Failed to retrieve Codex API key: {}", e))
}

/// Store a Codex (OpenAI) API key in the macOS Keychain.
pub fn set_codex_api_key(key: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, CODEX_API_KEY_USER)
        .map_err(|e| format!("Failed to create keychain entry: {}", e))?;
    entry
        .set_password(key)
        .map_err(|e| format!("Failed to store Codex API key: {}", e))
}

/// Delete the stored Codex (OpenAI) API key from the macOS Keychain.
pub fn delete_codex_api_key() -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, CODEX_API_KEY_USER)
        .map_err(|e| format!("Failed to create keychain entry: {}", e))?;
    entry
        .delete_credential()
        .map_err(|e| format!("Failed to delete Codex API key: {}", e))
}

/// Check whether a Codex (OpenAI) API key is stored in the macOS Keychain.
pub fn has_codex_api_key() -> bool {
    get_codex_api_key().is_ok()
}

#[cfg(test)]
mod tests {
    use keyring::Entry;

    const TEST_SERVICE: &str = "com.whalecode.test";
    const TEST_CODEX_USER: &str = "test-openai-api-key";

    fn get_test_key() -> Result<String, String> {
        let entry = Entry::new(TEST_SERVICE, TEST_CODEX_USER)
            .map_err(|e| format!("Failed to create keychain entry: {}", e))?;
        entry
            .get_password()
            .map_err(|e| format!("Failed to retrieve API key: {}", e))
    }

    fn set_test_key(key: &str) -> Result<(), String> {
        let entry = Entry::new(TEST_SERVICE, TEST_CODEX_USER)
            .map_err(|e| format!("Failed to create keychain entry: {}", e))?;
        entry
            .set_password(key)
            .map_err(|e| format!("Failed to store API key: {}", e))
    }

    fn delete_test_key() -> Result<(), String> {
        let entry = Entry::new(TEST_SERVICE, TEST_CODEX_USER)
            .map_err(|e| format!("Failed to create keychain entry: {}", e))?;
        entry
            .delete_credential()
            .map_err(|e| format!("Failed to delete API key: {}", e))
    }

    fn has_test_key() -> bool {
        get_test_key().is_ok()
    }

    /// Clean up any leftover test key before each test
    fn cleanup() {
        let _ = delete_test_key();
    }

    #[test]
    fn test_set_and_get_codex_api_key() {
        cleanup();
        set_test_key("sk-codex-test-key-123456").unwrap();
        let retrieved = get_test_key().unwrap();
        assert_eq!(retrieved, "sk-codex-test-key-123456");
        cleanup();
    }

    #[test]
    fn test_delete_codex_api_key() {
        cleanup();
        set_test_key("sk-codex-delete-me-key").unwrap();
        delete_test_key().unwrap();
        let result = get_test_key();
        assert!(result.is_err(), "Expected error after deletion, got: {:?}", result);
        cleanup();
    }

    #[test]
    fn test_get_codex_api_key_when_not_stored() {
        cleanup();
        let result = get_test_key();
        assert!(result.is_err(), "Expected error when no key stored, got: {:?}", result);
    }

    #[test]
    fn test_has_codex_api_key() {
        cleanup();
        assert!(!has_test_key(), "Expected false when no key stored");
        set_test_key("sk-codex-has-test-key").unwrap();
        assert!(has_test_key(), "Expected true after storing key");
        delete_test_key().unwrap();
        assert!(!has_test_key(), "Expected false after deleting key");
    }
}
