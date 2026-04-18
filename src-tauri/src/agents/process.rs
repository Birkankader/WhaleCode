//! Subprocess mechanics shared across the three agent adapters.
//!
//! Every adapter does the same dance: spawn a CLI with a prompt piped
//! to stdin, forward stdout+stderr lines to a log channel, respect a
//! wall-clock timeout, and honor a cancellation token. We centralize
//! that here so the individual adapter files stay focused on flags and
//! output-format quirks.

use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use super::AgentError;

/// Default deadline for a master's `plan()` call.
pub const DEFAULT_PLAN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Default deadline for a worker's `execute()` call.
pub const DEFAULT_EXECUTE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// A completed run's captured output. `stdout` and `stderr` are the
/// concatenation of every line the child emitted, in arrival order,
/// without the trailing newline. `exit_status` is the raw OS status
/// the child exited with.
#[derive(Debug)]
pub struct ChildOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
}

/// Parameters for a single run of an agent CLI. Kept as a struct so
/// callers can populate by field without juggling a five-arg function.
pub struct RunSpec<'a> {
    /// Absolute path to the CLI binary (from detection).
    pub binary: &'a std::path::Path,
    /// Argument list — adapter-specific (e.g. `["--print", "-p"]`).
    pub args: Vec<String>,
    /// Optional working directory for the child. Falls back to the
    /// current process cwd when `None`.
    pub cwd: Option<&'a std::path::Path>,
    /// UTF-8 prompt written to stdin. We close stdin after writing so
    /// the CLI sees EOF and can finish.
    pub stdin: Option<String>,
    /// Deadline for the whole run. On expiry we kill the child and
    /// return [`AgentError::Timeout`].
    pub timeout: Duration,
    /// Log sink. Each stdout/stderr line is forwarded here. A full
    /// channel never blocks the agent — we drop the line and keep
    /// collecting.
    pub log_tx: Option<mpsc::Sender<String>>,
    /// Cancel token. If triggered, the child is killed and
    /// [`AgentError::Cancelled`] is returned.
    pub cancel: CancellationToken,
}

/// Spawn, stream, and await the child. Returns the captured output
/// on natural exit (whatever the status code). Timeout and cancel
/// are converted into the matching [`AgentError`] variants before
/// they get anywhere near the caller.
pub async fn run_streaming(spec: RunSpec<'_>) -> Result<ChildOutput, AgentError> {
    let mut cmd = Command::new(spec.binary);
    cmd.args(&spec.args)
        .stdin(if spec.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = spec.cwd {
        cmd.current_dir(cwd);
    }

    let mut child = cmd.spawn().map_err(|e| AgentError::SpawnFailed {
        cause: format!("{e}"),
    })?;

    if let Some(prompt) = spec.stdin {
        if let Some(mut stdin) = child.stdin.take() {
            // Best-effort. If the child closed stdin on its own (e.g.
            // crashed instantly), the write errors — surface that as
            // a spawn failure since we didn't even get to run.
            if let Err(e) = stdin.write_all(prompt.as_bytes()).await {
                let _ = child.kill().await;
                return Err(AgentError::SpawnFailed {
                    cause: format!("writing prompt to stdin failed: {e}"),
                });
            }
            // Explicit drop → EOF. The child sees its turn is over.
            drop(stdin);
        }
    }

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let log_tx_a = spec.log_tx.clone();
    let log_tx_b = spec.log_tx.clone();

    let stdout_task = tokio::spawn(collect_lines(stdout, log_tx_a));
    let stderr_task = tokio::spawn(collect_lines(stderr, log_tx_b));

    // Four things can end the run: natural exit, timeout, cancel, or
    // the child getting killed externally. We race them.
    let outcome = tokio::select! {
        wait = timeout(spec.timeout, child.wait()) => Outcome::NaturalOrTimeout(wait),
        _ = spec.cancel.cancelled() => Outcome::Cancelled,
    };

    // No matter how we got here, drain the line-collector tasks so we
    // capture everything the child wrote before we killed it.
    let stdout_lines = stdout_task.await.unwrap_or_default();
    let stderr_lines = stderr_task.await.unwrap_or_default();
    let stdout = stdout_lines.join("\n");
    let stderr = stderr_lines.join("\n");

    match outcome {
        Outcome::NaturalOrTimeout(Ok(Ok(status))) => Ok(ChildOutput {
            stdout,
            stderr,
            exit_code: status.code(),
            signal: unix_signal(&status),
        }),
        Outcome::NaturalOrTimeout(Ok(Err(e))) => Err(AgentError::SpawnFailed {
            cause: format!("waiting on child failed: {e}"),
        }),
        Outcome::NaturalOrTimeout(Err(_elapsed)) => {
            let _ = child.kill().await;
            Err(AgentError::Timeout {
                after_secs: spec.timeout.as_secs(),
            })
        }
        Outcome::Cancelled => {
            let _ = child.kill().await;
            Err(AgentError::Cancelled)
        }
    }
}

enum Outcome<T> {
    NaturalOrTimeout(T),
    Cancelled,
}

/// Read lines from a child pipe, forwarding each to `log_tx` (if
/// provided) and returning the full collected list. We tolerate
/// invalid UTF-8 by falling back to lossy conversion — no agent
/// output is worth failing the whole run over.
async fn collect_lines<R>(reader: R, log_tx: Option<mpsc::Sender<String>>) -> Vec<String>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let mut lines = Vec::new();
    let mut buf = BufReader::new(reader).lines();
    while let Ok(Some(line)) = buf.next_line().await {
        if let Some(tx) = &log_tx {
            // Drop if full; never block the subprocess.
            let _ = tx.try_send(line.clone());
        }
        lines.push(line);
    }
    lines
}

