# Orchestration Depth Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add task dependency graphs (DAG), retry/fallback resilience, and smart agent routing to WhaleCode's orchestration engine.

**Architecture:** Three layered features on the existing orchestration pipeline. DAG changes how tasks are scheduled (wave-based dispatch). Retry/Fallback wraps each worker dispatch with resilience. Smart Routing enhances agent selection using patterns, load, and history.

**Tech Stack:** Rust (Tauri backend), React 19 + TypeScript + Zustand (frontend), existing ToolAdapter trait, existing TaskRouter, existing context store (SQLite).

---

## Part A: Task Dependency Graph (DAG)

### Task 1: Add `depends_on` to Rust models

**Files:**
- Modify: `src-tauri/src/router/orchestrator.rs:65-70` (SubTaskDef struct)
- Modify: `src-tauri/src/router/orchestrator.rs:19-25` (SubTask struct)
- Test: `src-tauri/src/router/orchestrator.rs` (existing test module)

**Step 1: Write the failing test**

Add to the existing test module in `orchestrator.rs`:

```rust
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
```

**Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test test_decomposition_result_with_depends_on -- --nocapture`
Expected: FAIL — `depends_on` field doesn't exist on SubTaskDef

**Step 3: Add `depends_on` field to both structs**

In `SubTaskDef`:
```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SubTaskDef {
    pub agent: String,
    pub prompt: String,
    pub description: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
}
```

In `SubTask`:
```rust
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
```

**Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test test_decomposition_result_with_depends_on -- --nocapture`
Expected: PASS

**Step 5: Verify existing tests still pass**

Run: `cd src-tauri && cargo test -- --skip credentials`
Expected: All 288+ tests PASS

**Step 6: Commit**

```bash
git add src-tauri/src/router/orchestrator.rs
git commit -m "feat: add depends_on field to SubTaskDef and SubTask"
```

---

### Task 2: Create DAG module with topological sort

**Files:**
- Create: `src-tauri/src/router/dag.rs`
- Modify: `src-tauri/src/router/mod.rs` (add `pub mod dag;`)

**Step 1: Write the failing tests**

Create `src-tauri/src/router/dag.rs` with tests first:

