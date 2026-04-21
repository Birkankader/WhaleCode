# Phase 4 Step 0 — Crash-shape diagnostic

**Date:** 2026-04-22
**Scope:** Inventory every abnormal worker exit path, record current (pre-Phase-4) behavior, recommend Step 5 implementation branch.
**Deliverables:**

- Test suite locking in current behavior: `src-tauri/src/agents/tests/crash_shapes.rs` (7 tests, all green on `main`).
- Taxonomy below.
- Step 5 branch recommendation: **Event-field branch** (middle path between the spec's "UI-only" and "full-branch"). See §Recommendation.

No production code changed in Step 0.

## Where abnormal exits originate

Two layers of the stack produce abnormal exits. Both funnel into the dispatcher's Layer 1 ladder.

- **Process layer** — `src-tauri/src/agents/process.rs::run_streaming` turns real subprocess events into `AgentError` variants. Every adapter (`claude.rs`, `codex.rs`, `gemini.rs`) calls `run_streaming` + `classify_nonzero` + `parse_and_validate`; no adapter invents its own error taxonomy.
- **Orchestration layer** — `src-tauri/src/orchestration/dispatcher.rs::execute_subtask_with_retry` wraps the adapter's `execute` result and maps to `EscalateToMaster::{UserCancelled,Deterministic,Exhausted}`. The `join_set.join_next()` handler catches `tokio::task::JoinError` (i.e. a worker task panic inside the orchestrator itself) and maps to `DispatchOutcome::Failed { error: "worker task panicked: {e}" }`.

## Existing `AgentError` variants

From `src-tauri/src/agents/mod.rs:152`:

```rust
pub enum AgentError {
    ProcessCrashed { exit_code: Option<i32>, signal: Option<i32> },
    TaskFailed    { reason: String },
    ParseFailed   { reason: String, raw_output: String },
    Timeout       { after_secs: u64 },
    Cancelled,
    SpawnFailed   { cause: String },
}
```

Six variants, all distinct, all reachable by the tests in `crash_shapes.rs`. The enum has been stable since Phase 2; Phase 3 added `Cancelled` to the Layer-1 skip set and `SpawnFailed` to the `Deterministic` skip-retry set.

## Category taxonomy

### A. Subprocess non-zero exit — crashy stderr

| Field | Value |
|---|---|
| Trigger | CLI exits with a non-zero status; stderr does not match `/cannot\|refuse\|unable\|failed to/i`. |
| Current `AgentError` | `ProcessCrashed { exit_code, signal }` |
| Classifier | `process::classify_nonzero` (`src-tauri/src/agents/process.rs`) |
| Layer-1 routing | Retried once; on retry fail → `EscalateToMaster::Exhausted` → Layer 2 replan |
| User-visible state | `SubtaskState::Failed` + error string in log stream |
| Distinguishable at Rust layer? | **Yes** — discrete variant |
| Distinguishable in event payload? | **No** — event carries `state` only |
| Test | `category_a_nonzero_exit_crashy_stderr_classified_as_process_crashed` |

### B. Subprocess non-zero exit — controlled refusal stderr

| Field | Value |
|---|---|
| Trigger | CLI exits non-zero with stderr matching the refusal-keyword regex. |
| Current `AgentError` | `TaskFailed { reason }` |
| Classifier | Same `classify_nonzero` heuristic — stderr-keyword branch |
| Layer-1 routing | Retried once; on retry fail → `Exhausted` |
| User-visible state | `SubtaskState::Failed` + refusal reason in log stream |
| Distinguishable at Rust layer? | **Yes** |
| Distinguishable in event payload? | **No** |
| Test | `category_b_nonzero_exit_refusal_stderr_classified_as_task_failed` |
| **UX concern** | The `classify_nonzero` heuristic can miscategorize a real crash whose stderr happens to contain "failed to …" as a controlled refusal. This is Phase-4 UX noise risk — worth calling out when Step 5 designs the banner copy. |

### C. Zero exit — malformed or empty stdout

| Field | Value |
|---|---|
| Trigger | CLI exits 0 but stdout has no fenced `json` block, or the block is syntactically invalid, or the structure doesn't match `PlannedSubtask`. Includes the zero-byte Gemini failure shape documented in Phase 3.5 retro ("1/4 runs exited with code 1 and zero bytes after ~243s"). |
| Current `AgentError` | `ParseFailed { reason, raw_output }` |
| Source | `plan_parser::parse_and_validate` (adapter wraps error → `AgentError::ParseFailed`) |
| Layer-1 routing | Retried once (not deterministic) — but the same input likely produces the same output, so retry is usually wasted effort. Worth a Phase-5 look. |
| User-visible state | `SubtaskState::Failed` + parser diagnostic in log stream |
| Distinguishable at Rust layer? | **Yes** |
| Distinguishable in event payload? | **No** |
| Tests | `category_c_zero_exit_malformed_stdout_maps_to_parse_failed`, `category_c_zero_exit_empty_stdout_maps_to_parse_failed` |

### D. Subprocess hang past wall-clock timeout

| Field | Value |
|---|---|
| Trigger | CLI never exits; produces no output before its deadline. |
| Current `AgentError` | `Timeout { after_secs }` |
| Enforcement | `run_streaming` wraps `child.wait()` in `tokio::time::timeout`; deadlines: `DEFAULT_PLAN_TIMEOUT = 10 min`, `DEFAULT_EXECUTE_TIMEOUT = 30 min`. On expiry, the child's process group is killed (Unix: `setsid` + `killpg`; Windows: orphans possible — KNOWN_ISSUES). |
| Layer-1 routing | Retried once |
| User-visible state | `SubtaskState::Failed` + timeout error in log stream |
| Distinguishable at Rust layer? | **Yes** |
| Distinguishable in event payload? | **No** |
| Test | `category_d_subprocess_hang_past_timeout_maps_to_timeout` |

### E. Spawn failure — binary missing / unexecutable / stdin-write error

| Field | Value |
|---|---|
| Trigger | `Command::spawn` returns `Err`, or stdin write fails before the child runs meaningfully. |
| Current `AgentError` | `SpawnFailed { cause }` |
| Layer-1 routing | **Skips retry** — `EscalateToMaster::Deterministic(AgentError::SpawnFailed)` straight to Layer 2. Re-running a missing binary can't change the outcome. |
| User-visible state | `SubtaskState::Failed` + cause string in log stream |
| Distinguishable at Rust layer? | **Yes** |
| Distinguishable in event payload? | **No** |
| Tests | `category_e_binary_missing_maps_to_spawn_failed`, `category_e_unexecutable_binary_maps_to_spawn_failed` |

### F. Orchestrator-level panic (worker task panic caught by dispatcher)

| Field | Value |
|---|---|
| Trigger | A `tokio::task::JoinError` in `dispatcher.rs` — the worker task itself panicked, got cancelled, or otherwise failed to join cleanly. Not an `AgentError` at all; this is orchestration plumbing failure. |
| Current outcome | `DispatchOutcome::Failed { error: format!("worker task panicked: {e}") }` — whole dispatch aborts, cancel fires, in-flight siblings drain. |
| Coverage today | Exercised by the `retry_*` / `replan_*` family in `src-tauri/src/orchestration/tests.rs`. No new test here — would duplicate that module's fake-registry plumbing. |
| Distinguishable at Rust layer? | **Yes** — separate string path, not an `AgentError` |
| Distinguishable in event payload? | **No** — collapses to `SubtaskState::Failed` + string |

## Side observations

- **Rate-limit (429) detection does not exist as an `AgentError` variant.** The only grep hit is a comment in `gemini.rs:16` noting stderr tolerance for "transient 429 retries." Depending on how the CLI reports the limit, it'll surface as either `ProcessCrashed` (non-zero exit) or `TaskFailed` (if stderr contains a refusal-keyword match). If users report rate-limit confusion, this becomes a Phase 5 item; Phase 4 Step 5 doesn't need it.
- **Timeouts DO exist in the dispatch path** — the spec's open question "if a subprocess hangs with no output, does anything kill it" is resolved: the `run_streaming` wrapper enforces a wall-clock deadline. The hang is bounded by `DEFAULT_{PLAN,EXECUTE}_TIMEOUT`.
- **`SubtaskStateChanged` event payload is minimal** — `{ run_id, subtask_id, state: SubtaskState }`. The error carrying `cause`/`reason`/`raw_output` never crosses the IPC boundary. It enters the run's log stream as a `SubtaskLog` line, where it's free-text.
- **The dispatcher's `EscalateToMaster` enum is already three-way** (`UserCancelled`, `Deterministic`, `Exhausted`) and carries the underlying `AgentError`. The lifecycle's replan helper inspects the variant when building the master replan prompt — so the distinction already affects behavior at least once, it just doesn't reach the UI.

## Step 5 branch recommendation

**Recommend: "Event-field branch"** — a middle path the original spec didn't enumerate, between UI-only and full-branch.

**Rationale:**

- Spec's UI-only branch ("already distinguishable via existing `AgentError`") presumes the frontend can see the discriminant. It can't — today's `SubtaskStateChanged` event carries only the `SubtaskState` enum, and `SubtaskState::Failed` is one variant that subsumes all five Rust-layer error categories. UI-only would ship without the information it needs.
- Spec's full-branch ("needs new state + event + skip-Layer-1 routing") overbuilds. The Rust-layer taxonomy is already rich and the Layer-1 routing is already correct (`SpawnFailed` skips retry, others don't). No new `SubtaskState::Crashed` variant is warranted — the user-facing abstraction is "a thing failed, here's why," not "failed vs crashed" which is a programmer distinction that leaks as implementation detail.
- The minimal change is **add a discriminant field to `SubtaskStateChanged`** (or introduce a sibling `run:subtask_error` event) carrying the `AgentError` variant name and the relevant payload field (`reason`, `cause`, `exit_code`, `after_secs`). Frontend's existing `ErrorBanner` extends to discriminate off that field — one new type, not a new state-machine variant.

