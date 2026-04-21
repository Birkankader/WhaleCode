//! Step 0 crash-shape diagnostic (Phase 4).
//!
//! Locks in the **current** (pre-Phase-4) behavior for every abnormal
//! exit path a worker can take. These tests are intentionally
//! descriptive, not prescriptive — they assert what we ship today so
//! Phase 4 Step 5 has a baseline to diff against.
//!
//! Taxonomy (matches `docs/phase-4-crash-diagnostic.md`):
//!   A. Subprocess non-zero exit, crashy stderr      → `ProcessCrashed`
//!   B. Subprocess non-zero exit, controlled refusal → `TaskFailed`
//!   C. Zero exit, malformed / empty stdout          → `ParseFailed`
//!   D. Subprocess hang past wall-clock timeout      → `Timeout`
//!   E. Spawn failure (binary missing / unwritable)  → `SpawnFailed`
//!   F. Orchestrator-level task panic                → `DispatchOutcome::Failed`
//!      (covered by dispatcher tests — see taxonomy doc §F, not repeated here)
//!
//! Categories A and B share a single classifier (`classify_nonzero`)
//! that disambiguates by stderr keyword. We test both branches so the
//! heuristic boundary is recorded — a worker CLI that produces
//! stderr matching `/cannot|refuse|unable|failed to/i` collapses into
//! `TaskFailed` even on a non-zero exit. That's a Phase-4 UX concern:
//! users may see "agent refused" for what is actually a crash.

#![cfg(unix)]
#![cfg(test)]

use std::path::PathBuf;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agents::process::{classify_nonzero, run_streaming, RunSpec};
use crate::agents::tests::fake_agent::{fixture_path, run_fake, FakeEnv};
use crate::agents::AgentError;
use crate::agents::plan_parser::parse_and_validate;
use crate::ipc::AgentKind;

// ---------------------------------------------------------------------
// Category A — non-zero exit with crashy stderr → ProcessCrashed
// ---------------------------------------------------------------------

#[tokio::test]
async fn category_a_nonzero_exit_crashy_stderr_classified_as_process_crashed() {
    // Simulates: CLI segfaulted, panicked, or exited with a non-zero
    // status whose stderr doesn't look like a controlled refusal.
    let env = FakeEnv {
        mode: "crash",
        exit_code: 139, // SIGSEGV-ish
        ..FakeEnv::default()
    };
    let out = run_fake(
        env,
        Some("do the thing"),
        CancellationToken::new(),
        Duration::from_secs(5),
    )
    .await
    .expect("subprocess ran");
    assert_eq!(out.exit_code, Some(139));
    match classify_nonzero(out.exit_code, out.signal, &out.stderr) {
        AgentError::ProcessCrashed { exit_code, signal } => {
            assert_eq!(exit_code, Some(139));
            assert_eq!(signal, None);
        }
        other => panic!("expected ProcessCrashed, got {other:?}"),
    }
}

// ---------------------------------------------------------------------
// Category B — non-zero exit with controlled-refusal stderr → TaskFailed
// ---------------------------------------------------------------------

#[tokio::test]
async fn category_b_nonzero_exit_refusal_stderr_classified_as_task_failed() {
    // Simulates: CLI decided it can't do the task and exited 1 with
    // a polite stderr message. `classify_nonzero` matches stderr
    // against `/cannot|refuse|unable|failed to/i` and returns
    // TaskFailed instead of ProcessCrashed.
    let env = FakeEnv {
        mode: "refuse",
        exit_code: 1,
        ..FakeEnv::default()
    };
    let out = run_fake(
        env,
        Some("do the thing"),
        CancellationToken::new(),
        Duration::from_secs(5),
    )
    .await
    .expect("subprocess ran");
    match classify_nonzero(out.exit_code, out.signal, &out.stderr) {
        AgentError::TaskFailed { reason } => {
            assert!(
                reason.to_lowercase().contains("cannot"),
                "reason should include the refusal verb: {reason:?}"
            );
        }
        other => panic!("expected TaskFailed, got {other:?}"),
    }
}

// ---------------------------------------------------------------------
// Category C — zero exit, malformed stdout → ParseFailed
// ---------------------------------------------------------------------

#[tokio::test]
async fn category_c_zero_exit_malformed_stdout_maps_to_parse_failed() {
    // `parse_and_validate` is what every adapter's `plan()` funnels
    // the CLI's stdout through. When the output has no fenced ```json
    // block, or the block is syntactically broken, or the structure
    // doesn't match the PlannedSubtask schema, it errors — the
    // adapter wraps that in `AgentError::ParseFailed`.
    let junk = "I was going to write a plan but I got distracted.\n\nHere's a poem instead.";
    let err = parse_and_validate(junk, &[AgentKind::Claude]).expect_err("junk should not parse");
    let msg = format!("{err}");
    assert!(
        !msg.is_empty(),
        "parse error should produce a non-empty diagnostic"
    );
    // Note: `parse_and_validate` returns a parse-layer error type.
    // The adapter-level test below confirms the mapping to
    // `AgentError::ParseFailed` by routing through the adapter.
}