```rust
use std::collections::{HashMap, HashSet, VecDeque};

/// Represents a task node in the dependency graph.
#[derive(Debug, Clone)]
pub struct DagNode {
    pub id: String,
    pub depends_on: Vec<String>,
}

#[derive(Debug)]
pub enum DagError {
    CycleDetected(Vec<String>),
    MissingDependency { task_id: String, missing_dep: String },
}

impl std::fmt::Display for DagError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DagError::CycleDetected(ids) => write!(f, "Cycle detected: {}", ids.join(" -> ")),
            DagError::MissingDependency { task_id, missing_dep } => {
                write!(f, "Task '{}' depends on missing task '{}'", task_id, missing_dep)
            }
        }
    }
}

/// Sort tasks into execution waves using Kahn's algorithm.
/// Returns Vec<Vec<String>> where each inner vec is a wave of parallelizable tasks.
pub fn topological_waves(nodes: &[DagNode]) -> Result<Vec<Vec<String>>, DagError> {
    todo!()
}

/// Given completed task IDs, return which tasks are now ready to run.
pub fn resolve_ready_tasks(
    nodes: &[DagNode],
    completed: &HashSet<String>,
    running: &HashSet<String>,
) -> Vec<String> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_linear_dependency() {
        let nodes = vec![
            DagNode { id: "t1".into(), depends_on: vec![] },
            DagNode { id: "t2".into(), depends_on: vec!["t1".into()] },
            DagNode { id: "t3".into(), depends_on: vec!["t2".into()] },
        ];
        let waves = topological_waves(&nodes).unwrap();
        assert_eq!(waves.len(), 3);
        assert_eq!(waves[0], vec!["t1"]);
        assert_eq!(waves[1], vec!["t2"]);
        assert_eq!(waves[2], vec!["t3"]);
    }

    #[test]
    fn test_parallel_tasks() {
        let nodes = vec![
            DagNode { id: "t1".into(), depends_on: vec![] },
            DagNode { id: "t2".into(), depends_on: vec!["t1".into()] },
            DagNode { id: "t3".into(), depends_on: vec!["t1".into()] },
            DagNode { id: "t4".into(), depends_on: vec!["t2".into(), "t3".into()] },
        ];
        let waves = topological_waves(&nodes).unwrap();
        assert_eq!(waves.len(), 3);
        assert_eq!(waves[0], vec!["t1"]);
        assert!(waves[1].contains(&"t2".to_string()));
        assert!(waves[1].contains(&"t3".to_string()));
        assert_eq!(waves[2], vec!["t4"]);
    }

    #[test]
    fn test_all_independent() {
        let nodes = vec![
            DagNode { id: "t1".into(), depends_on: vec![] },
            DagNode { id: "t2".into(), depends_on: vec![] },
            DagNode { id: "t3".into(), depends_on: vec![] },
        ];
        let waves = topological_waves(&nodes).unwrap();
        assert_eq!(waves.len(), 1);
        assert_eq!(waves[0].len(), 3);
    }

    #[test]
    fn test_cycle_detected() {
        let nodes = vec![
            DagNode { id: "t1".into(), depends_on: vec!["t2".into()] },
            DagNode { id: "t2".into(), depends_on: vec!["t1".into()] },
        ];
        assert!(topological_waves(&nodes).is_err());
    }

    #[test]
    fn test_missing_dependency() {
        let nodes = vec![
            DagNode { id: "t1".into(), depends_on: vec!["nonexistent".into()] },
        ];
        assert!(topological_waves(&nodes).is_err());
    }

    #[test]
    fn test_resolve_ready_tasks() {
        let nodes = vec![
            DagNode { id: "t1".into(), depends_on: vec![] },
            DagNode { id: "t2".into(), depends_on: vec!["t1".into()] },
            DagNode { id: "t3".into(), depends_on: vec!["t1".into()] },
            DagNode { id: "t4".into(), depends_on: vec!["t2".into(), "t3".into()] },
        ];
        let completed: HashSet<String> = ["t1".into()].into();
        let running: HashSet<String> = HashSet::new();
        let ready = resolve_ready_tasks(&nodes, &completed, &running);
        assert!(ready.contains(&"t2".to_string()));
        assert!(ready.contains(&"t3".to_string()));
        assert!(!ready.contains(&"t4".to_string()));
    }

    #[test]
    fn test_resolve_excludes_running() {
        let nodes = vec![
            DagNode { id: "t1".into(), depends_on: vec![] },
            DagNode { id: "t2".into(), depends_on: vec!["t1".into()] },
        ];
        let completed: HashSet<String> = ["t1".into()].into();
        let running: HashSet<String> = ["t2".into()].into();
        let ready = resolve_ready_tasks(&nodes, &completed, &running);
        assert!(ready.is_empty());
    }

    #[test]
    fn test_empty_graph() {
        let waves = topological_waves(&[]).unwrap();
        assert!(waves.is_empty());
    }
}
```

**Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test dag::tests -- --nocapture`
Expected: FAIL — `todo!()` panics

**Step 3: Implement topological_waves using Kahn's algorithm**

Replace the `todo!()` in `topological_waves`:

```rust
pub fn topological_waves(nodes: &[DagNode]) -> Result<Vec<Vec<String>>, DagError> {
    if nodes.is_empty() {
        return Ok(vec![]);
    }

    let ids: HashSet<String> = nodes.iter().map(|n| n.id.clone()).collect();

    // Validate all dependencies exist
    for node in nodes {
        for dep in &node.depends_on {
            if !ids.contains(dep) {
                return Err(DagError::MissingDependency {
                    task_id: node.id.clone(),
                    missing_dep: dep.clone(),
                });
            }
        }
    }

    // Build in-degree map and adjacency list
    let mut in_degree: HashMap<String, usize> = HashMap::new();
    let mut dependents: HashMap<String, Vec<String>> = HashMap::new();

    for node in nodes {
        in_degree.entry(node.id.clone()).or_insert(0);
        for dep in &node.depends_on {
            *in_degree.entry(node.id.clone()).or_insert(0) += 1;
            dependents.entry(dep.clone()).or_default().push(node.id.clone());
        }
    }

    // Kahn's: collect nodes with in-degree 0 as first wave
    let mut waves: Vec<Vec<String>> = Vec::new();
    let mut queue: VecDeque<String> = in_degree
        .iter()
        .filter(|(_, &deg)| deg == 0)
        .map(|(id, _)| id.clone())
        .collect();

    let mut processed = 0usize;

    while !queue.is_empty() {
        let mut wave: Vec<String> = queue.drain(..).collect();
        wave.sort(); // deterministic order
        processed += wave.len();

        for id in &wave {
            if let Some(deps) = dependents.get(id) {
                for dep_id in deps {
                    if let Some(deg) = in_degree.get_mut(dep_id) {
                        *deg -= 1;
                        if *deg == 0 {
                            queue.push_back(dep_id.clone());
                        }
                    }
                }
            }
        }

        waves.push(wave);
    }

    if processed != nodes.len() {
        let remaining: Vec<String> = in_degree
            .iter()
            .filter(|(_, &deg)| deg > 0)
            .map(|(id, _)| id.clone())
            .collect();
        return Err(DagError::CycleDetected(remaining));
    }

    Ok(waves)
}
```

**Step 4: Implement resolve_ready_tasks**

```rust
pub fn resolve_ready_tasks(
    nodes: &[DagNode],
    completed: &HashSet<String>,
    running: &HashSet<String>,
) -> Vec<String> {
    nodes
        .iter()
        .filter(|n| {
            !completed.contains(&n.id)
                && !running.contains(&n.id)
                && n.depends_on.iter().all(|dep| completed.contains(dep))
        })
        .map(|n| n.id.clone())
        .collect()
}
```

**Step 5: Register module**

In `src-tauri/src/router/mod.rs`, add:
```rust
pub mod dag;
```

**Step 6: Run all tests**

Run: `cd src-tauri && cargo test dag -- --nocapture`
Expected: All 8 DAG tests PASS

Run: `cd src-tauri && cargo test -- --skip credentials`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add src-tauri/src/router/dag.rs src-tauri/src/router/mod.rs
git commit -m "feat: add DAG module with topological sort and wave resolution"
```

---

### Task 3: Update decomposition prompt to request dependency info

**Files:**
- Modify: `src-tauri/src/router/orchestrator.rs:107-132` (build_decompose_prompt)

**Step 1: Update the prompt**

Change `build_decompose_prompt` return format to include `depends_on`:

```rust
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
         {{\"tasks\": [{{\"id\": \"t1\", \"agent\": \"<agent_name>\", \"prompt\": \"<detailed prompt>\", \
         \"description\": \"<short description>\", \"depends_on\": [\"t0\"]}}]}}\n\n\
         Rules:\n\
         - Give each task a short id like t1, t2, t3\n\
         - Use depends_on to specify which task IDs must complete before this task can start\n\
         - Tasks with no dependencies should have an empty depends_on array\n\
         - Tasks that CAN run in parallel SHOULD have independent dependencies\n\
         - Assign each sub-task to the most appropriate agent\n\
         - Prompts should be self-contained and detailed\n\
         - CRITICAL: Each agent works in an isolated git worktree. To prevent merge conflicts, \
         ensure sub-tasks do NOT modify the same files. If two tasks must touch the same file, \
         merge them into a single task for one agent.",
        agent_list.join("\n"),
        prompt
    )
}
```