### What this means for Step 5 scope

**Scope (full):**

- **Backend:** Extend `RunEvent::SubtaskStateChanged` with an optional `error_category: Option<ErrorCategoryWire>` field *(only meaningful when `state == Failed`)*. `ErrorCategoryWire` is a tagged union matching the five terminal `AgentError` variants (Cancelled excluded — its own state, not a Failed refinement). Alternatively: new `run:subtask_error` event emitted *alongside* `SubtaskStateChanged { state: Failed }`. Event-variant is cleaner; tagged field is cheaper. Pick during implementation — both are ~50 LOC.
- **Frontend:** Zod schema gains the new field / event; `ErrorBanner` switches on `error_category` to produce a distinct banner per category with appropriate copy ("Subprocess crashed (exit 139)", "Subprocess timed out after 30 min", "Couldn't spawn: binary not found", "Plan output couldn't be parsed", "Agent refused task"). One new component variant, not a new component.
- **No new `SubtaskState` variant.** Enum audit unchanged.
- **No SQLite migration** — the error_category is transport-only; it's already folded into the log stream for history via `SubtaskLog`.
- **No Layer-1 routing change** — existing routing is correct.

**Scope (not):**

- No `Crashed` / `Hung` / `ParseFailed` subtask states — UX complexity not justified.
- No timeout-field tuning — keep current defaults.
- No rate-limit variant — if users push on this, Phase 5.

