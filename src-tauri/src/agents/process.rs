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
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use super::AgentError;

/// Upper bound on how long we wait for the stdout/stderr drain tasks to
/// finish after a cancel / timeout. If the child's grandchildren keep a
/// pipe fd open past a kill (common with agent CLIs that spawn MCP
/// servers or tool runners), `BufReader::next_line()` blocks on EOF
/// forever — we abort the drain task at this deadline so the outer run
/// returns promptly. The lines the drain would have captured are
/// post-kill noise; losing them is the point.
const DRAIN_DEADLINE: Duration = Duration::from_millis(500);

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
    install_new_process_group(&mut cmd);

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

    // On non-natural exits (timeout or cancel) we kill the whole process
    // group, not just the direct child: agent CLIs routinely spawn
    // grandchildren (MCP servers, tool runners) that inherit the stdout
    // fd. A plain `child.kill()` reaches only the direct PID; the
    // grandchildren keep running, the pipe stays open, and the drain
    // tasks below park on `next_line` forever. See the commit message
    // for the investigation that uncovered this. Natural exit path
    // leaves the group alone — the child already reaped it.
    let natural_exit = matches!(outcome, Outcome::NaturalOrTimeout(Ok(Ok(_))));
    if !natural_exit {
        kill_process_group(&mut child).await;
    }

    // Drain with a deadline. If the pipes are still open after the
    // group kill (possible if a grandchild escaped the group, e.g. a
    // daemonized subprocess on another session), abort the drain tasks
    // rather than hang the orchestrator. The captured lines we lose are
    // post-kill output.
    let stdout = drain_lines(stdout_task).await;
    let stderr = drain_lines(stderr_task).await;
    let stdout = stdout.join("\n");
    let stderr = stderr.join("\n");

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
        Outcome::NaturalOrTimeout(Err(_elapsed)) => Err(AgentError::Timeout {
            after_secs: spec.timeout.as_secs(),
        }),
        Outcome::Cancelled => Err(AgentError::Cancelled),
    }
}

/// Drain a line-collector task within [`DRAIN_DEADLINE`]. Returns
/// whatever lines the task produced by the deadline; on timeout the
/// task is aborted so its `BufReader` on the (possibly still-open) pipe
/// is released and any post-deadline lines are discarded.
async fn drain_lines(mut handle: tokio::task::JoinHandle<Vec<String>>) -> Vec<String> {
    tokio::select! {
        res = &mut handle => res.unwrap_or_default(),
        _ = tokio::time::sleep(DRAIN_DEADLINE) => {
            handle.abort();
            Vec::new()
        }
    }
}