**Step 2: Update existing test**

Update `decompose_prompt_includes_agents_and_task` to also verify `depends_on` keyword:

```rust
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
    assert!(prompt.contains("depends_on"));
}
```

**Step 3: Run tests**

Run: `cd src-tauri && cargo test decompose_prompt -- --nocapture`
Expected: PASS

**Step 4: Commit**

```bash
git add src-tauri/src/router/orchestrator.rs
git commit -m "feat: update decompose prompt to include dependency info"
```

---

### Task 4: Integrate DAG into orchestrator dispatch (Phase 2)

**Files:**
- Modify: `src-tauri/src/commands/orchestrator.rs` (dispatch_orchestrated_task Phase 2 section)

**Step 1: Add DAG import at top of file**

```rust
use crate::router::dag::{DagNode, topological_waves};
```

**Step 2: Replace flat dispatch with wave-based dispatch**

In Phase 2, after building sub-tasks from decomposition, replace the flat `for sub_def in &decomposition.tasks` dispatch with:

1. Build `DagNode` list from `decomposition.tasks` using each task's `id` field (or generated UUID if no id)
2. Call `topological_waves()` to get execution order
3. For each wave, dispatch all tasks in the wave in parallel (existing join_all pattern)
4. Wait for wave to complete before starting next wave
5. If a task fails, mark dependent tasks as `blocked`

Key changes:
- Use `SubTaskDef.depends_on` to build `DagNode` list
- Map `SubTaskDef.id` (if present from master output) or use generated UUID
- Each wave dispatches via existing worker spawn pattern
- Between waves, check for failures and block dependents

This is the most complex task. The existing dispatch loop (lines ~470-600 in orchestrator.rs) needs to be restructured from a flat `join_all` to a wave loop. The core pattern:

```rust
// Build DAG
let dag_nodes: Vec<DagNode> = decomposition.tasks.iter().enumerate().map(|(i, def)| {
    DagNode {
        id: format!("t{}", i + 1),
        depends_on: def.depends_on.clone(),
    }
}).collect();

let waves = match topological_waves(&dag_nodes) {
    Ok(w) => w,
    Err(e) => {
        // Log error, fall back to single wave (all parallel)
        on_event.send(OutputEvent::Stdout(
            format!("[orchestrator] DAG error: {}, running all tasks in parallel", e)
        )).ok();
        vec![dag_nodes.iter().map(|n| n.id.clone()).collect()]
    }
};

// Execute wave by wave
for (wave_idx, wave_ids) in waves.iter().enumerate() {
    on_event.send(OutputEvent::Stdout(
        format!("[orchestrator] Wave {}/{}: {} tasks", wave_idx + 1, waves.len(), wave_ids.len())
    )).ok();

    // Dispatch tasks in this wave (parallel)
    // ... existing dispatch logic, filtered to only wave_ids ...

    // Wait for all tasks in wave to complete
    // ... existing join_all pattern ...
}
```

**Step 3: Run full test suite**

