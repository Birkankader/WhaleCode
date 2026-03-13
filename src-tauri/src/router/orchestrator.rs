use serde::{Deserialize, Serialize};
use specta::Type;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AgentConfig {
    pub tool_name: String,
    pub sub_agent_count: u32,
    pub is_master: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct OrchestratorConfig {
    pub agents: Vec<AgentConfig>,
    pub master_agent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SubTask {
    pub id: String,
    pub prompt: String,
    pub assigned_agent: String,
    pub status: String,
    pub parent_task_id: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct OrchestrationPlan {
    pub task_id: String,
    pub original_prompt: String,
    pub sub_tasks: Vec<SubTask>,
    pub master_agent: String,
    pub phase: OrchestrationPhase,
    pub decomposition: Option<DecompositionResult>,
    pub worker_results: Vec<WorkerResult>,
    pub master_process_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct AgentContextInfo {
    pub tool_name: String,
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    pub total_tokens: Option<u32>,
    pub cost_usd: Option<f64>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub enum OrchestrationPhase {
    Decomposing,
    AwaitingApproval,
    Executing,
    WaitingForInput,
    Reviewing,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct DecompositionResult {
    pub tasks: Vec<SubTaskDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SubTaskDef {
    pub agent: String,
    pub prompt: String,
    pub description: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WorkerResult {
    pub task_id: String,
    pub agent: String,
    pub exit_code: i32,
    pub output_summary: String, // last N lines of output
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingQuestion {
    pub question: crate::adapters::Question,
    pub worker_task_id: String,
    pub plan_id: String,
}

pub struct Orchestrator;

impl Orchestrator {
    /// Create an orchestration plan shell. Sub-tasks are populated later by
    /// `dispatch_orchestrated_task` after the master agent decomposes the task.
    pub fn create_plan(prompt: &str, config: &OrchestratorConfig) -> OrchestrationPlan {
        OrchestrationPlan {
            task_id: Uuid::new_v4().to_string(),
            original_prompt: prompt.to_string(),
            sub_tasks: Vec::new(),
            master_agent: config.master_agent.clone(),
            phase: OrchestrationPhase::Decomposing,
            decomposition: None,
            worker_results: Vec::new(),
            master_process_id: None,
        }
    }

    /// Build a prompt that asks the master agent to decompose a task into sub-tasks
    /// and return strict JSON output.
    pub fn build_decompose_prompt(prompt: &str, available_agents: &[AgentConfig]) -> String {
        let agent_list: Vec<String> = available_agents
            .iter()
            .map(|a| format!("- \"{}\"", a.tool_name))
            .collect();

        format!(
            "You are a task orchestrator. Analyze the following task and decompose it into sub-tasks \
             for the available agents. Return ONLY a JSON object with no other text.\n\n\
             Available agents:\n{}\n\n\
             Task: {}\n\n\
             Return format (strict JSON, no markdown fences):\n\
             {{\"tasks\": [{{\"agent\": \"<agent_name>\", \"prompt\": \"<detailed prompt for this agent>\", \"description\": \"<short description>\"}}]}}\n\n\
             Rules:\n\
             - Assign each sub-task to the most appropriate agent\n\
             - Each agent can receive multiple tasks\n\
             - Prompts should be self-contained and detailed\n\
             - You may assign tasks to yourself\n\
             - CRITICAL: Each agent works in an isolated git worktree. To prevent merge conflicts, \
             ensure sub-tasks do NOT modify the same files. If two tasks must touch the same file, \
             merge them into a single task for one agent. Explicitly tell each agent which files it \
             should create or modify and which files it must NOT touch.",
            agent_list.join("\n"),
            prompt
        )
    }

    /// Build a prompt for the master agent to review worker results.
    pub fn build_review_prompt(
        original_prompt: &str,
        worker_results: &[WorkerResult],
    ) -> String {
        let result_sections: Vec<String> = worker_results
            .iter()
            .map(|r| {
                format!(
                    "### {} (exit code: {})\n{}",
                    r.agent, r.exit_code, r.output_summary
                )
            })
            .collect();

        format!(
            "You are reviewing the results of a multi-agent task.\n\n\
             Original task: {}\n\n\
             Worker results:\n{}\n\n\
             Please:\n\
             1. Summarize what each worker accomplished\n\
             2. Identify any conflicts or issues between outputs\n\
             3. Provide a final integration summary\n\
             4. Note any tasks that failed and suggest remediation",
            original_prompt,
            result_sections.join("\n\n")
        )
    }

    /// Build the master agent's prompt that includes task decomposition instructions.
    // Planned for future use: alternative orchestration flow.
    #[allow(dead_code)]
    pub fn build_master_prompt(prompt: &str, agents: &[AgentConfig]) -> String {
        let worker_list: Vec<String> = agents
            .iter()
            .filter(|a| !a.is_master)
            .map(|a| {
                format!(
                    "- {} (x{} sub-agents)",
                    a.tool_name, a.sub_agent_count
                )
            })
            .collect();

        format!(
            "You are the master orchestrator agent. Your task is to coordinate and review the work \
             of the following worker agents:\n\
             {}\n\n\
             Original task: {}\n\n\
             Instructions:\n\
             1. Break down the original task into sub-tasks for each worker agent.\n\
             2. Monitor the progress of each sub-task.\n\
             3. Review and integrate the results from all worker agents.\n\
             4. Ensure consistency and resolve any conflicts between the outputs.\n\
             5. Provide a final summary of the completed work.",
            worker_list.join("\n"),
            prompt
        )
    }

    /// Prompt sent to master when a worker asks a question.
    pub fn build_question_relay_prompt(worker_agent: &str, question: &str) -> String {
        format!(
            r#"Worker agent "{}" is asking the following question:

{}

If you can answer this confidently, respond with just your answer.
If you need the user's input, respond with exactly this JSON format:
{{"ask_user": "<your question for the user>"}}"#,
            worker_agent, question
        )
    }

    /// Prompt sent to master for context backup before /clear.
    pub fn build_context_backup_prompt() -> String {
        r#"Back up all context from this session. Write a comprehensive summary including:
- Original task and sub-tasks assigned
- What each worker agent accomplished and their results
- Which files were changed
- Open questions or remaining work
- Key decisions and their rationale

Respond with exactly this JSON format:
{"context_backup": "<your markdown summary>"}"#.to_string()
    }

    /// Prompt sent to new master to restore context after /clear.
    pub fn build_context_restore_prompt(context_md: &str, new_prompt: &str) -> String {
        format!(
            r#"Previous session context is below. Read and remember it, then proceed to the new task.

{}

---
New task: {}"#,
            context_md, new_prompt
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_plan_creates_empty_shell() {
        let config = OrchestratorConfig {
            agents: vec![
                AgentConfig {
                    tool_name: "claude".to_string(),
                    sub_agent_count: 1,
                    is_master: true,
                },
                AgentConfig {
                    tool_name: "gemini".to_string(),
                    sub_agent_count: 1,
                    is_master: false,
                },
            ],
            master_agent: "claude".to_string(),
        };

        let plan = Orchestrator::create_plan("refactor auth module", &config);
        assert!(plan.sub_tasks.is_empty());
        assert_eq!(plan.master_agent, "claude");
        assert_eq!(plan.original_prompt, "refactor auth module");
        assert_eq!(plan.phase, OrchestrationPhase::Decomposing);
        assert!(plan.decomposition.is_none());
        assert!(plan.worker_results.is_empty());
    }

    #[test]
    fn master_prompt_includes_workers() {
        let agents = vec![
            AgentConfig {
                tool_name: "claude".to_string(),
                sub_agent_count: 1,
                is_master: true,
            },
            AgentConfig {
                tool_name: "gemini".to_string(),
                sub_agent_count: 2,
                is_master: false,
            },
        ];

        let prompt = Orchestrator::build_master_prompt("fix bugs", &agents);
        assert!(prompt.contains("gemini"));
        assert!(prompt.contains("fix bugs"));
        assert!(prompt.contains("master orchestrator"));
    }

    #[test]
    fn decompose_prompt_includes_agents_and_task() {
        let agents = vec![
            AgentConfig { tool_name: "claude".to_string(), sub_agent_count: 1, is_master: true },
            AgentConfig { tool_name: "gemini".to_string(), sub_agent_count: 1, is_master: false },
        ];
        let prompt = Orchestrator::build_decompose_prompt("refactor auth", &agents);
        assert!(prompt.contains("gemini"));
        assert!(prompt.contains("claude"));
        assert!(prompt.contains("refactor auth"));
        assert!(prompt.contains("JSON"));
    }

    #[test]
    fn review_prompt_includes_worker_results() {
        let results = vec![WorkerResult {
            task_id: "t1".to_string(),
            agent: "gemini".to_string(),
            exit_code: 0,
            output_summary: "Analysis complete".to_string(),
        }];
        let prompt = Orchestrator::build_review_prompt("fix bugs", &results);
        assert!(prompt.contains("fix bugs"));
        assert!(prompt.contains("gemini"));
        assert!(prompt.contains("Analysis complete"));
    }

    #[test]
    fn test_orchestration_phase_has_waiting_for_input() {
        let phase = OrchestrationPhase::WaitingForInput;
        let json = serde_json::to_string(&phase).unwrap();
        assert!(json.contains("WaitingForInput"));
    }

    #[test]
    fn test_orchestration_plan_has_master_process_id() {
        let config = OrchestratorConfig {
            agents: vec![],
            master_agent: "claude".to_string(),
        };
        let plan = Orchestrator::create_plan("test prompt", &config);
        assert!(plan.master_process_id.is_none());
    }

    #[test]
    fn test_pending_question_struct() {
        let entry = PendingQuestion {
            question: crate::adapters::Question {
                source_agent: "codex".to_string(),
                content: "Which DB?".to_string(),
                question_type: crate::adapters::QuestionType::Clarification,
            },
            worker_task_id: "task-123".to_string(),
            plan_id: "plan-1".to_string(),
        };
        assert_eq!(entry.worker_task_id, "task-123");
        assert_eq!(entry.plan_id, "plan-1");
    }

    #[test]
    fn test_build_question_relay_prompt() {
        let prompt = Orchestrator::build_question_relay_prompt("codex", "Which DB?");
        assert!(prompt.contains("codex"));
        assert!(prompt.contains("Which DB?"));
        assert!(prompt.contains("ask_user"));
    }

    #[test]
    fn test_build_context_backup_prompt() {
        let prompt = Orchestrator::build_context_backup_prompt();
        assert!(prompt.contains("context_backup"));
        assert!(prompt.contains("comprehensive summary"));
    }

    #[test]
    fn test_build_context_restore_prompt() {
        let prompt = Orchestrator::build_context_restore_prompt("prev context here", "new task");
        assert!(prompt.contains("prev context here"));
        assert!(prompt.contains("new task"));
        assert!(prompt.contains("Previous session context"));
    }

    // === Integration tests: cross-module data structure verification ===

    #[test]
    fn test_full_plan_lifecycle() {
        let config = OrchestratorConfig {
            agents: vec![
                AgentConfig {
                    tool_name: "claude".to_string(),
                    sub_agent_count: 1,
                    is_master: true,
                },
                AgentConfig {
                    tool_name: "gemini".to_string(),
                    sub_agent_count: 1,
                    is_master: false,
                },
            ],
            master_agent: "claude".to_string(),
        };
        let plan = Orchestrator::create_plan("optimize code", &config);
        assert!(plan.master_process_id.is_none());
        assert_eq!(plan.phase, OrchestrationPhase::Decomposing);
        assert!(plan.sub_tasks.is_empty());
        assert!(plan.decomposition.is_none());
        assert!(plan.worker_results.is_empty());
        assert_eq!(plan.master_agent, "claude");
    }

    #[test]
    fn test_decomposition_result_parsing() {
        let json = r#"{"tasks":[{"agent":"codex","prompt":"analyze","description":"analyze code"}]}"#;
        let result: DecompositionResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.tasks.len(), 1);
        assert_eq!(result.tasks[0].agent, "codex");
        assert_eq!(result.tasks[0].prompt, "analyze");
        assert_eq!(result.tasks[0].description, "analyze code");
    }

    #[test]
    fn test_ask_user_response_parsing() {
        use crate::adapters::AskUserResponse;
        let json = r#"{"ask_user": "Which database schema?"}"#;
        let resp: AskUserResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.ask_user, "Which database schema?");
    }

    #[test]
    fn test_all_prompt_builders_combined() {
        let q = Orchestrator::build_question_relay_prompt("codex", "Which DB?");
        assert!(q.contains("codex") && q.contains("ask_user"));

        let b = Orchestrator::build_context_backup_prompt();
        assert!(b.contains("context_backup"));

        let r = Orchestrator::build_context_restore_prompt("old context", "new task");
        assert!(r.contains("old context") && r.contains("new task"));

        let agents = vec![
            AgentConfig { tool_name: "claude".to_string(), sub_agent_count: 1, is_master: true },
            AgentConfig { tool_name: "gemini".to_string(), sub_agent_count: 1, is_master: false },
        ];
        let d = Orchestrator::build_decompose_prompt("fix auth", &agents);
        assert!(d.contains("fix auth") && d.contains("JSON"));

        let results = vec![WorkerResult {
            task_id: "t1".to_string(),
            agent: "gemini".to_string(),
            exit_code: 0,
            output_summary: "Done".to_string(),
        }];
        let rv = Orchestrator::build_review_prompt("fix auth", &results);
        assert!(rv.contains("fix auth") && rv.contains("Done"));
    }

    #[test]
    fn test_decomposition_result_with_depends_on() {
        let json = r#"{"tasks":[
            {"agent":"claude","prompt":"create schema","description":"DB schema","depends_on":[]},
            {"agent":"gemini","prompt":"build api","description":"API endpoints","depends_on":["t1"]}
        ]}"#;
        let result: DecompositionResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.tasks.len(), 2);
        assert!(result.tasks[0].depends_on.is_empty());
        assert_eq!(result.tasks[1].depends_on, vec!["t1"]);
    }

    #[test]
    fn test_pending_question_with_adapter_question() {
        let pq = PendingQuestion {
            question: crate::adapters::Question {
                source_agent: "gemini".to_string(),
                content: "Need clarification".to_string(),
                question_type: crate::adapters::QuestionType::Clarification,
            },
            worker_task_id: "worker-1".to_string(),
            plan_id: "plan-x".to_string(),
        };
        assert_eq!(pq.worker_task_id, "worker-1");
        assert_eq!(pq.question.source_agent, "gemini");
        assert_eq!(pq.question.content, "Need clarification");
        assert!(matches!(pq.question.question_type, crate::adapters::QuestionType::Clarification));
    }
}
