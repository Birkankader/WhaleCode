//! Phase 6 Step 2 — per-adapter parser unit tests.
//!
//! Each parser is exercised against the Step 0 fixtures + a few
//! hand-rolled lines covering edge cases. Tests here run in
//! isolation (no subprocess spawn) — the fixtures themselves are
//! still spawned by `tool_event_shapes.rs` to assert their wire
//! shape, but parser correctness lives here.

use std::path::PathBuf;

use crate::agents::tool_event::ToolEvent;

// ---------------------------------------------------------------------
// Claude — stream-json NDJSON
// ---------------------------------------------------------------------

#[test]
fn claude_parses_read_tool_use_with_offset_limit() {
    let line = r#"{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"src/auth.ts","offset":1,"limit":50}}"#;
    let events = crate::agents::claude::parse_tool_events(line);
    assert_eq!(events.len(), 1);
    match &events[0] {
        ToolEvent::FileRead { path, lines } => {
            assert_eq!(path, &PathBuf::from("src/auth.ts"));
            assert_eq!(lines, &Some((1, 51)));
        }
        e => panic!("expected FileRead, got {e:?}"),
    }
}

#[test]
fn claude_parses_edit_with_summary() {
    let line = r#"{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"src/auth.ts","old_string":"a","new_string":"b"}}"#;
    let events = crate::agents::claude::parse_tool_events(line);
    assert_eq!(events.len(), 1);
    match &events[0] {
        ToolEvent::FileEdit { path, summary } => {
            assert_eq!(path, &PathBuf::from("src/auth.ts"));
            assert_eq!(summary, "edited");
        }
        e => panic!("expected FileEdit, got {e:?}"),
    }
}

#[test]
fn claude_parses_bash_command() {
    let line = r#"{"type":"tool_use","name":"Bash","input":{"command":"pnpm test"}}"#;
    let events = crate::agents::claude::parse_tool_events(line);
    assert_eq!(events.len(), 1);
    match &events[0] {
        ToolEvent::Bash { command } => assert_eq!(command, "pnpm test"),
        e => panic!("expected Bash, got {e:?}"),
    }
}

#[test]
fn claude_parses_grep_as_search() {
    let line = r#"{"type":"tool_use","name":"Grep","input":{"pattern":"validateToken","path":"src"}}"#;
    let events = crate::agents::claude::parse_tool_events(line);
    assert_eq!(events.len(), 1);
    match &events[0] {
        ToolEvent::Search { query, paths } => {
            assert_eq!(query, "validateToken");
            assert_eq!(paths, &vec![PathBuf::from("src")]);
        }
        e => panic!("expected Search, got {e:?}"),
    }
}

#[test]
fn claude_routes_unknown_tool_to_other() {
    let line = r#"{"type":"tool_use","name":"WebFetch","input":{"url":"https://example.com"}}"#;
    let events = crate::agents::claude::parse_tool_events(line);
    assert_eq!(events.len(), 1);
    match &events[0] {
        ToolEvent::Other { tool_name, detail } => {
            assert_eq!(tool_name, "WebFetch");
            assert!(detail.contains("url"));
        }
        e => panic!("expected Other, got {e:?}"),
    }
}

#[test]
fn claude_ignores_non_tool_lines() {
    let cases = [
        r#"{"type":"system","subtype":"init"}"#,
        r#"{"type":"thinking","thinking":"reasoning"}"#,
        r#"{"type":"result","subtype":"success","is_error":false,"result":"done"}"#,
        "",
        "garbage not json",
        r#"{"type":"thinking","thinking":"truncated"#,
    ];
    for line in cases {
        let events = crate::agents::claude::parse_tool_events(line);
        assert!(events.is_empty(), "should skip line: {line}");
    }
}

#[test]
fn claude_parse_thinking_extracts_text() {
    let line = r#"{"type":"thinking","thinking":"Need to find auth flow first."}"#;
    assert_eq!(
        crate::agents::claude::parse_thinking(line),
        Some("Need to find auth flow first.".into())
    );
}

#[test]
fn claude_parse_thinking_returns_none_for_other_lines() {
    let cases = [
        r#"{"type":"tool_use","name":"Read","input":{}}"#,
        r#"{"type":"system"}"#,
        "",
    ];
    for line in cases {
        assert!(crate::agents::claude::parse_thinking(line).is_none());
    }
}