Run: `cd src-tauri && cargo test -- --skip credentials`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add src-tauri/src/commands/orchestrator.rs
git commit -m "feat: integrate DAG wave-based dispatch into orchestration Phase 2"
```

---

### Task 5: Update frontend models and Kanban UI

**Files:**
- Modify: `src/stores/taskStore.ts` (SubTaskEntry, TaskEntry)
- Modify: `src/hooks/useTaskDispatch.ts` (parse depends_on from events)
- Modify: `src/components/views/KanbanView.tsx` (dependency labels)

**Step 1: Add `dependsOn` to SubTaskEntry**

In `taskStore.ts`:
```typescript
export interface SubTaskEntry {
  id: string;
  prompt: string;
  assignedAgent: ToolName;
  status: TaskStatus;
  parentTaskId: string;
  dependsOn: string[];  // NEW
}
```

Add `'blocked'` to TaskStatus:
```typescript
export type TaskStatus = 'pending' | 'routing' | 'running' | 'completed' | 'failed' | 'waiting' | 'review' | 'blocked';
```

**Step 2: Update KanbanView to show blocked state**

Add a "Waiting for X" label on blocked task cards. Blocked tasks show in Queued column with a lock icon and muted color.

**Step 3: Add wave indicator**

In the orchestration log event parsing (`useTaskDispatch.ts`), detect `[orchestrator] Wave N/M` messages and display wave number in the sidebar.

**Step 4: Commit**

```bash
git add src/stores/taskStore.ts src/hooks/useTaskDispatch.ts src/components/views/KanbanView.tsx
git commit -m "feat: frontend DAG support with blocked state and wave indicators"
```

---

## Part B: Retry & Agent Fallback

### Task 6: Add retry/fallback fields to Rust models

**Files:**
- Modify: `src-tauri/src/router/orchestrator.rs` (WorkerResult, SubTask)

**Step 1: Write failing test**

```rust
#[test]
fn test_worker_result_with_retry_info() {
    let result = WorkerResult {
        task_id: "t1".to_string(),
        agent: "gemini".to_string(),
        exit_code: 0,
        output_summary: "Done".to_string(),
        retry_count: 1,
        original_agent: Some("claude".to_string()),
        failure_reason: Some("Rate limited".to_string()),
    };
    assert_eq!(result.retry_count, 1);
    assert_eq!(result.original_agent.unwrap(), "claude");
}
```

**Step 2: Add fields to WorkerResult**

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WorkerResult {
    pub task_id: String,
    pub agent: String,
    pub exit_code: i32,
    pub output_summary: String,
    #[serde(default)]
    pub retry_count: u32,
    #[serde(default)]
    pub original_agent: Option<String>,
    #[serde(default)]
    pub failure_reason: Option<String>,
}
```

**Step 3: Run tests, verify pass, commit**

```bash
git add src-tauri/src/router/orchestrator.rs
git commit -m "feat: add retry tracking fields to WorkerResult"
```

---

### Task 7: Implement retry wrapper in orchestrator

**Files:**
- Create: `src-tauri/src/router/retry.rs`
- Modify: `src-tauri/src/router/mod.rs` (add `pub mod retry;`)

**Step 1: Write tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_select_fallback_agent() {
        let result = select_fallback_agent("claude", &["claude", "gemini", "codex"]);
        assert_eq!(result, Some("gemini".to_string()));
    }

    #[test]
    fn test_fallback_skips_same_agent() {
        let result = select_fallback_agent("gemini", &["claude", "gemini", "codex"]);
        assert_eq!(result, Some("claude".to_string()));
    }

    #[test]
    fn test_fallback_none_when_only_agent() {
        let result = select_fallback_agent("claude", &["claude"]);
        assert_eq!(result, None);
    }

    #[test]
    fn test_should_retry() {
        let policy = RetryConfig { max_retries: 2, base_delay_ms: 1000 };
        assert!(should_retry(0, &policy));
        assert!(should_retry(1, &policy));
        assert!(!should_retry(2, &policy));
    }
}
```

**Step 2: Implement retry module**

```rust
pub struct RetryConfig {
    pub max_retries: u32,
    pub base_delay_ms: u64,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self { max_retries: 2, base_delay_ms: 5000 }
    }
}

pub fn should_retry(current_attempt: u32, config: &RetryConfig) -> bool {
    current_attempt < config.max_retries
}

pub fn retry_delay_ms(attempt: u32, config: &RetryConfig) -> u64 {
    config.base_delay_ms * 2u64.pow(attempt)
}

