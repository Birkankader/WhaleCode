use serde::Serialize;
use specta::Type;

#[derive(Debug, Clone, Serialize, Type, PartialEq)]
pub enum MessageSource {
    System,
    Agent(String), // tool_name: "claude" | "gemini" | "codex"
}

#[derive(Debug, Clone, Serialize, Type, PartialEq)]
pub enum MessageType {
    OrchestrationStarted,
    TaskAssigned,
    TaskCompleted,
    TaskFailed,
    AgentSummary,
    MasterDecision,
    DecompositionResult,
    ReviewResult,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct MessengerMessage {
    pub id: String,
    pub timestamp: i64, // millis since epoch (for specta compat)
    pub source: MessageSource,
    pub content: String,
    pub message_type: MessageType,
    pub plan_id: String, // which orchestration plan this belongs to
}

impl MessengerMessage {
    pub fn system(plan_id: &str, content: String, message_type: MessageType) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now().timestamp_millis(),
            source: MessageSource::System,
            content,
            message_type,
            plan_id: plan_id.to_string(),
        }
    }

    pub fn agent(plan_id: &str, agent: &str, content: String, message_type: MessageType) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now().timestamp_millis(),
            source: MessageSource::Agent(agent.to_string()),
            content,
            message_type,
            plan_id: plan_id.to_string(),
        }
    }
}
