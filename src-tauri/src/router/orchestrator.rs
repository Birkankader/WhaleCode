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
    Executing,
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
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WorkerResult {
    pub task_id: String,
    pub agent: String,
    pub exit_code: i32,
    pub output_summary: String, // last N lines of output
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
             - You may assign tasks to yourself",
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
}