/// Select fallback agent. Returns first available agent that isn't the failed one.
/// Preference order: claude > gemini > codex.
pub fn select_fallback_agent(failed_agent: &str, available: &[&str]) -> Option<String> {
    let preference = ["claude", "gemini", "codex"];
    preference
        .iter()
        .find(|&&a| a != failed_agent && available.contains(&a))
        .map(|s| s.to_string())
}
```

**Step 3: Run tests, commit**

```bash
git add src-tauri/src/router/retry.rs src-tauri/src/router/mod.rs
git commit -m "feat: add retry config and fallback agent selection"
```

---

### Task 8: Wire retry/fallback into Phase 2 worker dispatch

**Files:**
- Modify: `src-tauri/src/commands/orchestrator.rs` (worker dispatch section)

**Step 1: Import retry module**

```rust
use crate::router::retry::{RetryConfig, should_retry, retry_delay_ms, select_fallback_agent};
```

**Step 2: Wrap each worker dispatch in retry loop**

For each worker task in a wave:
1. Attempt dispatch
2. If exit code != 0, check `should_retry(attempt, &config)`
3. If retry: log, sleep `retry_delay_ms`, re-dispatch
4. If retries exhausted: call `select_fallback_agent`, dispatch to new agent
5. Record `retry_count`, `original_agent`, `failure_reason` in WorkerResult

**Step 3: Add `retrying` and `falling_back` status emissions**

Emit to frontend:
- `[orchestrator] Retrying task t2 (attempt 2/3)...`
- `[orchestrator] Falling back: t2 reassigned from claude to gemini`

**Step 4: Run full suite, commit**

```bash
git add src-tauri/src/commands/orchestrator.rs
git commit -m "feat: add retry loop and agent fallback to worker dispatch"
```

---

### Task 9: Frontend retry/fallback UI

**Files:**
- Modify: `src/stores/taskStore.ts` (add `retrying` | `falling_back` to TaskStatus)
- Modify: `src/components/views/KanbanView.tsx` (retry badge, fallback label)
- Modify: `src/hooks/useTaskDispatch.ts` (parse retry/fallback events)

**Step 1: Add new statuses**

```typescript
export type TaskStatus = 'pending' | 'routing' | 'running' | 'completed' | 'failed'
  | 'waiting' | 'review' | 'blocked' | 'retrying' | 'falling_back';
```

**Step 2: Add retry badge to KanbanView**

On task card, when status is `retrying`, show amber badge: `Retry 1/2`
When `falling_back`, show: `Reassigning...`

**Step 3: Parse orchestrator events**

In `useTaskDispatch.ts`, detect:
- `[orchestrator] Retrying task` → set status `retrying`
- `[orchestrator] Falling back` → set status `falling_back`

**Step 4: Commit**

```bash
git add src/stores/taskStore.ts src/components/views/KanbanView.tsx src/hooks/useTaskDispatch.ts
git commit -m "feat: frontend retry/fallback status display"
```

---

## Part C: Smart Agent Routing

### Task 10: Enhance TaskRouter with file extension detection

**Files:**
- Modify: `src-tauri/src/router/mod.rs` (TaskRouter::suggest)

**Step 1: Write failing test**

```rust
#[test]
fn suggest_claude_for_rust_file_mention() {
    let result = TaskRouter::suggest("modify src/main.rs to add error handling", false, false, false);
    assert_eq!(result.suggested_tool, "claude");
    assert!(result.confidence > 0.3);
}

