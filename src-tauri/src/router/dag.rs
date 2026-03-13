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

impl std::error::Error for DagError {}

/// Sort tasks into execution waves using Kahn's algorithm.
/// Returns Vec<Vec<String>> where each inner vec is a wave of parallelizable tasks.
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
        let deg = in_degree.entry(node.id.clone()).or_insert(0);
        *deg += node.depends_on.len();
        for dep in &node.depends_on {
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

/// Given completed task IDs, return which tasks are now ready to run.
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
