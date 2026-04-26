//! Phase 6 Step 0 tool-use parsing diagnostic.
//!
//! Locks in the **current** (pre-Phase-6) behavior of the three
//! adapters' tool-use output formats. Tests here are descriptive,
//! not prescriptive — they exercise the fixtures so Step 2's
//! production parser has a baseline to diff against.
//!
//! Three adapter shapes (matches `docs/phase-6-toolparsing-diagnostic.md`):
//!   Claude — stream-json NDJSON: `{"type":"tool_use","name":"<tool>","input":{...}}`
//!           per line, plus `{"type":"thinking","thinking":"..."}` blocks.
//!   Codex  — `exec --json` JSONL: `{"type":"function_call","name":"<tool>","arguments":{...}}`
//!           per line. No thinking/reasoning blocks emitted.
//!   Gemini — `--output-format text --yolo` plain prose. No
//!           structured tool events; heuristic regex matching only.
//!
//! Each adapter has a happy-path fixture (typical sequence) and an
//! edge-case fixture (malformed lines, unknown tools, multi-file
//! atomicity, prose-collisions for Gemini). The tests assert the
//! fixtures produce the expected line shapes the production parser
//! will key on — they do **not** invoke the parser itself, which
//! lands in Step 2.

#![cfg(unix)]

use std::path::PathBuf;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agents::process::{run_streaming, ChildOutput, RunSpec};
use crate::agents::AgentError;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src/agents/tests/tool_event_fixtures")
        .join(name)
}

async fn run_fixture(name: &str) -> Result<ChildOutput, AgentError> {
    let env_bin = PathBuf::from("/usr/bin/env");
    let script = fixture(name);
    let args = vec![script.to_string_lossy().into_owned()];
    let (tx, _rx) = mpsc::channel::<String>(64);
    let spec = RunSpec {
        binary: &env_bin,
        args,
        cwd: None,
        stdin: None,
        timeout: Duration::from_secs(5),
        log_tx: Some(tx),
        cancel: CancellationToken::new(),
    };
    run_streaming(spec).await
}

// ---------------------------------------------------------------------
// Claude — stream-json NDJSON
// ---------------------------------------------------------------------

