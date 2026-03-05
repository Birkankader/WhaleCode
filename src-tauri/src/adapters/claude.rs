// Claude Code adapter: NDJSON parsing, command building, failure detection, rate limit detection
// Implementation will be added after tests (TDD RED phase)

#[cfg(test)]
mod tests {
    #[test]
    fn test_parse_init_event() {
        let line = r#"{"type":"init","session_id":"abc"}"#;
        let event = super::parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for init event");
        match event.unwrap() {
            super::ClaudeStreamEvent::Init { session_id, .. } => {
                assert_eq!(session_id, Some("abc".to_string()));
            }
            other => panic!("Expected Init, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_message_event_with_content_blocks() {
        let line = r#"{"type":"message","role":"assistant","content":[{"type":"text","text":"Hello world"}]}"#;
        let event = super::parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for message event");
        match event.unwrap() {
            super::ClaudeStreamEvent::Message { role, content, .. } => {
                assert_eq!(role, Some("assistant".to_string()));
                let blocks = content.unwrap();
                assert_eq!(blocks.len(), 1);
                assert_eq!(blocks[0].block_type, "text");
                assert_eq!(blocks[0].text, Some("Hello world".to_string()));
            }
            other => panic!("Expected Message, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_tool_use_event() {
        let line = r#"{"type":"tool_use","name":"Bash","input":{"command":"ls"}}"#;
        let event = super::parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for tool_use event");
        match event.unwrap() {
            super::ClaudeStreamEvent::ToolUse { name, input, .. } => {
                assert_eq!(name, Some("Bash".to_string()));
                assert!(input.is_some());
            }
            other => panic!("Expected ToolUse, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_tool_result_event() {
        let line = r#"{"type":"tool_result","output":"file.txt\nother.txt"}"#;
        let event = super::parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for tool_result event");
        match event.unwrap() {
            super::ClaudeStreamEvent::ToolResult { output, .. } => {
                assert_eq!(output, Some("file.txt\nother.txt".to_string()));
            }
            other => panic!("Expected ToolResult, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_result_event() {
        let line = r#"{"type":"result","status":"success","result":"Done","num_turns":3,"duration_ms":5000,"total_cost_usd":0.05}"#;
        let event = super::parse_stream_line(line);
        assert!(event.is_some(), "Expected Some for result event");
        match event.unwrap() {
            super::ClaudeStreamEvent::Result {
                status,
                result,
                num_turns,
                duration_ms,
                total_cost_usd,
                ..
            } => {
                assert_eq!(status, Some("success".to_string()));
                assert_eq!(result, Some("Done".to_string()));
                assert_eq!(num_turns, Some(3));
                assert_eq!(duration_ms, Some(5000));
                assert_eq!(total_cost_usd, Some(0.05));
            }
            other => panic!("Expected Result, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_non_json_line_returns_none() {
        let line = "Starting Claude Code...";
        assert!(super::parse_stream_line(line).is_none());
    }

    #[test]
    fn test_parse_empty_line_returns_none() {
        assert!(super::parse_stream_line("").is_none());
    }

    #[test]
    fn test_validate_result_success() {
        let event = super::ClaudeStreamEvent::Result {
            status: Some("success".to_string()),
            result: Some("Task completed".to_string()),
            num_turns: Some(2),
            duration_ms: Some(3000),
            total_cost_usd: Some(0.03),
            is_error: None,
            session_id: None,
            subtype: None,
        };
        assert!(super::validate_result(&event).is_ok());
    }

    #[test]
    fn test_validate_result_empty_result_string() {
        let event = super::ClaudeStreamEvent::Result {
            status: Some("success".to_string()),
            result: Some("".to_string()),
            num_turns: Some(1),
            duration_ms: Some(1000),
            total_cost_usd: None,
            is_error: None,
            session_id: None,
            subtype: None,
        };
        let err = super::validate_result(&event);
        assert!(err.is_err(), "Expected Err for empty result");
        assert!(err.unwrap_err().contains("empty result"));
    }

    #[test]
    fn test_validate_result_zero_turns() {
        let event = super::ClaudeStreamEvent::Result {
            status: Some("success".to_string()),
            result: Some("Something".to_string()),
            num_turns: Some(0),
            duration_ms: Some(500),
            total_cost_usd: None,
            is_error: None,
            session_id: None,
            subtype: None,
        };
        let err = super::validate_result(&event);
        assert!(err.is_err(), "Expected Err for zero turns");
        assert!(err.unwrap_err().contains("zero turns"));
    }

    #[test]
    fn test_validate_result_is_error_true() {
        let event = super::ClaudeStreamEvent::Result {
            status: Some("error".to_string()),
            result: Some("Error occurred".to_string()),
            num_turns: Some(1),
            duration_ms: Some(1000),
            total_cost_usd: None,
            is_error: Some(true),
            session_id: None,
            subtype: None,
        };
        let err = super::validate_result(&event);
        assert!(err.is_err(), "Expected Err for is_error=true");
        assert!(err.unwrap_err().contains("error"));
    }

    #[test]
    fn test_validate_result_no_result_event() {
        let event = super::ClaudeStreamEvent::Init {
            session_id: Some("abc".to_string()),
        };
        let err = super::validate_result(&event);
        assert!(err.is_err(), "Expected Err for non-result event");
        assert!(err.unwrap_err().contains("No result event"));
    }

    #[test]
    fn test_detect_rate_limit_429() {
        let info = super::detect_rate_limit("Error: 429 Too Many Requests");
        assert!(info.is_some(), "Expected rate limit detection for 429");
    }

    #[test]
    fn test_detect_rate_limit_rate_limit_string() {
        let info = super::detect_rate_limit("rate_limit exceeded, please retry");
        assert!(info.is_some(), "Expected rate limit detection for rate_limit");
    }

    #[test]
    fn test_detect_rate_limit_overloaded() {
        let info = super::detect_rate_limit("Server overloaded, try again later");
        assert!(info.is_some(), "Expected rate limit detection for overloaded");
    }

    #[test]
    fn test_detect_rate_limit_normal_line() {
        let info = super::detect_rate_limit("Processing your request...");
        assert!(info.is_none(), "Expected None for normal line");
    }

    #[test]
    fn test_build_command_produces_correct_args() {
        let cmd = super::build_command("write hello world", "/tmp/project", "sk-ant-key123");
        assert_eq!(cmd.cmd, "claude");
        assert!(cmd.args.contains(&"-p".to_string()));
        assert!(cmd.args.contains(&"write hello world".to_string()));
        assert!(cmd.args.contains(&"--output-format".to_string()));
        assert!(cmd.args.contains(&"stream-json".to_string()));
        assert!(cmd.args.contains(&"--verbose".to_string()));
    }

    #[test]
    fn test_build_command_includes_prompt() {
        let cmd = super::build_command("fix the bug", "/home/user", "sk-ant-key");
        let prompt_idx = cmd.args.iter().position(|a| a == "-p").unwrap();
        assert_eq!(cmd.args[prompt_idx + 1], "fix the bug");
    }

    #[test]
    fn test_retry_policy_delay_doubles() {
        let policy = super::RetryPolicy::default_claude();
        let d0 = policy.delay_for_attempt(0); // 5000
        let d1 = policy.delay_for_attempt(1); // 10000
        let d2 = policy.delay_for_attempt(2); // 20000
        assert_eq!(d0, 5_000);
        assert_eq!(d1, 10_000);
        assert_eq!(d2, 20_000);
    }

    #[test]
    fn test_retry_policy_delay_capped_at_max() {
        let policy = super::RetryPolicy::default_claude();
        let d10 = policy.delay_for_attempt(10); // would be huge, capped at 60000
        assert_eq!(d10, 60_000);
    }
}
