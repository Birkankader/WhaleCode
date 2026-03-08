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

pub struct Orchestrator;

impl Orchestrator {
    /// Create an orchestration plan that decomposes a prompt into sub-tasks.
    ///
    /// Heuristic: one sub-task per agent (repeated by sub_agent_count).
    /// The master agent gets a "coordinate and review" task.
    pub fn create_plan(prompt: &str, config: &OrchestratorConfig) -> OrchestrationPlan {
        let task_id = Uuid::new_v4().to_string();
        let mut sub_tasks: Vec<SubTask> = Vec::new();

        for agent in &config.agents {
            if agent.is_master {
                // Master agent gets a coordination task
                let master_prompt = Self::build_master_prompt(prompt, &config.agents);
                sub_tasks.push(SubTask {
                    id: Uuid::new_v4().to_string(),
                    prompt: master_prompt,
                    assigned_agent: agent.tool_name.clone(),
                    status: "pending".to_string(),
                    parent_task_id: task_id.clone(),
                });
            } else {
                // Worker agents get one sub-task per sub_agent_count
                for i in 0..agent.sub_agent_count.max(1) {
                    let sub_prompt = if agent.sub_agent_count > 1 {
                        format!(
                            "[Sub-agent {}/{} for {}] {}",
                            i + 1,
                            agent.sub_agent_count,
                            agent.tool_name,
                            prompt
                        )
                    } else {
                        prompt.to_string()
                    };

                    sub_tasks.push(SubTask {
                        id: Uuid::new_v4().to_string(),
                        prompt: sub_prompt,
                        assigned_agent: agent.tool_name.clone(),
                        status: "pending".to_string(),
                        parent_task_id: task_id.clone(),
                    });
                }
            }
        }

        OrchestrationPlan {
            task_id,
            original_prompt: prompt.to_string(),
            sub_tasks,
            master_agent: config.master_agent.clone(),
        }
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
    fn create_plan_generates_subtasks() {
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
        assert_eq!(plan.sub_tasks.len(), 2);
        assert_eq!(plan.master_agent, "claude");
        assert_eq!(plan.original_prompt, "refactor auth module");
    }

    #[test]
    fn create_plan_respects_sub_agent_count() {
        let config = OrchestratorConfig {
            agents: vec![
                AgentConfig {
                    tool_name: "claude".to_string(),
                    sub_agent_count: 1,
                    is_master: true,
                },
                AgentConfig {
                    tool_name: "gemini".to_string(),
                    sub_agent_count: 3,
                    is_master: false,
                },
            ],
            master_agent: "claude".to_string(),
        };

        let plan = Orchestrator::create_plan("do work", &config);
        // 1 master + 3 gemini sub-agents
        assert_eq!(plan.sub_tasks.len(), 4);
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
    fn subtask_ids_are_unique() {
        let config = OrchestratorConfig {
            agents: vec![
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
            ],
            master_agent: "claude".to_string(),
        };

        let plan = Orchestrator::create_plan("test", &config);
        let ids: Vec<&str> = plan.sub_tasks.iter().map(|s| s.id.as_str()).collect();
        let unique: std::collections::HashSet<&str> = ids.iter().copied().collect();
        assert_eq!(ids.len(), unique.len(), "all sub-task IDs should be unique");
    }
}
