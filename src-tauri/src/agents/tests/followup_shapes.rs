//! Phase 7 Step 0 follow-up turn diagnostic.
//!
//! Locks in the **expected shape** of follow-up turns across the
//! three adapters. Tests here are descriptive, not prescriptive —
//! they exercise a paired set of fixtures (with-parent-context vs
//! fresh-prompt) so Step 5's production follow-up dispatch path
//! has a baseline to reason about.
//!
//! Three adapter shapes (matches `docs/phase-7-followup-diagnostic.md`):
//!   Claude — stream-json NDJSON, same envelope as Phase 6 Step 2
//!            production output. Follow-up shows up as one extra
//!            `Bash git log` discovery + one extra thinking block
//!            when no parent-context prefix is supplied.
//!   Codex  — `exec --json` JSONL, same envelope as Phase 6 Step 2.
//!            Follow-up shows up as one extra `shell` function_call
//!            (`git log`) when no parent-context prefix is supplied.
//!   Gemini — `--output-format text --yolo` plain prose. Follow-up
//!            shows up as 2-3 extra prose lines of git log discovery
//!            in the prefix-less case. Heuristic regex matcher
//!            catches the verb-prefix lines either way.
//!
//! Each adapter has a `*_followup.sh` (with parent-context prefix
//! in the upstream prompt — agent skips none of the discovery)
//! plus a `*_followup_fresh.sh` (no prefix — agent skips git-log
//! discovery, goes straight to source).
//!
//! The *with-prefix* fixture intentionally has the agent doing
//! more work (git log discovery) rather than less, because the
//! parent-context prefix appears in the prompt body but the
//! agent still inspects the worktree to confirm. This mirrors
//! real-world follow-up behavior where the agent treats the
//! prompt as untrusted hint and verifies via tools. The
//! recommendation in the diagnostic doc explains the cost
//! tradeoff.

#![cfg(unix)]

use std::path::PathBuf;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agents::process::{run_streaming, ChildOutput, RunSpec};
use crate::agents::AgentError;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src/agents/tests/followup_fixtures")
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
// Claude — stream-json NDJSON follow-up
// ---------------------------------------------------------------------