#[test]
fn claude_extract_summary_prefers_result_event() {
    let stdout = r#"{"type":"system","subtype":"init"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Working..."}]}}
{"type":"result","subtype":"success","is_error":false,"result":"Done. Added validation."}"#;
    let summary = crate::agents::claude::extract_stream_json_summary(stdout);
    assert_eq!(summary, "Done. Added validation.");
}

#[test]
fn claude_extract_summary_falls_back_to_assistant_text() {
    // No result event — fallback to last assistant text content.
    let stdout = r#"{"type":"system","subtype":"init"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Final answer here."}]}}"#;
    let summary = crate::agents::claude::extract_stream_json_summary(stdout);
    assert_eq!(summary, "Final answer here.");
}

#[test]
fn claude_extract_summary_preserves_trailing_question_mark() {
    // Phase 5 Q&A regression: detect_question keys on summary
    // ending in '?'. Format upgrade must preserve this signal.
    let stdout = r#"{"type":"result","subtype":"success","is_error":false,"result":"Should I use option A or B?"}"#;
    let summary = crate::agents::claude::extract_stream_json_summary(stdout);
    assert_eq!(summary, "Should I use option A or B?");
    assert_eq!(
        crate::agents::process::detect_question(&summary),
        Some("Should I use option A or B?".into())
    );
}

// ---------------------------------------------------------------------
// Codex — exec --json JSONL
// ---------------------------------------------------------------------

#[test]
fn codex_parses_read_function_call() {
    let line = r#"{"type":"function_call","name":"read","arguments":{"path":"src/auth.ts"}}"#;
    let events = crate::agents::codex::parse_tool_events(line);
    assert_eq!(events.len(), 1);
    match &events[0] {
        ToolEvent::FileRead { path, lines } => {
            assert_eq!(path, &PathBuf::from("src/auth.ts"));
            assert!(lines.is_none());
        }
        e => panic!("expected FileRead, got {e:?}"),
    }
}

#[test]
fn codex_apply_patch_expands_per_file() {
    let line = r#"{"type":"function_call","name":"apply_patch","arguments":{"patch":"...","files":["src/a.ts","src/b.ts","src/c.ts"]}}"#;
    let events = crate::agents::codex::parse_tool_events(line);
    assert_eq!(events.len(), 3, "expected one FileEdit per file");
    let paths: Vec<&PathBuf> = events
        .iter()
        .filter_map(|e| match e {
            ToolEvent::FileEdit { path, .. } => Some(path),
            _ => None,
        })
        .collect();
    assert_eq!(paths.len(), 3);
    assert!(paths.iter().any(|p| p.to_str() == Some("src/a.ts")));
    assert!(paths.iter().any(|p| p.to_str() == Some("src/b.ts")));
    assert!(paths.iter().any(|p| p.to_str() == Some("src/c.ts")));
}

#[test]
fn codex_shell_joins_array_command() {
    let line = r#"{"type":"function_call","name":"shell","arguments":{"command":["bash","-c","pnpm test"]}}"#;
    let events = crate::agents::codex::parse_tool_events(line);
    assert_eq!(events.len(), 1);
    match &events[0] {
        ToolEvent::Bash { command } => assert_eq!(command, "bash -c pnpm test"),
        e => panic!("expected Bash, got {e:?}"),
    }
}

#[test]
fn codex_unknown_tool_routes_to_other() {
    let line = r#"{"type":"function_call","name":"browse","arguments":{"url":"https://example.com"}}"#;
    let events = crate::agents::codex::parse_tool_events(line);
    assert_eq!(events.len(), 1);
    match &events[0] {
        ToolEvent::Other { tool_name, .. } => assert_eq!(tool_name, "browse"),
        e => panic!("expected Other, got {e:?}"),
    }
}

#[test]
fn codex_ignores_non_function_call_lines() {
    let cases = [
        r#"{"type":"agent_message","content":"hi"}"#,
        r#"{"type":"task_complete","result":"done"}"#,
        "",
        "junk",
    ];
    for line in cases {
        let events = crate::agents::codex::parse_tool_events(line);
        assert!(events.is_empty(), "should skip: {line}");
    }
}

