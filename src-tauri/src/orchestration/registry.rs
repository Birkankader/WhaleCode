//! Maps [`AgentKind`] → concrete [`AgentImpl`] for the orchestrator.
//!
//! The orchestrator never constructs adapters directly. Instead it
//! asks the registry, which:
//! - knows where each binary lives (via settings override or
//!   [`Detector`]),
//! - returns an `Arc<dyn AgentImpl>` that worker tasks can share,
//! - reports which kinds are actually runnable so the master's
//!   prompt only mentions workers we can dispatch.
//!
//! Tests substitute their own [`AgentRegistry`] impl to inject a
//! fake agent without touching the production detection path.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use thiserror::Error;

use crate::agents::claude::ClaudeAdapter;
use crate::agents::codex::CodexAdapter;
use crate::agents::gemini::GeminiAdapter;
use crate::agents::AgentImpl;
use crate::detection::Detector;
use crate::ipc::{AgentKind, AgentStatus};

#[derive(Debug, Error)]
pub enum RegistryError {
    #[error("agent {kind:?} is not available ({reason})")]
    Unavailable {
        kind: AgentKind,
        reason: String,
    },
}

/// Trait object so tests can swap in a fake registry that hands
/// out `FakeAgent` regardless of kind.
#[async_trait]
pub trait AgentRegistry: Send + Sync {
    /// Construct an adapter for `kind`. Called once per run-role:
    /// the master gets one instance; each worker *kind* gets one
    /// instance shared across its subtasks (adapters are stateless
    /// apart from their binary path, so sharing is safe).
    async fn get(&self, kind: AgentKind) -> Result<Arc<dyn AgentImpl>, RegistryError>;

    /// Kinds that are detectably available right now. The master
    /// prompt's `available_workers` list comes from here, so an
    /// unavailable agent never appears in plan output.
    async fn available(&self) -> Vec<AgentKind>;
}

/// Production registry: delegates detection to [`Detector`]. Caches
/// nothing — each `get` re-probes so a user who just installed a
/// binary doesn't need to restart the app.
pub struct DefaultAgentRegistry {
    detector: Arc<Detector>,
}

impl DefaultAgentRegistry {
    pub fn new(detector: Arc<Detector>) -> Self {
        Self { detector }
    }
}

#[async_trait]
impl AgentRegistry for DefaultAgentRegistry {
    async fn get(&self, kind: AgentKind) -> Result<Arc<dyn AgentImpl>, RegistryError> {
        let status = self.detector.detect(kind).await;
        match status {
            AgentStatus::Available { version, binary_path } => Ok(construct(kind, binary_path, version)),
            AgentStatus::Broken { binary_path, error } => Err(RegistryError::Unavailable {
                kind,
                reason: format!("{}: {error}", binary_path.display()),
            }),
            AgentStatus::NotInstalled => Err(RegistryError::Unavailable {
                kind,
                reason: "not installed".into(),
            }),
        }
    }

    async fn available(&self) -> Vec<AgentKind> {
        let probe = self.detector.detect_all().await;
        let mut out = Vec::new();
        if matches!(probe.claude, AgentStatus::Available { .. }) {
            out.push(AgentKind::Claude);
        }
        if matches!(probe.codex, AgentStatus::Available { .. }) {
            out.push(AgentKind::Codex);
        }
        if matches!(probe.gemini, AgentStatus::Available { .. }) {
            out.push(AgentKind::Gemini);
        }
        out
    }
}

fn construct(kind: AgentKind, binary: PathBuf, version: String) -> Arc<dyn AgentImpl> {
    match kind {
        AgentKind::Claude => Arc::new(ClaudeAdapter::new(binary, version)),
        AgentKind::Codex => Arc::new(CodexAdapter::new(binary, version)),
        AgentKind::Gemini => Arc::new(GeminiAdapter::new(binary, version)),
    }
}