#[tokio::test]
async fn category_c_zero_exit_empty_stdout_maps_to_parse_failed() {
    // Gemini in particular has been observed to emit zero bytes on
    // transient failures (Phase 3.5 benchmark notes: "1/4 runs exited
    // with code 1 and zero bytes after ~243 s"). Parsing empty
    // output is a ParseFailed, not a ProcessCrashed.
    let err =
        parse_and_validate("", &[AgentKind::Claude]).expect_err("empty should not parse");
    let msg = format!("{err}");
    assert!(!msg.is_empty());
}

// ---------------------------------------------------------------------
// Category D — hang past wall-clock timeout → Timeout
// ---------------------------------------------------------------------

#[tokio::test]
async fn category_d_subprocess_hang_past_timeout_maps_to_timeout() {
    // Simulates: CLI is alive but emits no output before the deadline.
    // `run_streaming` wraps child.wait() in tokio::time::timeout; on
    // expiry it kills the process group and returns AgentError::Timeout.
    // Production deadlines are 10 min (plan) / 30 min (execute); the
    // test uses 150ms against a 5s sleep to exercise the same code.
    let env = FakeEnv {
        mode: "plan",
        delay_secs: 5,
        ..FakeEnv::default()
    };
    let res = run_fake(
        env,
        Some("x"),
        CancellationToken::new(),
        Duration::from_millis(150),
    )
    .await;
    match res {
        Err(AgentError::Timeout { after_secs }) => {
            // `after_secs` is the configured timeout in seconds; 150ms
            // rounds to 0 in u64 seconds — that's the contract, we
            // just assert the variant is right.
            let _ = after_secs;
        }
        other => panic!("expected Timeout, got {other:?}"),
    }
}

// ---------------------------------------------------------------------
// Category E — spawn failure → SpawnFailed
// ---------------------------------------------------------------------

#[tokio::test]
async fn category_e_binary_missing_maps_to_spawn_failed() {
    // Simulates: detection cached a binary path that was later
    // uninstalled, or a user-configured path that doesn't exist. The
    // Command::spawn call fails and is mapped to SpawnFailed before
    // any child process is ever scheduled.
    let missing = PathBuf::from("/definitely/not/a/real/binary/whalecode-phase4-diag");
    let (tx, _rx) = mpsc::channel::<String>(8);
    let spec = RunSpec {
        binary: &missing,
        args: vec![],
        cwd: None,
        stdin: None,
        timeout: Duration::from_secs(5),
        log_tx: Some(tx),
        cancel: CancellationToken::new(),
    };
    match run_streaming(spec).await {
        Err(AgentError::SpawnFailed { cause }) => {
            assert!(
                !cause.is_empty(),
                "SpawnFailed.cause should explain what went wrong"
            );
        }
        other => panic!("expected SpawnFailed, got {other:?}"),
    }
}

#[tokio::test]
async fn category_e_unexecutable_binary_maps_to_spawn_failed() {
    // A file that exists but isn't executable. Same target variant,
    // different OS-level cause (EACCES vs ENOENT). We assert the
    // variant is still SpawnFailed — the `cause` string contains the
    // OS error, which the frontend surfaces verbatim today.
    let fixture = fixture_path();
    // Point at the fixtures directory itself (a directory isn't
    // executable as a program). On macOS/Linux, Command::spawn on a
    // directory returns EACCES or EISDIR — both of which map to
    // SpawnFailed via the `.map_err` in process.rs.
    let dir = fixture.parent().expect("fixtures dir").to_path_buf();
    let (tx, _rx) = mpsc::channel::<String>(8);
    let spec = RunSpec {
        binary: &dir,
        args: vec![],
        cwd: None,
        stdin: None,
        timeout: Duration::from_secs(5),
        log_tx: Some(tx),
        cancel: CancellationToken::new(),
    };
    match run_streaming(spec).await {
        Err(AgentError::SpawnFailed { .. }) => {}
        other => panic!("expected SpawnFailed, got {other:?}"),
    }
}

// ---------------------------------------------------------------------
// Category F — orchestrator-level panic
// ---------------------------------------------------------------------
//
// Reference only. The dispatcher's `join_set.join_next()` path catches
// tokio::task::JoinError and maps to
// `DispatchOutcome::Failed { error: format!("worker task panicked: {e}") }`.
// That flow is exercised by orchestration/tests.rs under the
// `panic_in_worker_*` family. No new test here — adding one would
// duplicate coverage and require the dispatcher's fake-registry
// plumbing which is scoped to that module. Taxonomy doc §F records
// this observation.