// ---------------------------------------------------------------------
// Gemini — text/prose heuristic
// ---------------------------------------------------------------------

#[test]
fn gemini_parses_reading_with_path() {
    let events = crate::agents::gemini::parse_tool_events("Reading src/auth.ts");
    assert_eq!(events.len(), 1);
    match &events[0] {
        ToolEvent::FileRead { path, .. } => {
            assert_eq!(path, &PathBuf::from("src/auth.ts"));
        }
        e => panic!("expected FileRead, got {e:?}"),
    }
}

#[test]
fn gemini_skips_reading_followed_by_prose() {
    // Verb collision — "Reading the spec carefully" is prose, not
    // a file action.
    let events = crate::agents::gemini::parse_tool_events("Reading the spec carefully");
    assert!(events.is_empty());
}

#[test]
fn gemini_parses_quoted_path() {
    let events = crate::agents::gemini::parse_tool_events("Reading 'src/types.ts'");
    assert_eq!(events.len(), 1);
    match &events[0] {
        ToolEvent::FileRead { path, .. } => {
            assert_eq!(path, &PathBuf::from("src/types.ts"));
        }
        e => panic!("expected FileRead, got {e:?}"),
    }
}

#[test]
fn gemini_parses_edited_with_summary() {
    let events =
        crate::agents::gemini::parse_tool_events("Edited src/auth.ts: replaced foo with bar");
    assert_eq!(events.len(), 1);
    match &events[0] {
        ToolEvent::FileEdit { path, summary } => {
            assert_eq!(path, &PathBuf::from("src/auth.ts"));
            assert!(summary.contains("replaced"));
        }
        e => panic!("expected FileEdit, got {e:?}"),
    }
}

#[test]
fn gemini_parses_running_command() {
    let events = crate::agents::gemini::parse_tool_events("Running: pnpm test auth.test.ts");
    assert_eq!(events.len(), 1);
    match &events[0] {
        ToolEvent::Bash { command } => assert_eq!(command, "pnpm test auth.test.ts"),
        e => panic!("expected Bash, got {e:?}"),
    }
}

#[test]
fn gemini_parses_searching_for_query() {
    let events = crate::agents::gemini::parse_tool_events("Searching for 'validateToken'");
    assert_eq!(events.len(), 1);
    match &events[0] {
        ToolEvent::Search { query, .. } => assert_eq!(query, "validateToken"),
        e => panic!("expected Search, got {e:?}"),
    }
}

#[test]
fn gemini_skips_unrecognised_prose() {
    let cases = [
        "Analyzed dependency graph.",
        "Done.",
        "",
        "   ",
        "Investigating.",
    ];
    for line in cases {
        let events = crate::agents::gemini::parse_tool_events(line);
        assert!(events.is_empty(), "should skip: {line}");
    }
}

// ---------------------------------------------------------------------
// Cross-adapter symmetry
// ---------------------------------------------------------------------

#[test]
fn same_logical_read_produces_same_variant_across_adapters() {
    let claude = crate::agents::claude::parse_tool_events(
        r#"{"type":"tool_use","name":"Read","input":{"file_path":"a.ts"}}"#,
    );
    let codex = crate::agents::codex::parse_tool_events(
        r#"{"type":"function_call","name":"read","arguments":{"path":"a.ts"}}"#,
    );
    let gemini = crate::agents::gemini::parse_tool_events("Reading a.ts");
    for events in [&claude, &codex, &gemini] {
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], ToolEvent::FileRead { .. }));
    }
}

#[test]
fn same_logical_bash_produces_same_variant_across_adapters() {
    let claude = crate::agents::claude::parse_tool_events(
        r#"{"type":"tool_use","name":"Bash","input":{"command":"pnpm test"}}"#,
    );
    let codex = crate::agents::codex::parse_tool_events(
        r#"{"type":"function_call","name":"shell","arguments":{"command":["bash","-c","pnpm test"]}}"#,
    );
    let gemini = crate::agents::gemini::parse_tool_events("Running: pnpm test");
    for events in [&claude, &codex, &gemini] {
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], ToolEvent::Bash { .. }));
    }
}