#[tokio::test]
async fn claude_followup_with_context_emits_discovery_bash_event() {
    let out = run_fixture("claude_followup.sh").await.expect("ran");
    assert_eq!(out.exit_code, Some(0));
    let lines: Vec<&str> = out.stdout.lines().collect();

    // With parent-context prefix: agent confirms via `git log` first.
    let bash_events: Vec<&&str> = lines
        .iter()
        .filter(|l| l.contains(r#""name":"Bash""#))
        .collect();
    let git_log = bash_events
        .iter()
        .any(|l| l.contains(r#""command":"git log"#));
    assert!(
        git_log,
        "expected `git log` discovery Bash event in with-context follow-up"
    );

    // Two thinking blocks: discovery + extension reasoning.
    let thinking: Vec<&&str> = lines
        .iter()
        .filter(|l| l.contains(r#""type":"thinking""#))
        .collect();
    assert_eq!(thinking.len(), 2, "expected 2 thinking blocks");

    // Edits are still on the parent's signup file.
    assert!(out.stdout.contains(r#""file_path":"src/signup.tsx""#));
}

#[tokio::test]
async fn claude_followup_fresh_skips_git_log_discovery() {
    let out = run_fixture("claude_followup_fresh.sh").await.expect("ran");
    assert_eq!(out.exit_code, Some(0));
    let lines: Vec<&str> = out.stdout.lines().collect();

    // Without prefix: agent skips `git log` — fewer bash events,
    // fewer thinking blocks. This is the cost-saving the diagnostic
    // recommends.
    let git_log_events = lines
        .iter()
        .filter(|l| l.contains(r#""command":"git log"#))
        .count();
    assert_eq!(
        git_log_events, 0,
        "fresh follow-up should not run `git log`"
    );

    let thinking: Vec<&&str> = lines
        .iter()
        .filter(|l| l.contains(r#""type":"thinking""#))
        .collect();
    assert_eq!(
        thinking.len(),
        1,
        "fresh follow-up should emit 1 thinking block (vs 2 with parent context)"
    );

    // Same edits land on the same target file.
    assert!(out.stdout.contains(r#""file_path":"src/signup.tsx""#));
}

// ---------------------------------------------------------------------
// Codex — exec --json JSONL follow-up
// ---------------------------------------------------------------------

#[tokio::test]
async fn codex_followup_with_context_emits_shell_discovery() {
    let out = run_fixture("codex_followup.sh").await.expect("ran");
    assert_eq!(out.exit_code, Some(0));
    let lines: Vec<&str> = out.stdout.lines().collect();

    // With parent-context prefix: shell function_call for `git log`
    // appears in the trace.
    let function_calls: Vec<&&str> = lines
        .iter()
        .filter(|l| l.contains(r#""type":"function_call""#))
        .collect();
    assert!(
        function_calls.len() >= 4,
        "expected ≥4 function_call events in with-context follow-up"
    );

    let has_git_log = function_calls
        .iter()
        .any(|l| l.contains(r#""command":"git log"#));
    assert!(
        has_git_log,
        "expected `git log` shell discovery in with-context follow-up"
    );

    // apply_patch event covers both edits + new test file in one shot.
    assert!(out.stdout.contains(r#""name":"apply_patch""#));
    assert!(out.stdout.contains("signup.test.tsx"));
}

#[tokio::test]
async fn codex_followup_fresh_skips_shell_discovery() {
    let out = run_fixture("codex_followup_fresh.sh").await.expect("ran");
    assert_eq!(out.exit_code, Some(0));
    let lines: Vec<&str> = out.stdout.lines().collect();

    // Without prefix: no `git log` shell call.
    let has_git_log = lines
        .iter()
        .any(|l| l.contains(r#""command":"git log"#));
    assert!(
        !has_git_log,
        "fresh follow-up should not run `git log` shell discovery"
    );

    // Three function_calls (read + apply_patch + test shell) instead of four.
    let function_calls: Vec<&&str> = lines
        .iter()
        .filter(|l| l.contains(r#""type":"function_call""#))
        .collect();
    assert_eq!(
        function_calls.len(),
        3,
        "fresh follow-up should have 3 function_calls (vs 4 with prefix)"
    );

    // Same apply_patch lands on the same files.
    assert!(out.stdout.contains(r#""name":"apply_patch""#));
}

// ---------------------------------------------------------------------
// Gemini — text/prose follow-up
// ---------------------------------------------------------------------

#[tokio::test]
async fn gemini_followup_with_context_emits_discovery_prose() {
    let out = run_fixture("gemini_followup.sh").await.expect("ran");
    assert_eq!(out.exit_code, Some(0));

    // With parent-context prefix: discovery prose lines appear.
    assert!(
        out.stdout.contains("git log"),
        "expected `git log` discovery prose in with-context follow-up"
    );
    assert!(
        out.stdout.contains("Looking at recent commits"),
        "expected discovery framing prose"
    );

    // Heuristic regex matcher's verb-prefix patterns still catch the
    // edits + run lines.
    assert!(out.stdout.contains("Editing src/signup.tsx"));
    assert!(out.stdout.contains("Running: pnpm test"));
}

#[tokio::test]
async fn gemini_followup_fresh_skips_discovery_prose() {
    let out = run_fixture("gemini_followup_fresh.sh").await.expect("ran");
    assert_eq!(out.exit_code, Some(0));

    // Without prefix: no `git log` discovery prose, no "Looking at"
    // framing.
    assert!(
        !out.stdout.contains("git log"),
        "fresh follow-up should not emit `git log` prose"
    );
    assert!(
        !out.stdout.contains("Looking at recent commits"),
        "fresh follow-up should not emit discovery framing"
    );

    // Same editing prose pattern lands.
    assert!(out.stdout.contains("Editing src/signup.tsx"));
}

// ---------------------------------------------------------------------
// Cross-adapter — discovery delta is real and consistent
// ---------------------------------------------------------------------

#[tokio::test]
async fn followup_with_prefix_consistently_costs_more_per_adapter() {
    let claude_with = run_fixture("claude_followup.sh").await.expect("ran");
    let claude_fresh = run_fixture("claude_followup_fresh.sh").await.expect("ran");

    let codex_with = run_fixture("codex_followup.sh").await.expect("ran");
    let codex_fresh = run_fixture("codex_followup_fresh.sh").await.expect("ran");

    let gemini_with = run_fixture("gemini_followup.sh").await.expect("ran");
    let gemini_fresh = run_fixture("gemini_followup_fresh.sh").await.expect("ran");

    // Per-adapter line-count delta — with-prefix fixture is longer
    // because the agent runs discovery tools the fresh fixture
    // skips. This locks in the diagnostic's recommendation that
    // Phase 7 Step 5 should ship the **fresh-prompt** shape (parent
    // commit SHA + branch reference, NOT the full parent transcript).
    let claude_delta = claude_with.stdout.lines().count() as i32
        - claude_fresh.stdout.lines().count() as i32;
    let codex_delta =
        codex_with.stdout.lines().count() as i32 - codex_fresh.stdout.lines().count() as i32;
    let gemini_delta =
        gemini_with.stdout.lines().count() as i32 - gemini_fresh.stdout.lines().count() as i32;

    assert!(
        claude_delta > 0,
        "with-prefix Claude follow-up should produce more lines than fresh"
    );
    assert!(
        codex_delta > 0,
        "with-prefix Codex follow-up should produce more lines than fresh"
    );
    assert!(
        gemini_delta > 0,
        "with-prefix Gemini follow-up should produce more lines than fresh"
    );
}
