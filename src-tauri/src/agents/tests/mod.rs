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
