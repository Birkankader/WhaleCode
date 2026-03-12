use serde::Serialize;
use specta::Type;

#[derive(Debug, Clone, Serialize, Type)]
pub struct RoutingSuggestion {
    pub suggested_tool: String,
    pub confidence: f32,
    pub reason: String,
    pub alternative_tool: Option<String>,
    pub tool_available: bool,
}

// Re-export orchestrator types for convenience
// Note: these re-exports are used by downstream modules and the IPC boundary.
#[allow(unused_imports)]
pub use super::orchestrator::{
    AgentConfig, AgentContextInfo, DecompositionResult, OrchestrationPhase, OrchestrationPlan,
    OrchestratorConfig, SubTask, SubTaskDef, WorkerResult,
};