#[test]
fn suggest_gemini_for_tsx_mention() {
    let result = TaskRouter::suggest("update components/Header.tsx layout", false, false, false);
    assert_eq!(result.suggested_tool, "gemini");
}
```

**Step 2: Add file extension keywords**

Add to keyword lists:
- Claude: `(".rs", 0.7), (".py", 0.5), ("backend", 0.5), ("api", 0.4)`
- Gemini: `(".tsx", 0.6), (".jsx", 0.6), ("frontend", 0.5), ("component", 0.5), ("style", 0.4)`
- Codex: `(".css", 0.4), ("config", 0.4), ("simple", 0.3)`

**Step 3: Run tests, commit**

```bash
git add src-tauri/src/router/mod.rs
git commit -m "feat: add file extension detection to smart routing"
```

---

### Task 11: Add load-based routing (Layer 2)

**Files:**
- Modify: `src-tauri/src/router/mod.rs` (new `suggest_with_load` method)

**Step 1: Write test**

```rust
#[test]
fn routing_prefers_idle_agent() {
    let load = HashMap::from([
        ("claude".to_string(), 3u32),
        ("gemini".to_string(), 0u32),
        ("codex".to_string(), 1u32),
    ]);
    let result = TaskRouter::suggest_with_load("do something", &load);
    // gemini is idle, should be preferred
    assert_eq!(result.suggested_tool, "gemini");
}
```

**Step 2: Implement**

Add `suggest_with_load(prompt, load_map)` that combines keyword scoring with load penalty:
- `score *= 1.0 / (1.0 + process_count as f32)` per agent

**Step 3: Run tests, commit**

```bash
git add src-tauri/src/router/mod.rs
git commit -m "feat: add load-based routing to smart agent selection"
```

---

### Task 12: Add historical performance tracking (Layer 3)

**Files:**
- Modify: `src-tauri/src/context/store.rs` (add task_outcomes table + queries)
- Modify: `src-tauri/src/router/mod.rs` (integrate history into routing)

**Step 1: Add migration for task_outcomes table**

```sql
CREATE TABLE IF NOT EXISTS task_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    task_type TEXT NOT NULL,
    success INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Step 2: Add `record_task_outcome` and `query_agent_stats` to ContextStore**

```rust
pub fn record_task_outcome(&self, agent: &str, task_type: &str, success: bool, duration_ms: u64) -> Result<()>
pub fn query_agent_stats(&self, task_type: &str) -> Result<Vec<(String, f64, f64)>> // (agent, success_rate, avg_duration)
```

**Step 3: Wire into orchestrator — record outcome after each worker completes**

**Step 4: Wire into TaskRouter — query stats during routing**

**Step 5: Run tests, commit**

```bash
git add src-tauri/src/context/store.rs src-tauri/src/router/mod.rs src-tauri/src/commands/orchestrator.rs
git commit -m "feat: add historical performance tracking for smart routing"
```

---

### Task 13: Integrate routing into orchestrator

**Files:**
- Modify: `src-tauri/src/commands/orchestrator.rs` (resolve_agent call)
- Modify: `src-tauri/src/router/mod.rs` (add `resolve_agent` function)

**Step 1: Create resolve_agent function**

```rust
/// Resolve the best agent for a sub-task using 3-layer routing.
/// Falls back to keyword-based suggestion if history is unavailable.
pub fn resolve_agent(
    prompt: &str,
    suggested_agent: Option<&str>,
    process_counts: &HashMap<String, u32>,
    agent_stats: Option<&[(String, f64, f64)]>,
) -> String
```

**Step 2: Call from orchestrator when SubTaskDef.agent is empty or "auto"**

**Step 3: Run full test suite, commit**

```bash
git add src-tauri/src/router/mod.rs src-tauri/src/commands/orchestrator.rs
git commit -m "feat: integrate 3-layer smart routing into orchestration"
```

---

### Task 14: Final integration test and cleanup

**Files:**
- All modified files

**Step 1: Run full Rust test suite**

Run: `cd src-tauri && cargo test -- --skip credentials`
Expected: All tests PASS (should be 300+ now)

**Step 2: Run TypeScript check**

Run: `cd /Users/birkankader/Documents/Projects/WhaleCode && npx tsc --noEmit 2>&1 | grep -v bindings.ts`
Expected: No new errors

**Step 3: Build check**

Run: `cd src-tauri && cargo build`
Expected: Clean compile

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: orchestration depth - DAG, retry/fallback, smart routing"
```
