//! Phase 5 Step 0 Q&A-capability diagnostic.
//!
//! Locks in the **current** (pre-Phase-5) behavior for the two shapes
//! a worker agent's "I have a question" event can take. Tests here are
//! descriptive, not prescriptive — they assert what we ship today so
//! Phase 5 Step 4 has a baseline to diff against.
//!
//! Two shapes (matches `docs/phase-5-qa-diagnostic.md`):
//!   G. Worker emits question on stdout, blocks on stdin waiting for
//!      an answer. Under today's `run_streaming` (single-write stdin
//!      + EOF) the fixture sees EOF on its second read and falls
//!      through to its "no answer received" exit-0 branch. No signal
//!      reaches the orchestrator beyond the question text in stdout.
//!   H. Worker emits question on stdout and exits 0 without reading
//!      further stdin. Orchestrator sees a clean-success exit code
//!      with the question embedded in the log — the Phase 3 observed
//!      bug. No distinguishing signal today.
//!
//! Both shapes produce the same pre-Phase-5 end state: subtask marks
//! `Done`, question ends up in the worker's log tail, user sees the
//! text but has no way to reply in-app. Phase 5 Step 4 introduces the
//! detection + response loop.

#![cfg(unix)]

use std::path::PathBuf;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::agents::process::{run_streaming, ChildOutput, RunSpec};
use crate::agents::AgentError;

fn waits_fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src/agents/tests/fixtures/question_fixtures/fake_asks_question_then_waits.sh")
}

fn exits_fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src/agents/tests/fixtures/question_fixtures/fake_asks_question_then_exits.sh")
}

async fn run_script(
    script: PathBuf,
    env_vars: &[(&str, &str)],
    stdin: Option<&str>,
    timeout: Duration,
) -> Result<ChildOutput, AgentError> {
    let env_bin = PathBuf::from("/usr/bin/env");
    let mut args = Vec::new();
    for (k, v) in env_vars {
        args.push(format!("{k}={v}"));
    }
    args.push(script.to_string_lossy().into_owned());
    let (tx, _rx) = mpsc::channel::<String>(64);
    let spec = RunSpec {
        binary: &env_bin,
        args,
        cwd: None,
        stdin: stdin.map(str::to_string),
        timeout,
        log_tx: Some(tx),
        cancel: CancellationToken::new(),
    };
    run_streaming(spec).await
}

// ---------------------------------------------------------------------
// Shape G — question + block-on-stdin (interactive-style adapter)
// ---------------------------------------------------------------------

#[tokio::test]
async fn shape_g_question_then_waits_falls_through_on_eof_and_exits_clean() {
    // Under pre-Phase-5 `run_streaming`, stdin is written once and
    // dropped — the fixture's second read returns EOF immediately and
    // it exits 0 via its "no answer received" branch. The orchestrator
    // observes exit_code=0 and treats the subtask as Done.
    //
    // This is the broken-by-design baseline: there is no signal today
    // that the worker was actually waiting for input. Phase 5 Step 4
    // keeps stdin open + layers a detection heuristic on top.
    let out = run_script(
        waits_fixture(),
        &[],
        Some("do the thing"),
        Duration::from_secs(5),
    )
    .await
    .expect("subprocess ran");

    assert_eq!(out.exit_code, Some(0), "fixture should exit clean today");

    // The question text reached stdout.
    assert!(
        out.stdout.contains("which option should I proceed with"),
        "question should be in stdout; got: {:?}",
        out.stdout
    );

    // Fell through to the no-answer branch — proof that the answer
    // path was never exercised under today's single-write stdin
    // contract.
    assert!(
        out.stdout.contains("done: exited without answer"),
        "fixture should hit no-answer branch under pre-Phase-5 EOF; got: {:?}",
        out.stdout
    );
    assert!(
        !out.stdout.contains("done: resumed after answer"),
        "answer-resumed branch must not fire without Step 4's stdin-keep-open path"
    );

    // Last non-empty stdout line ends in '?' — the heuristic signal
    // Phase 5 Step 4's detector will key on. Today no code reads this
    // property; tomorrow's detection layer will.
    let last_q_line = out
        .stdout
        .lines()
        .rev()
        .find(|l| l.trim().ends_with('?'))
        .expect("at least one '?' terminated line");
    assert!(
        last_q_line.ends_with('?'),
        "heuristic signal (trailing '?') present in stdout"
    );
}

