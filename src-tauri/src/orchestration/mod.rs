//! Orchestration primitives used by the run coordinator.
//!
//! Step 8 will land the coordinator itself here; Step 7 adds only the
//! first piece it needs: the shared-notes file that workers read for
//! context and the master rewrites when it grows. Later steps will
//! add retry policy, the dispatcher, and the run event stream under
//! this same namespace.

pub mod notes;