**Revised complexity:** **small-medium (~1.5 days).** Originally scoped at "medium full-branch (3 days)" or "small UI-only (1 day)." Middle path lands between them: the backend change is smaller than full-branch (no enum + migration), and the frontend change is larger than UI-only (need to wire the new field through the event contract + Zod).

### Updated Step 5 acceptance criteria

1. `SubtaskStateChanged` payload (or sibling event) carries an `error_category` discriminant when `state == Failed`, matching one of the five terminal `AgentError` categories from the taxonomy.
2. Frontend `ErrorBanner` shows distinct copy per category. Visual verification: screenshot each branch.
3. Integration test per category asserts event emission + payload shape (leverages existing fake agent fixtures).
4. Layer-1 retry routing is unchanged and re-verified.
5. No `SubtaskState` enum addition, no SQLite migration.
6. `KNOWN_ISSUES.md` entry for "crashes indistinguishable from task failures in UI" moves to "Resolved in Phase 4."

## Surprises / findings

- **None of the spec's "needs new state" conditions hold.** The Rust-layer enum is already rich. The collapse the spec predicted lives one layer higher, in the IPC event contract.
- **`classify_nonzero` is a keyword heuristic, not a robust classifier.** A worker that crashes while writing "failed to reach API" to stderr will be tagged `TaskFailed` rather than `ProcessCrashed`. Worth documenting in KNOWN_ISSUES as debt — not blocking Step 5, but the sort of thing that will bite users in Phase 6+ telemetry. Recommend adding a note to KNOWN_ISSUES.md after Step 1 lands.
- **The Phase 3.5 Gemini observation ("1/4 runs exited with code 1 and zero bytes after ~243s") is category C (ParseFailed on empty stdout), not a Timeout** — the process did exit. A future Phase 5 item might add an adapter-specific "empty output after >N seconds looks like a rate-limit" heuristic, but that's out of Step 5's scope.
- **Timeouts are enforced; the spec's open question is closed.** The infrastructure is correct; Phase 4 doesn't need to add timeout plumbing.
- **Windows still orphans grandchildren on timeout kill.** This is a KNOWN_ISSUES item (v2.5 Job Object work). Phase 4 Step 5 UI inherits whatever signal fidelity Windows has — if the orphaned process eventually writes garbage after the parent returned Timeout, the event is already emitted and the frontend shows the Timeout banner. No new Windows work in Phase 4.

## Deliverables summary

- **Tests:** `src-tauri/src/agents/tests/crash_shapes.rs` (7 tests, all green on `main` — `cargo test --lib agents::tests::crash_shapes`).
- **Wiring:** `src-tauri/src/agents/tests/mod.rs` gains `#[cfg(test)] mod crash_shapes;`.
- **Doc:** this file.
- **Production code:** unchanged.

## Step 5 branch decision

**Event-field branch.** Deferring to your confirmation before Step 1 kickoff.