/// On Unix, put the child in its own process group/session so we can
/// signal every descendant (including grandchildren spawned by agent
/// tool runners) in one call via `killpg`. No-op on Windows —
/// equivalent functionality requires Job Objects which are tracked as a
/// separate follow-up in `docs/KNOWN_ISSUES.md`.
#[cfg(unix)]
fn install_new_process_group(cmd: &mut Command) {
    // `tokio::process::Command` exposes `pre_exec` as an inherent unix
    // method (not through `std::os::unix::process::CommandExt`), so no
    // trait import is needed.
    //
    // SAFETY: `pre_exec` runs between fork and exec in the child. The
    // closure must be async-signal-safe — `setsid` is on the
    // POSIX-listed safe set, and we don't allocate, lock, or call into
    // any non-reentrant code here. `setsid` failure is possible only if
    // the child is already a session leader (it isn't, post-fork).
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn install_new_process_group(_cmd: &mut Command) {
    // Windows path: see docs/KNOWN_ISSUES.md (`Windows cancel cleanup`)
    // — Job Objects dep not yet pulled in.
}

/// Kill the child *and every descendant* it spawned. On Unix we send
/// `SIGKILL` to `-pgid` (negative pid in `kill(2)` targets the whole
/// process group we created in [`install_new_process_group`]); on
/// Windows we fall back to the direct child kill pending Job Object
/// support.
#[cfg(unix)]
async fn kill_process_group(child: &mut Child) {
    if let Some(pid) = child.id() {
        // SAFETY: `kill(2)` with a negative pid targets the process
        // group whose leader is `pid` (because we called `setsid` in
        // the child). We ignore the return value: ESRCH means the
        // group already exited, EPERM means another session owns it
        // (never should happen for our own children). Both are
        // no-progress outcomes for cleanup purposes.
        unsafe {
            libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
        }
    }
    // Belt-and-suspenders: reap the direct child so the OS releases
    // its zombie entry and `wait` on the JoinHandle completes promptly.
    // Errors are ignored — the group kill already did the work.
    let _ = child.kill().await;
}

#[cfg(not(unix))]
async fn kill_process_group(child: &mut Child) {
    let _ = child.kill().await;
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

/// Run `git status --porcelain` inside `worktree` and return the set of
/// paths with pending changes (working tree + index). Every adapter's
/// `execute()` ends with this — it's more reliable than asking the
/// agent to self-report what it touched.
///
/// On any git failure we return `Ok(vec![])` rather than surface the
/// error: worktree state mid-failure is orchestrator territory, and
/// returning "no diff" cleanly beats a failure cascade here.
pub async fn git_changed_files(worktree: &std::path::Path) -> std::io::Result<Vec<std::path::PathBuf>> {
    let out = Command::new("git")
        .arg("status")
        .arg("--porcelain")
        .current_dir(worktree)
        .output()
        .await?;
    if !out.status.success() {
        return Ok(vec![]);
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut files = Vec::new();
    for line in stdout.lines() {
        // porcelain: two status chars, space, path. Rename entries are
        // "orig -> new" — we take the "new" side.
        if line.len() < 4 {
            continue;
        }
        let path = &line[3..];
        let path = path.split(" -> ").last().unwrap_or(path);
        files.push(std::path::PathBuf::from(path.trim()));
    }
    Ok(files)
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

    // ---- Cancellation regression tests (Phase 3.5 cancel fix) --------
    //
    // Both tests run real subprocesses, so they live under `#[cfg(unix)]`
    // — the grandchild-pipe-leak fix is Unix-specific (Windows tracked
    // as follow-up in docs/KNOWN_ISSUES.md). They guard two things:
    //
    // 1. `cancel_returns_promptly_for_simple_child` — the base contract:
    //    cancel → Err(Cancelled) within ~2s.
    // 2. `cancel_kills_grandchildren_holding_stdout_open` — the
    //    regression that produced the Phase 3 closeout bug: without a
    //    process-group kill, the grandchild (`sleep`) keeps the stdout
    //    pipe open after `sh` dies, `BufReader::next_line` never sees
    //    EOF, and `run_streaming` hangs past the 2s budget. With the
    //    fix (pre_exec setsid + killpg on cancel + drain deadline) it
    //    completes in well under a second.
    #[cfg(unix)]
    #[tokio::test]
    async fn cancel_returns_promptly_for_simple_child() {
        let cancel = CancellationToken::new();
        let spec = RunSpec {
            binary: std::path::Path::new("/bin/sh"),
            args: vec!["-c".into(), "sleep 30".into()],
            cwd: None,
            stdin: None,
            timeout: Duration::from_secs(60),
            log_tx: None,
            cancel: cancel.clone(),
        };

        let cancel_fire = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            cancel_fire.cancel();
        });

        let started = std::time::Instant::now();
        let result = run_streaming(spec).await;
        let elapsed = started.elapsed();

        assert!(matches!(result, Err(AgentError::Cancelled)));
        assert!(
            elapsed < Duration::from_secs(2),
            "cancel took {elapsed:?}; expected < 2s"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancel_kills_grandchildren_holding_stdout_open() {
        // `sh` spawns `sleep` as a same-process-group child that
        // inherits stdout. Without our setsid+killpg fix, killing the
        // direct `sh` leaves `sleep` alive holding the pipe writer,
        // `BufReader::next_line()` blocks forever, and `run_streaming`
        // deadlocks — which is exactly the "Cancel does nothing" bug
        // observed in real agent usage.
        let cancel = CancellationToken::new();
        let spec = RunSpec {
            binary: std::path::Path::new("/bin/sh"),
            args: vec!["-c".into(), "echo warmup; sleep 30".into()],
            cwd: None,
            stdin: None,
            timeout: Duration::from_secs(60),
            log_tx: None,
            cancel: cancel.clone(),
        };

        let cancel_fire = cancel.clone();
        tokio::spawn(async move {
            // Give `sh` enough slack to actually fork `sleep` before we
            // cancel; otherwise the test only exercises the simpler
            // "kill before grandchild spawn" path.
            tokio::time::sleep(Duration::from_millis(200)).await;
            cancel_fire.cancel();
        });

        let started = std::time::Instant::now();
        let result = run_streaming(spec).await;
        let elapsed = started.elapsed();

        assert!(matches!(result, Err(AgentError::Cancelled)));
        assert!(
            elapsed < Duration::from_secs(2),
            "cancel with grandchild took {elapsed:?}; expected < 2s \
             (pre-fix this hung indefinitely)"
        );
    }
}
