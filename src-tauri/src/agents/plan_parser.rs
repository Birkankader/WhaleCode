//! Extract the structured plan out of a master agent's free-form
//! output.
//!
//! All three master prompts instruct the agent to end with a
//! ```json
//! { "reasoning": "...", "subtasks": [...] }
//! ```
//! block. Agents prefix this with reasoning prose (sometimes even with
//! `<thinking>` tags); some emit a draft block mid-response and then
//! a final one. We take the **last** fenced ```json block, on the
//! premise that if the agent revised itself, its final answer is the
//! one that counts.
//!
//! Parse errors surface as [`AgentError::ParseFailed`] with the raw
//! output attached so retries (Phase 3) can pass the exact bytes back
//! into a follow-up prompt.

use std::collections::HashSet;

use serde::Deserialize;

use crate::ipc::AgentKind;

use super::{AgentError, Plan, PlannedSubtask};

/// End-to-end: raw agent stdout → validated [`Plan`].
pub fn parse_and_validate(
    raw_output: &str,
    available_workers: &[AgentKind],
) -> Result<Plan, AgentError> {
    let json_str = extract_fenced_json(raw_output).ok_or_else(|| AgentError::ParseFailed {
        reason: "no ```json fenced block found in output".to_string(),
        raw_output: raw_output.to_string(),
    })?;

    let plan = parse_plan_json(&json_str).map_err(|e| AgentError::ParseFailed {
        reason: format!("JSON didn't match Plan shape: {e}"),
        raw_output: raw_output.to_string(),
    })?;

    validate_plan(&plan, available_workers).map_err(|e| AgentError::ParseFailed {
        reason: e,
        raw_output: raw_output.to_string(),
    })?;

    Ok(plan)
}

/// Return the content of the **last** ```json fenced block in
/// `raw`. Trims surrounding whitespace so the caller can hand the
/// result straight to `serde_json`.
///
/// Case-insensitive on the language tag (accepts `JSON`, `Json`, …).
pub fn extract_fenced_json(raw: &str) -> Option<String> {
    let mut search_from = 0usize;
    let mut last: Option<(usize, usize)> = None;

    // Walk forward collecting every `(open, close)` pair. The last
    // complete pair wins. We intentionally don't bail on the first
    // match — agents often emit an example block before the real one.
    while let Some(open_rel) = find_json_fence_open(&raw[search_from..]) {
        let open_abs = search_from + open_rel.end;
        if let Some(close_rel) = raw[open_abs..].find("```") {
            let close_abs = open_abs + close_rel;
            last = Some((open_abs, close_abs));
            search_from = close_abs + 3;
        } else {
            // Unterminated fence. Nothing useful after it — stop.
            break;
        }
    }

    let (start, end) = last?;
    Some(raw[start..end].trim().to_string())
}

/// Find the next ```json fence opening. Returns a range whose `end`
/// points at the first character after the opening fence (so callers
/// can start scanning the payload from there).
struct FenceMatch {
    end: usize,
}

fn find_json_fence_open(hay: &str) -> Option<FenceMatch> {
    // We scan for "```" then check the language tag follows. Using
    // a lowercase-insensitive prefix match keeps `JSON` etc. working
    // without pulling in `regex`.
    let mut cursor = 0usize;
    while let Some(fence_rel) = hay[cursor..].find("```") {
        let fence_abs = cursor + fence_rel;
        let after = fence_abs + 3;
        // Grab up to the next newline (or end of string) as the lang
        // tag candidate.
        let line_end = hay[after..]
            .find('\n')
            .map(|i| after + i)
            .unwrap_or(hay.len());
        let tag = hay[after..line_end].trim();
        if tag.eq_ignore_ascii_case("json") {
            // Payload starts on the next line.
            let payload_start = (line_end + 1).min(hay.len());
            return Some(FenceMatch { end: payload_start });
        }
        cursor = line_end;
    }
    None
}

/// Parse the extracted JSON string into a [`Plan`]. Accepts the on-the-
/// wire snake_case shape agents produce (see the prompt templates).
fn parse_plan_json(json: &str) -> Result<Plan, serde_json::Error> {
    #[derive(Deserialize)]
    struct PlanWire {
        reasoning: String,
        subtasks: Vec<PlannedSubtask>,
    }
    let wire: PlanWire = serde_json::from_str(json)?;
    Ok(Plan {
        reasoning: wire.reasoning,
        subtasks: wire.subtasks,
    })
}