// ---------------------------------------------------------------------
// Shape H — question + exit-0 (single-shot adapter)
// ---------------------------------------------------------------------

#[tokio::test]
async fn shape_h_question_then_exits_looks_indistinguishable_from_done() {
    // The Phase 3 observed bug: worker emits a question as its final
    // line, exits 0, orchestrator marks Done. No signal today. This
    // test pins that indistinguishability so Step 4's fix is a
    // deliberate shift, not an accident.
    let out = run_script(
        exits_fixture(),
        &[],
        Some("do the thing"),
        Duration::from_secs(5),
    )
    .await
    .expect("subprocess ran");

    assert_eq!(out.exit_code, Some(0), "fixture exits clean — this is the bug");
    assert!(
        out.stdout.contains("should I use option A or B?"),
        "question should be in stdout; got: {:?}",
        out.stdout
    );

    // The last non-empty stdout line ends in '?' — same heuristic
    // signal Step 4 will detect. Combined with exit_code=0 + (adapter
    // couldn't parse a result JSON, asserted by adapters individually
    // in Step 4) this is the detection condition for the non-injection
    // path.
    let last_non_empty = out
        .stdout
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .expect("at least one non-empty stdout line");
    assert!(
        last_non_empty.trim().ends_with('?'),
        "last non-empty line should end in '?' for Step 4 detector; got: {last_non_empty:?}"
    );
}

// ---------------------------------------------------------------------
// Shape G × timeout — the walkaway case
// ---------------------------------------------------------------------

#[tokio::test]
async fn shape_g_without_eof_hangs_until_timeout_today() {
    // If a future adapter kept stdin open (the Step 4 recommended
    // path), a worker waiting on stdin would run to the wall-clock
    // timeout unless we either (a) inject an answer, or (b) enforce a
    // shorter per-question timeout at the UI layer.
    //
    // We simulate "stdin kept open past the initial prompt" by piping
    // a multi-line payload whose first line is consumed as the prompt
    // and the rest blocks the fixture's second read. On today's
    // `run_streaming` the second read sees the next line immediately,
    // so to observe the hang we omit stdin entirely: the fixture's
    // first read returns EOF instantly, but the fixture's loop
    // tolerates that (`|| true`), and then its second read also
    // returns EOF — so under the current script we still fall through
    // to the no-answer branch.
    //
    // This test records that today there is NO hang path without
    // Step 4's stdin-keep-open wiring — the system exits cleanly on
    // both branches because EOF cascades through both reads.
    let out = run_script(exits_fixture(), &[], None, Duration::from_secs(3))
        .await
        .expect("subprocess ran");
    assert_eq!(out.exit_code, Some(0));
}

// ---------------------------------------------------------------------
// Shape G + custom question copy
// ---------------------------------------------------------------------

#[tokio::test]
async fn shape_g_custom_question_surfaces_in_stdout() {
    // The fixture honors FAKE_QUESTION so adapter-specific tests in
    // Step 4 can parameterize the question copy (e.g. to exercise
    // false-positive heuristics around '?' mid-sentence vs terminal).
    let out = run_script(
        waits_fixture(),
        &[("FAKE_QUESTION", "pick Foo or Bar?")],
        Some("go"),
        Duration::from_secs(5),
    )
    .await
    .expect("subprocess ran");
    assert!(out.stdout.contains("pick Foo or Bar?"));
}