#[tokio::test]
async fn claude_happy_emits_tool_use_and_thinking_jsonl() {
    let out = run_fixture("claude_happy.sh").await.expect("ran");
    assert_eq!(out.exit_code, Some(0));
    let lines: Vec<&str> = out.stdout.lines().collect();
    // Each fixture line is a JSON object — Step 2's parser will
    // call `serde_json::from_str` per line.
    let tool_uses: Vec<&&str> = lines
        .iter()
        .filter(|l| l.contains(r#""type":"tool_use""#))
        .collect();
    assert_eq!(tool_uses.len(), 4, "expected 4 tool_use events");
    assert!(tool_uses.iter().any(|l| l.contains(r#""name":"Read""#)));
    assert!(tool_uses.iter().any(|l| l.contains(r#""name":"Grep""#)));
    assert!(tool_uses.iter().any(|l| l.contains(r#""name":"Edit""#)));
    assert!(tool_uses.iter().any(|l| l.contains(r#""name":"Bash""#)));

    let thinking: Vec<&&str> = lines
        .iter()
        .filter(|l| l.contains(r#""type":"thinking""#))
        .collect();
    assert_eq!(thinking.len(), 2, "expected 2 thinking blocks");
}

#[tokio::test]
async fn claude_edge_handles_malformed_unknown_and_long_paths() {
    let out = run_fixture("claude_edge.sh").await.expect("ran");
    assert_eq!(out.exit_code, Some(0));
    let lines: Vec<&str> = out.stdout.lines().collect();
    // One malformed line (truncated `thinking` — missing closing `}`).
    let malformed = lines.iter().filter(|l| {
        l.starts_with(r#"{"type":"thinking","thinking":"#) && !l.ends_with('}')
    });
    assert!(malformed.count() >= 1, "expected at least 1 malformed line");

    // WebFetch is the unknown-tool case — parser routes to ToolEvent::Other.
    assert!(out.stdout.contains(r#""name":"WebFetch""#));

    // Multi-tool burst: 3 Read events back-to-back. Step 2's chip
    // compression collapses these per the dir+kind+window rule.
    let reads: Vec<&&str> = lines
        .iter()
        .filter(|l| l.contains(r#""name":"Read""#))
        .collect();
    assert!(reads.len() >= 4, "expected ≥4 Read events");

    // Long path > 200 chars — parser captures verbatim, UI truncates.
    assert!(out.stdout.contains("very/long/path/that/exceeds"));
}

// ---------------------------------------------------------------------
// Codex — exec --json JSONL
// ---------------------------------------------------------------------

#[tokio::test]
async fn codex_happy_emits_function_call_jsonl() {
    let out = run_fixture("codex_happy.sh").await.expect("ran");
    assert_eq!(out.exit_code, Some(0));
    let lines: Vec<&str> = out.stdout.lines().collect();

    let fcalls: Vec<&&str> = lines
        .iter()
        .filter(|l| l.contains(r#""type":"function_call""#))
        .collect();
    assert_eq!(fcalls.len(), 4, "expected 4 function_call events");
    assert!(fcalls.iter().any(|l| l.contains(r#""name":"read""#)));
    assert!(fcalls.iter().any(|l| l.contains(r#""name":"grep""#)));
    assert!(fcalls.iter().any(|l| l.contains(r#""name":"apply_patch""#)));
    assert!(fcalls.iter().any(|l| l.contains(r#""name":"shell""#)));

    // Codex emits NO thinking events — Step 3 thinking panel stays
    // empty for Codex workers.
    assert!(!out.stdout.contains(r#""type":"thinking""#));
    assert!(!out.stdout.contains(r#""type":"reasoning""#));
}

#[tokio::test]
async fn codex_edge_multi_file_patch_and_unknown_tool() {
    let out = run_fixture("codex_edge.sh").await.expect("ran");
    assert_eq!(out.exit_code, Some(0));

    // apply_patch with three files in `files` array — Step 2 design
    // choice: emit per-file ToolEvent::FileEdit for chip-stack
    // compression uniformity vs Claude single-file edits.
    assert!(out.stdout.contains(r#""files":["src/a.ts","src/b.ts","src/c.ts"]"#));

    // Unknown tool routes to `Other` in Step 2.
    assert!(out.stdout.contains(r#""name":"browse""#));
    assert!(out.stdout.contains(r#""name":"unknown_tool""#));

    // Shell command in array form — parser joins with space for chip label.
    assert!(out.stdout.contains(r#""command":["bash","-c","pnpm test"]"#));
}

// ---------------------------------------------------------------------
// Gemini — text mode, prose-only output
// ---------------------------------------------------------------------

#[tokio::test]
async fn gemini_happy_emits_prose_no_structured_events() {
    let out = run_fixture("gemini_happy.sh").await.expect("ran");
    assert_eq!(out.exit_code, Some(0));

    // Gemini text output is prose. Step 2's heuristic regex
    // matcher keys on opening verbs:
    //   "Reading <path>"       → FileRead
    //   "Edited <path>"        → FileEdit
    //   "Running: <command>"   → Bash
    //   "Searching for '<q>'"  → Search
    assert!(out.stdout.contains("Reading src/auth.ts"));
    assert!(out.stdout.contains("Searching for 'validateToken'"));
    assert!(out.stdout.contains("Edited src/auth.ts"));
    assert!(out.stdout.contains("Running: pnpm test"));

    // No JSON events whatsoever.
    assert!(!out.stdout.contains(r#""type":"tool_use""#));
    assert!(!out.stdout.contains(r#""type":"function_call""#));
}

#[tokio::test]
async fn gemini_edge_prose_collisions_and_quoted_paths() {
    let out = run_fixture("gemini_edge.sh").await.expect("ran");
    assert_eq!(out.exit_code, Some(0));

    // "Reading the spec carefully" — verb collision. Heuristic
    // matcher must NOT trigger FileRead (no path-shaped token after
    // the verb).
    assert!(out.stdout.contains("Reading the spec carefully"));
    // Real FileRead with bare path.
    assert!(out.stdout.contains("Reading src/auth.ts"));
    // Real FileRead with quoted path — variant matcher must accept.
    assert!(out.stdout.contains("Reading 'src/types.ts'"));

    // "Analyzed dependency graph" — no verb match, plain log.
    assert!(out.stdout.contains("Analyzed dependency graph"));

    // Multi-action line — Step 2 design choice: emit single event
    // citing one file, OR split. Diagnostic recommends single-event-
    // per-line for prose mode (compression is best-effort).
    assert!(out.stdout.contains("Edited a.ts and b.ts"));
}