/// Validate the plan against orchestrator constraints. The spec for
/// Phase 2 requires: ≥1 subtask, every `assigned_worker` must be one
/// of the available workers, dependency indices in-range, and no
/// cycles.
pub fn validate_plan(plan: &Plan, available_workers: &[AgentKind]) -> Result<(), String> {
    if plan.subtasks.is_empty() {
        return Err("plan has no subtasks".to_string());
    }

    let n = plan.subtasks.len();
    let allowed: HashSet<AgentKind> = available_workers.iter().copied().collect();

    for (i, st) in plan.subtasks.iter().enumerate() {
        // Titles drive the WorkerNode body: an empty one renders as an
        // invisible card post-approval. Matches `validate_draft`'s
        // non-empty invariant on the edit path — reject the master plan
        // at ingestion so we don't ship invisible rows downstream.
        if st.title.trim().is_empty() {
            return Err(format!("subtask {i} has an empty title"));
        }
        if !allowed.contains(&st.assigned_worker) {
            return Err(format!(
                "subtask {i} assigned to unavailable worker {:?}",
                st.assigned_worker
            ));
        }
        for &dep in &st.dependencies {
            if dep >= n {
                return Err(format!(
                    "subtask {i} depends on out-of-range index {dep} (plan has {n})"
                ));
            }
            if dep == i {
                return Err(format!("subtask {i} depends on itself"));
            }
        }
    }

    if let Some(cycle_at) = find_cycle(&plan.subtasks) {
        return Err(format!("dependency cycle involving subtask {cycle_at}"));
    }

    Ok(())
}

