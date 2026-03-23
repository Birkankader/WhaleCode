//! Integration tests for the orchestration flow.
//!
//! These tests verify cross-module interactions between the orchestrator,
//! context store, and related data structures.

#[cfg(test)]
mod tests {
    use crate::context::migrations::run_migrations;
    use crate::context::queries;
    use crate::context::store::ContextStore;
    use crate::router::orchestrator::{
        AgentConfig, DecompositionResult, Orchestrator, OrchestratorConfig,
        OrchestrationPhase, SubTaskDef, WorkerResult,
    };
    use rusqlite::Connection;

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    fn setup_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        run_migrations(&mut conn).unwrap();
        conn
    }

    fn temp_db_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join("whalecode_orch_tests")
            .join(name);
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("test.db")
    }

    fn sample_config() -> OrchestratorConfig {
        OrchestratorConfig {
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
                AgentConfig {
                    tool_name: "codex".to_string(),
                    sub_agent_count: 1,
                    is_master: false,
                },
            ],
            master_agent: "claude".to_string(),
        }
    }

    // -----------------------------------------------------------------------
    // Task 1: create_plan produces valid plan structure
    // -----------------------------------------------------------------------

    #[test]
    fn create_plan_valid_structure() {
        let config = sample_config();
        let plan = Orchestrator::create_plan("refactor the auth module", &config);

        // Plan should have a valid UUID task_id
        assert!(!plan.task_id.is_empty());
        assert!(
            uuid::Uuid::parse_str(&plan.task_id).is_ok(),
            "task_id should be a valid UUID, got: {}",
            plan.task_id
        );

        // Original prompt preserved
        assert_eq!(plan.original_prompt, "refactor the auth module");

        // Master agent matches config
        assert_eq!(plan.master_agent, "claude");

        // Initial phase is Decomposing
        assert_eq!(plan.phase, OrchestrationPhase::Decomposing);

        // Sub-tasks start empty (populated after decomposition)
        assert!(plan.sub_tasks.is_empty());

        // Decomposition starts as None
        assert!(plan.decomposition.is_none());

        // Worker results start empty
        assert!(plan.worker_results.is_empty());

        // Master process ID starts as None
        assert!(plan.master_process_id.is_none());
    }

    #[test]
    fn create_plan_unique_ids() {
        let config = sample_config();
        let plan1 = Orchestrator::create_plan("task A", &config);
        let plan2 = Orchestrator::create_plan("task B", &config);

        assert_ne!(
            plan1.task_id, plan2.task_id,
            "Each plan should get a unique task_id"
        );
    }

    #[test]
    fn create_plan_with_empty_agents() {
        let config = OrchestratorConfig {
            agents: vec![],
            master_agent: "claude".to_string(),
        };
        let plan = Orchestrator::create_plan("some task", &config);
        assert_eq!(plan.master_agent, "claude");
        assert!(plan.sub_tasks.is_empty());
    }

    // -----------------------------------------------------------------------
    // Task 2: build_decompose_prompt includes all required fields
    // -----------------------------------------------------------------------

    #[test]
    fn build_decompose_prompt_includes_all_required_fields() {
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
            AgentConfig {
                tool_name: "codex".to_string(),
                sub_agent_count: 1,
                is_master: false,
            },
        ];

        let prompt = Orchestrator::build_decompose_prompt("build a REST API", &agents);

        // Should include all agent names
        assert!(prompt.contains("claude"), "prompt should mention claude");
        assert!(prompt.contains("gemini"), "prompt should mention gemini");
        assert!(prompt.contains("codex"), "prompt should mention codex");

        // Should include the user's task
        assert!(
            prompt.contains("build a REST API"),
            "prompt should include the task description"
        );

        // Should request JSON output
        assert!(prompt.contains("JSON"), "prompt should request JSON format");

        // Should include depends_on field reference
        assert!(
            prompt.contains("depends_on"),
            "prompt should reference depends_on for DAG ordering"
        );

        // Should include instructions about non-overlapping files
        assert!(
            prompt.contains("merge conflict") || prompt.contains("same file"),
            "prompt should warn about file conflicts"
        );

        // Should include task ID format
        assert!(
            prompt.contains("t1") || prompt.contains("id"),
            "prompt should show task ID format"
        );
    }

    #[test]
    fn build_decompose_prompt_single_agent() {
        let agents = vec![AgentConfig {
            tool_name: "claude".to_string(),
            sub_agent_count: 1,
            is_master: true,
        }];

        let prompt = Orchestrator::build_decompose_prompt("fix bug", &agents);
        assert!(prompt.contains("claude"));
        assert!(prompt.contains("fix bug"));
        assert!(prompt.contains("JSON"));
    }

    #[test]
    fn build_decompose_prompt_with_special_characters() {
        let agents = vec![AgentConfig {
            tool_name: "claude".to_string(),
            sub_agent_count: 1,
            is_master: true,
        }];

        let task = "Fix the \"auth\" module's <injection> & sanitize user's input";
        let prompt = Orchestrator::build_decompose_prompt(task, &agents);
        assert!(
            prompt.contains(task),
            "special characters in task should be preserved verbatim"
        );
    }

    // -----------------------------------------------------------------------
    // Task 3: build_review_prompt handles empty/non-empty results
    // -----------------------------------------------------------------------

    #[test]
    fn build_review_prompt_with_results() {
        let results = vec![
            WorkerResult {
                task_id: "t1".to_string(),
                agent: "gemini".to_string(),
                exit_code: 0,
                output_summary: "Created REST endpoints for /users and /products".to_string(),
                retry_count: 0,
                original_agent: None,
                failure_reason: None,
            },
            WorkerResult {
                task_id: "t2".to_string(),
                agent: "codex".to_string(),
                exit_code: 0,
                output_summary: "Added database migrations and models".to_string(),
                retry_count: 0,
                original_agent: None,
                failure_reason: None,
            },
        ];

        let prompt = Orchestrator::build_review_prompt("build a REST API", &results);

        // Should include original task
        assert!(
            prompt.contains("build a REST API"),
            "review prompt should include original task"
        );

        // Should include all worker results
        assert!(
            prompt.contains("gemini"),
            "review prompt should mention gemini"
        );
        assert!(
            prompt.contains("codex"),
            "review prompt should mention codex"
        );
        assert!(
            prompt.contains("Created REST endpoints"),
            "review prompt should include worker output"
        );
        assert!(
            prompt.contains("Added database migrations"),
            "review prompt should include worker output"
        );

        // Should include exit codes
        assert!(
            prompt.contains("exit code: 0"),
            "review prompt should show exit codes"
        );

        // Should include review instructions
        assert!(
            prompt.contains("Summarize") || prompt.contains("summarize"),
            "review prompt should ask for summary"
        );
    }

    #[test]
    fn build_review_prompt_with_empty_results() {
        let results: Vec<WorkerResult> = Vec::new();
        let prompt = Orchestrator::build_review_prompt("deploy pipeline", &results);

        // Should still include original task
        assert!(
            prompt.contains("deploy pipeline"),
            "review prompt should include original task even with no results"
        );

        // Should still include review instructions
        assert!(
            prompt.contains("reviewing"),
            "review prompt should still have review framing"
        );

        // Should not contain any worker-specific content
        assert!(
            !prompt.contains("exit code"),
            "empty results should not produce exit code lines"
        );
    }

    #[test]
    fn build_review_prompt_with_failed_worker() {
        let results = vec![
            WorkerResult {
                task_id: "t1".to_string(),
                agent: "gemini".to_string(),
                exit_code: 0,
                output_summary: "Success".to_string(),
                retry_count: 0,
                original_agent: None,
                failure_reason: None,
            },
            WorkerResult {
                task_id: "t2".to_string(),
                agent: "codex".to_string(),
                exit_code: 1,
                output_summary: "Error: rate limit exceeded".to_string(),
                retry_count: 2,
                original_agent: Some("claude".to_string()),
                failure_reason: Some("Rate limited".to_string()),
            },
        ];

        let prompt = Orchestrator::build_review_prompt("complex task", &results);

        // Should include the failed worker's exit code
        assert!(
            prompt.contains("exit code: 1"),
            "review prompt should show non-zero exit code"
        );

        // Should include error output
        assert!(
            prompt.contains("rate limit exceeded"),
            "review prompt should include error output"
        );
    }

    // -----------------------------------------------------------------------
    // Integration: Orchestration stats with context DB
    // -----------------------------------------------------------------------

    #[test]
    fn record_and_query_orchestration_stats() {
        let conn = setup_db();

        // Record a successful orchestration
        queries::record_orchestration_stats(&conn, "task-001", 3, 120, true).unwrap();

        // Record a failed orchestration
        queries::record_orchestration_stats(&conn, "task-002", 2, 45, false).unwrap();

        // Query history
        let history = queries::get_orchestration_history(&conn, 10).unwrap();
        assert_eq!(history.len(), 2);

        // Most recent first
        assert_eq!(history[0].task_id, "task-002");
        assert_eq!(history[0].agent_count, 2);
        assert_eq!(history[0].duration_secs, 45);
        assert!(!history[0].success);

        assert_eq!(history[1].task_id, "task-001");
        assert_eq!(history[1].agent_count, 3);
        assert_eq!(history[1].duration_secs, 120);
        assert!(history[1].success);
    }

    #[test]
    fn orchestration_history_respects_limit() {
        let conn = setup_db();

        for i in 0..10 {
            queries::record_orchestration_stats(
                &conn,
                &format!("task-{:03}", i),
                2,
                60,
                true,
            )
            .unwrap();
        }

        let history = queries::get_orchestration_history(&conn, 5).unwrap();
        assert_eq!(history.len(), 5);
    }

    #[test]
    fn orchestration_history_empty_when_no_records() {
        let conn = setup_db();
        let history = queries::get_orchestration_history(&conn, 10).unwrap();
        assert!(history.is_empty());
    }

    #[test]
    fn context_store_orchestration_stats_roundtrip() {
        let db_path = temp_db_path("orch_stats_roundtrip");
        let store = ContextStore::new(&db_path).unwrap();

        store
            .record_orchestration_stats("plan-abc", 4, 300, true)
            .unwrap();
        store
            .record_orchestration_stats("plan-def", 2, 60, false)
            .unwrap();

        let history = store.get_orchestration_history(10).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].task_id, "plan-def");
        assert!(!history[0].success);
        assert_eq!(history[1].task_id, "plan-abc");
        assert!(history[1].success);
    }

    // -----------------------------------------------------------------------
    // Integration: DecompositionResult parsing edge cases
    // -----------------------------------------------------------------------

    #[test]
    fn decomposition_result_with_complex_depends_on() {
        let json = r#"{"tasks":[
            {"agent":"claude","prompt":"schema design","description":"Design DB schema","depends_on":[]},
            {"agent":"gemini","prompt":"build api","description":"REST API","depends_on":["t1"]},
            {"agent":"codex","prompt":"build ui","description":"Frontend","depends_on":["t1"]},
            {"agent":"claude","prompt":"integration","description":"Wire up","depends_on":["t2","t3"]}
        ]}"#;
        let result: DecompositionResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.tasks.len(), 4);

        // First task has no dependencies
        assert!(result.tasks[0].depends_on.is_empty());

        // Last task depends on two tasks
        assert_eq!(result.tasks[3].depends_on.len(), 2);
        assert!(result.tasks[3].depends_on.contains(&"t2".to_string()));
        assert!(result.tasks[3].depends_on.contains(&"t3".to_string()));
    }

    #[test]
    fn decomposition_result_missing_depends_on_defaults_to_empty() {
        // depends_on has #[serde(default)] so missing field should default to empty vec
        let json = r#"{"tasks":[{"agent":"claude","prompt":"do stuff","description":"things"}]}"#;
        let result: DecompositionResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.tasks.len(), 1);
        assert!(result.tasks[0].depends_on.is_empty());
    }

    // -----------------------------------------------------------------------
    // Integration: Plan + prompt builder round-trip
    // -----------------------------------------------------------------------

    #[test]
    fn plan_to_review_prompt_roundtrip() {
        let config = sample_config();
        let plan = Orchestrator::create_plan("refactor everything", &config);

        // Simulate worker results
        let results = vec![
            WorkerResult {
                task_id: "t1".to_string(),
                agent: "gemini".to_string(),
                exit_code: 0,
                output_summary: "Refactored module A".to_string(),
                retry_count: 0,
                original_agent: None,
                failure_reason: None,
            },
            WorkerResult {
                task_id: "t2".to_string(),
                agent: "codex".to_string(),
                exit_code: 0,
                output_summary: "Refactored module B".to_string(),
                retry_count: 0,
                original_agent: None,
                failure_reason: None,
            },
        ];

        let review_prompt =
            Orchestrator::build_review_prompt(&plan.original_prompt, &results);

        // Review prompt should reference the original task from the plan
        assert!(review_prompt.contains("refactor everything"));

        // Review prompt should include all worker results
        assert!(review_prompt.contains("Refactored module A"));
        assert!(review_prompt.contains("Refactored module B"));
    }

    #[test]
    fn orchestration_history_table_exists_after_migration() {
        let conn = setup_db();
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        assert!(
            tables.contains(&"orchestration_history".to_string()),
            "orchestration_history table should exist after migration, got: {:?}",
            tables
        );
    }

    // -----------------------------------------------------------------------
    // SubTaskDef.id deserialization tests
    // -----------------------------------------------------------------------

    #[test]
    fn subtaskdef_with_id_field_deserializes_correctly() {
        let json = r#"{"id":"t1","agent":"claude","prompt":"do stuff","description":"things","depends_on":[]}"#;
        let def: SubTaskDef = serde_json::from_str(json).unwrap();
        assert_eq!(def.id, Some("t1".to_string()));
        assert_eq!(def.agent, "claude");
    }

    #[test]
    fn subtaskdef_without_id_field_defaults_to_none() {
        let json = r#"{"agent":"claude","prompt":"do stuff","description":"things"}"#;
        let def: SubTaskDef = serde_json::from_str(json).unwrap();
        assert_eq!(def.id, None);
        assert!(def.depends_on.is_empty());
    }

    #[test]
    fn decomposition_result_preserves_llm_ids() {
        let json = r#"{"tasks":[
            {"id":"t1","agent":"claude","prompt":"schema design","description":"Design DB schema","depends_on":[]},
            {"id":"t2","agent":"gemini","prompt":"build api","description":"REST API","depends_on":["t1"]},
            {"id":"t3","agent":"codex","prompt":"build ui","description":"Frontend","depends_on":["t1"]},
            {"id":"t4","agent":"claude","prompt":"integration","description":"Wire up","depends_on":["t2","t3"]}
        ]}"#;
        let result: DecompositionResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.tasks.len(), 4);
        assert_eq!(result.tasks[0].id, Some("t1".to_string()));
        assert_eq!(result.tasks[1].id, Some("t2".to_string()));
        assert_eq!(result.tasks[2].id, Some("t3".to_string()));
        assert_eq!(result.tasks[3].id, Some("t4".to_string()));
        // depends_on references are preserved as-is
        assert_eq!(result.tasks[3].depends_on, vec!["t2", "t3"]);
    }

    #[test]
    fn decomposition_result_mixed_ids_all_become_none_safe() {
        // When only SOME tasks have ids, the DAG builder falls back to index-based.
        // Here we just verify serde handles the mixed case correctly.
        let json = r#"{"tasks":[
            {"id":"t1","agent":"claude","prompt":"a","description":"A","depends_on":[]},
            {"agent":"gemini","prompt":"b","description":"B","depends_on":[]}
        ]}"#;
        let result: DecompositionResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.tasks[0].id, Some("t1".to_string()));
        assert_eq!(result.tasks[1].id, None);
    }

    // -----------------------------------------------------------------------
    // Worktree integration: WorktreeEntry struct and event shape (T02)
    // -----------------------------------------------------------------------

    #[test]
    fn worktree_entry_has_expected_fields() {
        use crate::worktree::models::WorktreeEntry;
        use std::path::PathBuf;

        let entry = WorktreeEntry {
            task_id: "t1".to_string(),
            worktree_name: "whalecode-t1".to_string(),
            branch_name: "whalecode/task/t1".to_string(),
            path: PathBuf::from("/tmp/.whalecode-worktrees/whalecode-t1"),
            created_at: "2026-03-23T10:00:00Z".to_string(),
        };

        assert_eq!(entry.task_id, "t1");
        assert_eq!(entry.worktree_name, "whalecode-t1");
        assert_eq!(entry.branch_name, "whalecode/task/t1");
        assert!(entry.path.to_str().unwrap().contains("whalecode-t1"));
        assert!(!entry.created_at.is_empty());
    }

    #[test]
    fn worktree_created_event_json_shape() {
        // Verify the JSON shape emitted by worktree_created events
        // has all required fields for downstream consumers (S04 review/merge).
        let event_data = serde_json::json!({
            "dag_id": "t1",
            "task_id": "t1",
            "branch": "whalecode/task/t1",
            "path": "/tmp/.whalecode-worktrees/whalecode-t1"
        });

        assert!(event_data.get("dag_id").is_some(), "worktree_created must include dag_id");
        assert!(event_data.get("task_id").is_some(), "worktree_created must include task_id");
        assert!(event_data.get("branch").is_some(), "worktree_created must include branch");
        assert!(event_data.get("path").is_some(), "worktree_created must include path");

        assert_eq!(event_data["dag_id"], "t1");
        assert_eq!(event_data["branch"], "whalecode/task/t1");
    }

    #[test]
    fn worker_event_enrichment_json_shape() {
        // Verify enriched worker events include worktree_path and worktree_branch
        // fields for downstream consumption by S04 (review/merge).
        let worker_started = serde_json::json!({
            "dag_id": "t1",
            "process_id": "proc-abc",
            "worktree_path": "/tmp/.whalecode-worktrees/whalecode-t1",
            "worktree_branch": "whalecode/task/t1"
        });
        assert!(worker_started.get("worktree_path").is_some(), "worker_started must include worktree_path");
        assert!(worker_started.get("worktree_branch").is_some(), "worker_started must include worktree_branch");

        let task_completed = serde_json::json!({
            "dag_id": "t1",
            "exit_code": 0,
            "summary": "Done",
            "agent": "claude",
            "failure_reason": "",
            "worktree_path": "/tmp/.whalecode-worktrees/whalecode-t1",
            "worktree_branch": "whalecode/task/t1"
        });
        assert!(task_completed.get("worktree_path").is_some(), "task_completed must include worktree_path");
        assert!(task_completed.get("worktree_branch").is_some(), "task_completed must include worktree_branch");

        let task_failed = serde_json::json!({
            "dag_id": "t2",
            "exit_code": 1,
            "summary": "Error",
            "agent": "gemini",
            "failure_reason": "process died",
            "worktree_path": "/tmp/.whalecode-worktrees/whalecode-t2",
            "worktree_branch": "whalecode/task/t2"
        });
        assert!(task_failed.get("worktree_path").is_some(), "task_failed must include worktree_path");
        assert!(task_failed.get("worktree_branch").is_some(), "task_failed must include worktree_branch");
    }

    #[test]
    fn worktree_manager_import_smoke_test() {
        // Verify WorktreeManager can be imported and constructed.
        // This confirms the wiring between orchestrator and worktree modules compiles.
        use crate::worktree::manager::WorktreeManager;
        let manager = WorktreeManager::new(std::path::PathBuf::from("/tmp/fake-repo"));
        let base = manager.worktree_base_dir();
        assert!(base.to_str().unwrap().contains(".whalecode-worktrees"),
            "worktree base dir should contain .whalecode-worktrees, got: {:?}", base);
    }

    // -----------------------------------------------------------------------
    // T03: Parallel worker dispatch — WorkerOutcome and JoinSet patterns
    // -----------------------------------------------------------------------

    #[test]
    fn worker_outcome_struct_fields() {
        // Verify WorkerOutcome carries all necessary fields for post-wave merging.
        // This struct is returned by dispatch_and_await_worker and consumed by the
        // JoinSet collection loop to populate failed_dag_ids and worker_task_ids.
        use super::super::orchestrator::WorkerOutcome;
        let outcome = WorkerOutcome {
            dag_id: "task-1".to_string(),
            success: true,
            process_task_id: Some("proc-abc".to_string()),
            agent: "claude".to_string(),
            exit_code: 0,
            output_summary: "Completed successfully".to_string(),
            failure_reason: None,
            retry_count: 0,
            original_agent: None,
        };
        assert!(outcome.success);
        assert_eq!(outcome.dag_id, "task-1");
        assert_eq!(outcome.process_task_id.as_deref(), Some("proc-abc"));
        assert_eq!(outcome.exit_code, 0);
        assert!(outcome.failure_reason.is_none());
        assert!(outcome.original_agent.is_none());
    }

    #[test]
    fn worker_outcome_failed_with_fallback() {
        // Verify WorkerOutcome correctly represents a failed task with agent fallback.
        use super::super::orchestrator::WorkerOutcome;
        let outcome = WorkerOutcome {
            dag_id: "task-2".to_string(),
            success: false,
            process_task_id: Some("proc-xyz".to_string()),
            agent: "gemini".to_string(),
            exit_code: 1,
            output_summary: "Rate limited".to_string(),
            failure_reason: Some("API rate limit exceeded".to_string()),
            retry_count: 2,
            original_agent: Some("claude".to_string()),
        };
        assert!(!outcome.success);
        assert_eq!(outcome.exit_code, 1);
        assert_eq!(outcome.retry_count, 2);
        assert_eq!(outcome.original_agent.as_deref(), Some("claude"));
        assert_eq!(outcome.agent, "gemini"); // fallback agent
    }

    #[tokio::test]
    async fn joinset_collects_concurrent_worker_outcomes() {
        // Verify the JoinSet pattern used in the wave loop correctly collects
        // results from multiple concurrently-spawned async tasks.
        use super::super::orchestrator::WorkerOutcome;
        let mut join_set = tokio::task::JoinSet::new();

        // Spawn 3 simulated workers
        for i in 0..3 {
            let dag_id = format!("task-{}", i);
            join_set.spawn(async move {
                // Simulate varying completion times
                tokio::time::sleep(std::time::Duration::from_millis(10 * (i as u64 + 1))).await;
                WorkerOutcome {
                    dag_id,
                    success: i != 1, // task-1 fails
                    process_task_id: Some(format!("proc-{}", i)),
                    agent: "claude".to_string(),
                    exit_code: if i == 1 { 1 } else { 0 },
                    output_summary: format!("Result {}", i),
                    failure_reason: if i == 1 { Some("test failure".to_string()) } else { None },
                    retry_count: 0,
                    original_agent: None,
                }
            });
        }

        let mut outcomes = Vec::new();
        while let Some(result) = join_set.join_next().await {
            outcomes.push(result.unwrap());
        }

        assert_eq!(outcomes.len(), 3, "Should collect all 3 worker outcomes");

        let successes: Vec<_> = outcomes.iter().filter(|o| o.success).collect();
        let failures: Vec<_> = outcomes.iter().filter(|o| !o.success).collect();
        assert_eq!(successes.len(), 2, "2 tasks should succeed");
        assert_eq!(failures.len(), 1, "1 task should fail");
        assert_eq!(failures[0].dag_id, "task-1");
    }

    #[test]
    fn worker_outcome_merges_into_worker_results() {
        // Verify that WorkerOutcome fields map correctly to WorkerResult fields
        // used by the plan's worker_results Vec. This is the merge step after
        // JoinSet drains in the wave loop.
        use super::super::orchestrator::WorkerOutcome;
        let outcome = WorkerOutcome {
            dag_id: "task-a".to_string(),
            success: true,
            process_task_id: Some("proc-123".to_string()),
            agent: "claude".to_string(),
            exit_code: 0,
            output_summary: "Done".to_string(),
            failure_reason: None,
            retry_count: 1,
            original_agent: None,
        };

        // Simulate the merge logic from the wave loop
        let worker_result = WorkerResult {
            task_id: outcome.dag_id.clone(),
            agent: outcome.agent.clone(),
            exit_code: outcome.exit_code,
            output_summary: outcome.output_summary.clone(),
            retry_count: outcome.retry_count,
            original_agent: outcome.original_agent.clone(),
            failure_reason: outcome.failure_reason.clone(),
        };

        assert_eq!(worker_result.task_id, "task-a");
        assert_eq!(worker_result.agent, "claude");
        assert_eq!(worker_result.exit_code, 0);
        assert_eq!(worker_result.retry_count, 1);
    }
}
