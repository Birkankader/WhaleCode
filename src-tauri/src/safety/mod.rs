//! Safety gate stub (Phase 3 Step 7 / Q7).
//!
//! The goal of the stub is to establish an integration seam that Phase 7
//! can fill without re-threading any plumbing. Today [`SafetyGate`] is a
//! zero-sized marker and every action is declared safe; the dispatcher
//! still asks before every relevant worker operation so the call sites
//! are proven correct end-to-end. When real policy lands (Phase 7), the
//! only changes will be:
//!
//!   1. `SafetyGate` gains state (config, policy store, audit log sink).
//!   2. [`SafetyGate::is_action_safe`] returns `false` for denied actions
//!      and `true` for allowed ones, instead of the unconditional `true`
//!      used today.
//!   3. Call sites that currently ignore the result start honoring it —
//!      they're already wired in.
//!
//! Deliberately **not** a trait right now: the stub has no variant
//! behavior, and Phase 7 will likely need more than one sync method
//! (async audit logging, per-agent policy lookups). Keeping it a
//! concrete struct avoids churn on the trait signature between here and
//! then. Tests can still exercise the seam by constructing the real
//! struct — Phase 7 can swap in a trait object behind a type alias if
//! a mockable surface becomes useful.
//!
//! The dispatcher / lifecycle hold this inside an `Arc` alongside the
//! event sink and storage handle; `SafetyGate` is `Clone` + `Send + Sync`
//! so those patterns work without wrapping.

use std::path::PathBuf;

/// Sensitive actions a worker might take inside its worktree. The
/// variants are open-set: more actions land in Phase 7 when real
/// policy arrives. Today only [`FileWrite`] / [`FileDelete`] / [`Shell`]
/// are populated and no call site inspects the payload — the enum
/// exists so the seam is shaped correctly for when it does.
#[derive(Debug, Clone)]
#[allow(dead_code)] // Phase 7 will read these fields.
pub enum AgentAction {
    /// Worker wrote (or proposed to write) a file. Path is absolute.
    FileWrite { path: PathBuf },
    /// Worker deleted (or proposed to delete) a file. Path is absolute.
    FileDelete { path: PathBuf },
    /// Worker proposed to run a shell command. String is the command
    /// line as the worker would execute it; Phase 7 policy can match
    /// on substrings (e.g. "rm -rf", "curl | sh", network access).
    Shell { command: String },
}

/// Policy oracle. Phase 3 never denies; Phase 7 fills in real checks.
///
/// Thread this into the dispatcher alongside the storage + event sink.
/// Call [`SafetyGate::is_action_safe`] before any action that Phase 7
/// will eventually need to police. The Phase 3 contract is "return
/// true, but be called from every relevant site" — the seam is the
/// point, not the policy.
#[derive(Debug, Clone, Default)]
pub struct SafetyGate {
    // No fields in Phase 3. Marker struct.
}

impl SafetyGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Phase 3: always `true`. Phase 7: consults policy.
    ///
    /// Intentionally takes `&self` (not `&mut self`) so call sites can
    /// share a single gate behind an `Arc` without any locking. When
    /// Phase 7 adds mutable state (audit counters, rate tracking), the
    /// internal mutability goes inside the struct — the public
    /// signature doesn't change.
    #[allow(dead_code)] // Dispatcher call sites land in a follow-up.
    pub fn is_action_safe(&self, _action: &AgentAction) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_allows_every_action_variant() {
        // Phase 3 contract: every action is safe. Pinning this so a
        // Phase 7 policy change deliberately breaks it — when that test
        // fails, the rewrite must update call sites too.
        let gate = SafetyGate::new();
        assert!(gate.is_action_safe(&AgentAction::FileWrite {
            path: PathBuf::from("/tmp/x")
        }));
        assert!(gate.is_action_safe(&AgentAction::FileDelete {
            path: PathBuf::from("/tmp/y")
        }));
        assert!(gate.is_action_safe(&AgentAction::Shell {
            command: "rm -rf /".into(),
        }));
    }

    #[test]
    fn gate_is_cloneable_and_send() {
        // Pin the `Send + Sync + Clone` contract so Phase 7 doesn't
        // silently regress it when adding fields.
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<SafetyGate>();
        let a = SafetyGate::new();
        let _b = a.clone();
    }
}