/// Classic white/grey/black DFS. Returns the first index that sits on
/// a cycle, or `None` if the graph is acyclic.
fn find_cycle(subtasks: &[PlannedSubtask]) -> Option<usize> {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Color {
        White,
        Grey,
        Black,
    }

    let n = subtasks.len();
    let mut color = vec![Color::White; n];

    fn dfs(i: usize, g: &[PlannedSubtask], color: &mut [Color]) -> Option<usize> {
        color[i] = Color::Grey;
        for &dep in &g[i].dependencies {
            if dep >= g.len() {
                // Out-of-range already rejected earlier; skip defensively.
                continue;
            }
            match color[dep] {
                Color::Grey => return Some(i),
                Color::White => {
                    if let Some(cycle) = dfs(dep, g, color) {
                        return Some(cycle);
                    }
                }
                Color::Black => {}
            }
        }
        color[i] = Color::Black;
        None
    }

    for i in 0..n {
        if color[i] == Color::White {
            if let Some(cycle) = dfs(i, subtasks, &mut color) {
                return Some(cycle);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- extract_fenced_json ----------------------------------------

    #[test]
    fn extracts_single_fenced_block() {
        let raw = "some prose\n```json\n{\"x\": 1}\n```\ntrailing";
        assert_eq!(extract_fenced_json(raw).unwrap(), "{\"x\": 1}");
    }

    #[test]
    fn returns_last_when_multiple_blocks() {
        let raw = "```json\n{\"draft\": true}\n```\nlater...\n```json\n{\"final\": true}\n```";
        assert_eq!(extract_fenced_json(raw).unwrap(), "{\"final\": true}");
    }

    #[test]
    fn case_insensitive_language_tag() {
        let raw = "```JSON\n{\"x\": 1}\n```";
        assert_eq!(extract_fenced_json(raw).unwrap(), "{\"x\": 1}");
    }

    #[test]
    fn none_when_no_fenced_block() {
        assert!(extract_fenced_json("just prose no fences").is_none());
    }

    #[test]
    fn ignores_non_json_fences() {
        let raw = "```bash\necho hi\n```\n```json\n{\"real\": true}\n```";
        assert_eq!(extract_fenced_json(raw).unwrap(), "{\"real\": true}");
    }

    #[test]
    fn unterminated_fence_is_none() {
        let raw = "```json\n{ half-written";
        assert!(extract_fenced_json(raw).is_none());
    }

    // --- parse_and_validate end-to-end ------------------------------

    fn valid_plan_json() -> &'static str {
        r#"reasoning prose here

```json
{
  "reasoning": "breaking into two steps",
  "subtasks": [
    {"title": "setup", "why": "needed first", "assigned_worker": "claude", "dependencies": []},
    {"title": "finish", "why": "builds on setup", "assigned_worker": "gemini", "dependencies": [0]}
  ]
}
```"#
    }

    #[test]
    fn happy_path_roundtrip() {
        let plan = parse_and_validate(
            valid_plan_json(),
            &[AgentKind::Claude, AgentKind::Gemini],
        )
        .unwrap();
        assert_eq!(plan.subtasks.len(), 2);
        assert_eq!(plan.subtasks[0].assigned_worker, AgentKind::Claude);
        assert_eq!(plan.subtasks[1].dependencies, vec![0]);
    }

    #[test]
    fn defaults_missing_dependencies_to_empty() {
        let raw = r#"```json
{"reasoning": "x", "subtasks": [{"title": "a", "why": "b", "assigned_worker": "claude"}]}
```"#;
        let plan = parse_and_validate(raw, &[AgentKind::Claude]).unwrap();
        assert_eq!(plan.subtasks[0].dependencies, Vec::<usize>::new());
    }

    #[test]
    fn missing_fenced_block_is_parse_failed() {
        let err = parse_and_validate("no plan here", &[AgentKind::Claude]).unwrap_err();
        match err {
            AgentError::ParseFailed { reason, raw_output } => {
                assert!(reason.contains("no ```json"));
                assert_eq!(raw_output, "no plan here");
            }
            e => panic!("expected ParseFailed, got {e:?}"),
        }
    }

    #[test]
    fn malformed_json_surfaces_serde_error() {
        let raw = "```json\n{not: valid json}\n```";
        let err = parse_and_validate(raw, &[AgentKind::Claude]).unwrap_err();
        match err {
            AgentError::ParseFailed { reason, .. } => {
                assert!(reason.contains("JSON didn't match Plan shape"));
            }
            e => panic!("expected ParseFailed, got {e:?}"),
        }
    }

    #[test]
    fn empty_subtasks_rejected() {
        let raw = "```json\n{\"reasoning\": \"x\", \"subtasks\": []}\n```";
        let err = parse_and_validate(raw, &[AgentKind::Claude]).unwrap_err();
        match err {
            AgentError::ParseFailed { reason, .. } => {
                assert!(reason.contains("no subtasks"));
            }
            e => panic!("expected ParseFailed, got {e:?}"),
        }
    }

    #[test]
    fn empty_title_rejected() {
        // Master returning a blank title would render as an invisible
        // WorkerNode after approval; catch it at plan ingestion.
        let raw = r#"```json
{"reasoning": "x", "subtasks": [{"title": "   ", "why": "b", "assigned_worker": "claude", "dependencies": []}]}
```"#;
        let err = parse_and_validate(raw, &[AgentKind::Claude]).unwrap_err();
        match err {
            AgentError::ParseFailed { reason, .. } => {
                assert!(reason.contains("empty title"), "got {reason}");
            }
            e => panic!("expected ParseFailed, got {e:?}"),
        }
    }

    #[test]
    fn unavailable_worker_rejected() {
        let raw = r#"```json
{"reasoning": "x", "subtasks": [{"title": "a", "why": "b", "assigned_worker": "gemini", "dependencies": []}]}
```"#;
        // Only Claude is available — Gemini assignment must fail validation.
        let err = parse_and_validate(raw, &[AgentKind::Claude]).unwrap_err();
        match err {
            AgentError::ParseFailed { reason, .. } => {
                assert!(reason.contains("unavailable worker"));
            }
            e => panic!("expected ParseFailed, got {e:?}"),
        }
    }

    #[test]
    fn out_of_range_dependency_rejected() {
        let raw = r#"```json
{"reasoning": "x", "subtasks": [{"title": "a", "why": "b", "assigned_worker": "claude", "dependencies": [5]}]}
```"#;
        let err = parse_and_validate(raw, &[AgentKind::Claude]).unwrap_err();
        match err {
            AgentError::ParseFailed { reason, .. } => {
                assert!(reason.contains("out-of-range"));
            }
            e => panic!("expected ParseFailed, got {e:?}"),
        }
    }

    #[test]
    fn self_dependency_rejected() {
        let raw = r#"```json
{"reasoning": "x", "subtasks": [{"title": "a", "why": "b", "assigned_worker": "claude", "dependencies": [0]}]}
```"#;
        let err = parse_and_validate(raw, &[AgentKind::Claude]).unwrap_err();
        match err {
            AgentError::ParseFailed { reason, .. } => {
                assert!(reason.contains("depends on itself"));
            }
            e => panic!("expected ParseFailed, got {e:?}"),
        }
    }

    #[test]
    fn dependency_cycle_rejected() {
        // a depends on b, b depends on a.
        let raw = r#"```json
{"reasoning": "x", "subtasks": [
  {"title": "a", "why": "", "assigned_worker": "claude", "dependencies": [1]},
  {"title": "b", "why": "", "assigned_worker": "claude", "dependencies": [0]}
]}
```"#;
        let err = parse_and_validate(raw, &[AgentKind::Claude]).unwrap_err();
        match err {
            AgentError::ParseFailed { reason, .. } => {
                assert!(reason.contains("cycle"), "got {reason}");
            }
            e => panic!("expected ParseFailed, got {e:?}"),
        }
    }
}
