//! Wrapper around the `fake_agent.sh` shell fixture.
//!
//! The fixture lives at `src/agents/tests/fixtures/fake_agent.sh` and
//! is resolved relative to `CARGO_MANIFEST_DIR` so it works under
//! `cargo test` regardless of where the suite is invoked from.
//!
//! Exercises the shared [`super::super::process::run_streaming`] path
//! end-to-end: real subprocess spawn, stdin pipe, line streaming,
//! timeout, cancellation. Adapter-level tests layer on top of this.

use std::path::PathBuf;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agents::process::{run_streaming, ChildOutput, RunSpec};
use crate::agents::AgentError;

pub fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src/agents/tests/fixtures/fake_agent.sh")
}

/// Default knobs: mode=plan, exit=0, no delay, no forced stderr. The
/// caller mutates before handing to `run_fake`.
pub struct FakeEnv {
    pub mode: &'static str,
    pub exit_code: i32,
    pub delay_secs: u64,
    pub stderr: Option<String>,
    pub output_file: Option<PathBuf>,
}

impl Default for FakeEnv {
    fn default() -> Self {
        Self {
            mode: "plan",
            exit_code: 0,
            delay_secs: 0,
            stderr: None,
            output_file: None,
        }
    }
}

pub async fn run_fake(
    env: FakeEnv,
    stdin: Option<&str>,
    cancel: CancellationToken,
    timeout: Duration,
) -> Result<ChildOutput, AgentError> {
    // We shell out through `/usr/bin/env KEY=VAL ... <script>` so
    // each test injects its own env without touching the current
    // process — parallel tests stay race-free and we don't need an
    // `env` field on RunSpec just for tests.
    let script = fixture_path();
    let env_bin = PathBuf::from("/usr/bin/env");

    let mut args = Vec::new();
    args.push(format!("FAKE_MODE={}", env.mode));
    args.push(format!("FAKE_EXIT_CODE={}", env.exit_code));
    args.push(format!("FAKE_DELAY_SECS={}", env.delay_secs));
    if let Some(s) = &env.stderr {
        args.push(format!("FAKE_STDERR={s}"));
    }
    if let Some(p) = &env.output_file {
        args.push(format!("FAKE_OUTPUT_FILE={}", p.display()));
    }
    args.push(script.to_string_lossy().into_owned());

    // Tests that care about the logs build their own channel; we
    // discard here (the caller can inspect stdout/stderr on the
    // returned ChildOutput).
    let (tx, _rx) = mpsc::channel::<String>(64);
    let spec = RunSpec {
        binary: &env_bin,
        args,
        cwd: None,
        stdin: stdin.map(str::to_string),
        timeout,
        log_tx: Some(tx),
        cancel,
    };
    run_streaming(spec).await
}

#[cfg(unix)]
#[cfg(test)]
mod integration {
    use super::*;
    use crate::agents::plan_parser::parse_and_validate;
    use crate::ipc::AgentKind;

    #[tokio::test]
    async fn plan_mode_produces_parseable_plan() {
        let out = run_fake(
            FakeEnv::default(),
            Some("Build a dark-mode toggle."),
            CancellationToken::new(),
            Duration::from_secs(5),
        )
        .await
        .expect("fake_agent run");
        assert_eq!(out.exit_code, Some(0));
        let plan = parse_and_validate(&out.stdout, &[AgentKind::Claude]).unwrap();
        assert_eq!(plan.subtasks.len(), 2);
    }

    #[tokio::test]
    async fn crash_mode_non_zero_exit_with_crash_stderr_classified_as_crash() {
        let env = FakeEnv {
            mode: "crash",
            exit_code: 139,
            ..FakeEnv::default()
        };
        let out = run_fake(env, Some("x"), CancellationToken::new(), Duration::from_secs(5))
            .await
            .expect("fake_agent run");
        assert_eq!(out.exit_code, Some(139));
        // The script wrote "fatal: segfault ..." to stderr.
        match crate::agents::process::classify_nonzero(
            out.exit_code,
            out.signal,
            &out.stderr,
        ) {
            AgentError::ProcessCrashed { exit_code, .. } => assert_eq!(exit_code, Some(139)),
            e => panic!("expected ProcessCrashed, got {e:?}"),
        }
    }

    #[tokio::test]
    async fn refuse_mode_classified_as_task_failed() {
        let env = FakeEnv {
            mode: "refuse",
            exit_code: 1,
            ..FakeEnv::default()
        };
        let out = run_fake(env, Some("x"), CancellationToken::new(), Duration::from_secs(5))
            .await
            .expect("fake_agent run");
        match crate::agents::process::classify_nonzero(
            out.exit_code,
            out.signal,
            &out.stderr,
        ) {
            AgentError::TaskFailed { reason } => assert!(reason.to_lowercase().contains("cannot")),
            e => panic!("expected TaskFailed, got {e:?}"),
        }
    }

    #[tokio::test]
    async fn timeout_returns_timeout_error() {
        let env = FakeEnv {
            mode: "plan",
            delay_secs: 5,
            ..FakeEnv::default()
        };
        let res = run_fake(
            env,
            Some("x"),
            CancellationToken::new(),
            Duration::from_millis(200),
        )
        .await;
        match res {
            Err(AgentError::Timeout { .. }) => {}
            other => panic!("expected Timeout, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn cancellation_returns_cancelled_error() {
        let env = FakeEnv {
            mode: "plan",
            delay_secs: 5,
            ..FakeEnv::default()
        };
        let cancel = CancellationToken::new();
        let cancel2 = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            cancel2.cancel();
        });
        let res = run_fake(env, Some("x"), cancel, Duration::from_secs(5)).await;
        match res {
            Err(AgentError::Cancelled) => {}
            other => panic!("expected Cancelled, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn log_channel_receives_streamed_lines() {
        let bin = fixture_path();
        let (tx, mut rx) = mpsc::channel::<String>(64);
        let env_bin = PathBuf::from("/usr/bin/env");
        let spec = RunSpec {
            binary: &env_bin,
            args: vec![
                "FAKE_MODE=execute".into(),
                bin.to_string_lossy().into_owned(),
            ],
            cwd: None,
            stdin: Some("run it".into()),
            timeout: Duration::from_secs(5),
            log_tx: Some(tx),
            cancel: CancellationToken::new(),
        };
        run_streaming(spec).await.unwrap();
        let mut lines = Vec::new();
        while let Ok(line) = rx.try_recv() {
            lines.push(line);
        }
        assert!(lines.iter().any(|l| l.contains("starting")));
        assert!(lines.iter().any(|l| l.contains("done: edited")));
    }
}