#[cfg(unix)]
fn unix_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn unix_signal(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

/// Classify a non-zero exit as "agent crashed" vs "agent controlled-
/// refused". Phase 2 uses a stderr keyword heuristic; Phase 3 will
/// refine based on observed patterns per adapter.
pub fn classify_nonzero(exit_code: Option<i32>, signal: Option<i32>, stderr: &str) -> AgentError {
    let lower = stderr.to_ascii_lowercase();
    let sounds_controlled = ["cannot", "refuse", "unable", "failed to"]
        .iter()
        .any(|kw| lower.contains(kw));
    if sounds_controlled {
        AgentError::TaskFailed {
            reason: first_meaningful_line(stderr).unwrap_or_else(|| "non-zero exit".to_string()),
        }
    } else {
        AgentError::ProcessCrashed { exit_code, signal }
    }
}

fn first_meaningful_line(s: &str) -> Option<String> {
    s.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.to_string())
}

// -- Simple {{var}} template rendering -------------------------------
//
// All three master prompts are static templates with a handful of
// variable slots — no conditionals, no loops. Pulling in a full
// handlebars / minijinja for that is heavy. This 20-line substituter
// does the job and has zero deps.

/// Replace every `{{key}}` in `template` with the matching value from
/// `vars`. Unmatched keys resolve to an empty string (so prompts can
/// reference optional context like `{{claude_md}}` without the caller
/// guarding every case). Unknown keys inside `vars` are tolerated.
///
/// The template syntax deliberately doesn't support escapes — if a
/// prompt ever needs a literal `{{`, switch to a real templating lib
/// at that point and don't try to patch this helper.
pub fn render_template(template: &str, vars: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    loop {
        let Some(open) = rest.find("{{") else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..open]);
        let after_open = &rest[open + 2..];
        let Some(close) = after_open.find("}}") else {
            // Unterminated `{{`. Treat literally — safer than panic.
            out.push_str(&rest[open..]);
            return out;
        };
        let key = after_open[..close].trim();
        if let Some(val) = vars.iter().find(|(k, _)| *k == key).map(|(_, v)| *v) {
            out.push_str(val);
        }
        rest = &after_open[close + 2..];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_substitutes_known_keys() {
        let out = render_template("hello {{name}}", &[("name", "world")]);
        assert_eq!(out, "hello world");
    }

    #[test]
    fn render_drops_unknown_keys() {
        let out = render_template("a {{missing}} b", &[]);
        assert_eq!(out, "a  b");
    }

    #[test]
    fn render_handles_multiple_occurrences() {
        let out = render_template("{{x}} and {{x}}", &[("x", "same")]);
        assert_eq!(out, "same and same");
    }

    #[test]
    fn render_preserves_unterminated_braces() {
        let out = render_template("prefix {{ no end", &[]);
        assert_eq!(out, "prefix {{ no end");
    }

    #[test]
    fn render_trims_whitespace_around_key() {
        let out = render_template("{{  name  }}", &[("name", "ok")]);
        assert_eq!(out, "ok");
    }

    #[test]
    fn classify_crash_when_stderr_is_generic() {
        match classify_nonzero(Some(1), None, "stack trace ...") {
            AgentError::ProcessCrashed { exit_code, .. } => assert_eq!(exit_code, Some(1)),
            e => panic!("expected ProcessCrashed, got {e:?}"),
        }
    }

    #[test]
    fn classify_task_failed_on_refusal_keywords() {
        match classify_nonzero(Some(2), None, "I cannot complete this task") {
            AgentError::TaskFailed { reason } => {
                assert!(reason.contains("cannot"));
            }
            e => panic!("expected TaskFailed, got {e:?}"),
        }
    }
}
