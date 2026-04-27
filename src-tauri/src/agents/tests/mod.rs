//! Test-only helpers shared across adapter integration tests.
//!
//! `fake_agent.sh` stands in for a real CLI binary. The helpers in
//! this module locate it on disk and wrap the subprocess module so
//! individual adapter tests read like "configure the fake, run it,
//! assert on the output".

pub mod fake_agent;

// Phase 4 Step 0 diagnostic — asserts current behavior across every
// abnormal worker exit path. Tests-only; does not change production
// behavior. See docs/phase-4-crash-diagnostic.md.
#[cfg(test)]
mod crash_shapes;

// Phase 5 Step 0 Q&A diagnostic — asserts current behavior when a
// worker emits a question and either (G) blocks on stdin or (H) exits
// 0 without reading further. Tests-only; does not change production
// behavior. See docs/phase-5-qa-diagnostic.md.
#[cfg(test)]
mod question_shapes;

// Phase 6 Step 0 tool-use parsing diagnostic — asserts current
// output formats of Claude (stream-json), Codex (exec --json
// JSONL), and Gemini (text/prose). Tests-only; production parser
// lands in Step 2. See docs/phase-6-toolparsing-diagnostic.md.
#[cfg(test)]
mod tool_event_shapes;

// Phase 6 Step 2 — per-adapter parser unit tests for
// `parse_tool_events` and `parse_thinking`. Runs in isolation
// (no subprocess); the fixture-spawn tests live in
// `tool_event_shapes`. See `agents/tool_event.rs` + per-adapter
// modules.
#[cfg(test)]
mod parser_tests;

// Phase 7 Step 0 follow-up turn diagnostic — exercises six
// fixtures (3 adapters × with-parent-context + fresh-prompt)
// and locks in the cost delta the diagnostic's recommendation
// keys on. Tests-only; production follow-up dispatch lands in
// Phase 7 Step 5. See docs/phase-7-followup-diagnostic.md.
#[cfg(test)]
mod followup_shapes;
