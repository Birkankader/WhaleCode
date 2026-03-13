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
    // Part of the serialized API; will be used by future orchestration features.
    #[allow(dead_code)]
    AgentSummary,
    // Part of the serialized API; will be used by future orchestration features.
    #[allow(dead_code)]
    MasterDecision,
    DecompositionResult,
    ReviewResult,
    QuestionForUser,
    UserAnswer,
    ContextBackup,
    ContextRestore,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct MessengerMessage {
    pub id: String,
    pub timestamp: f64, // millis since epoch (f64 for JS/specta compat)
    pub source: MessageSource,
    pub content: String,
    pub message_type: MessageType,
    pub plan_id: String, // which orchestration plan this belongs to
}

impl MessengerMessage {
    pub fn system(plan_id: &str, content: String, message_type: MessageType) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now().timestamp_millis() as f64,
            source: MessageSource::System,
            content,
            message_type,
            plan_id: plan_id.to_string(),
        }
    }

    pub fn agent(plan_id: &str, agent: &str, content: String, message_type: MessageType) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now().timestamp_millis() as f64,
            source: MessageSource::Agent(agent.to_string()),
            content,
            message_type,
            plan_id: plan_id.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_message_types_serialize() {
        let types = vec![
            MessageType::QuestionForUser,
            MessageType::UserAnswer,
            MessageType::ContextBackup,
            MessageType::ContextRestore,
        ];
        for t in types {
            let json = serde_json::to_string(&t).unwrap();
            assert!(!json.is_empty());
        }
    }
}
