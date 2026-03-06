# Phase 7: Task Router + Parallel Execution - Research

**Researched:** 2026-03-06
**Domain:** Task routing, parallel process orchestration, real-time status UI
**Confidence:** HIGH

## Summary

Phase 7 brings together two major capabilities: (1) a task router that suggests which tool (Claude Code or Gemini CLI) should handle a given task based on task type and tool availability, and (2) parallel execution where two tasks run simultaneously on the same project in isolated worktrees with a live status panel.

The existing codebase is well-prepared for this phase. The `ToolAdapter` trait (Phase 6) was explicitly designed for "polymorphic dispatch in the Task Router (Phase 7)" per its doc comment. Git worktree isolation (Phase 5) already ensures each spawned task gets its own branch/worktree. The `useProcessStore` Zustand store already tracks multiple processes with status. The primary work is: (a) building the routing logic (keyword/heuristic-based tool suggestion), (b) creating a unified task dispatch flow that replaces the current tool-specific spawn buttons, (c) adding dependency tracking between tasks, and (d) building a live status panel component.

**Primary recommendation:** Build a `TaskRouter` module in Rust that accepts a task description and returns a suggested tool + confidence, backed by keyword heuristics. On the frontend, create a unified `useTaskDispatch` hook that replaces the current `useClaudeTask`/`useGeminiTask` pattern with a single flow: user enters prompt -> router suggests tool -> user can override -> dispatch. The live status panel is a new React component reading from the existing `useProcessStore`.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PROC-03 | User can run two tool processes in parallel on the same project | Worktree isolation (Phase 5) already provides branch-per-task. AppState tracks multiple processes. Need to lift the per-tool `isRunning` guard and allow concurrent spawns. |
| ROUT-01 | App suggests which tool should handle a given task based on task type | New `TaskRouter` module with keyword/heuristic matching. Architecture patterns section covers the routing rule structure. |
| ROUT-02 | User can override the suggested tool assignment | Frontend task submission UI shows suggestion with override dropdown before dispatch. |
| ROUT-03 | Routing considers tool strengths (Claude for refactoring/architecture, Gemini for large context reads) | Routing rules encode tool strength profiles. See Code Examples section for rule definitions. |
| ROUT-04 | Routing considers current tool availability (busy/idle status) | Query `AppStateInner.processes` to check if a tool already has a running task. Factor into suggestion. |
| SAFE-05 | Live status panel shows each tool's state (idle, running, completed, failed) | New `StatusPanel` component subscribing to `useProcessStore`. Already has `ProcessStatus` type with all needed states. |
| SAFE-06 | Status panel shows current task description and progress for each tool | Extend `ProcessInfo` in the store to include `toolName`, `taskDescription`, and `startedAt` timestamp for elapsed time calculation. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| zustand | 5.x | Frontend state for task routing + status | Already used for `useProcessStore` and `useUIStore` |
| tauri-specta | 2.0.0-rc.21 | Type-safe IPC for new router commands | Already in use, generates TypeScript bindings |
| serde/serde_json | 1.x | Serialize routing rules and task metadata | Already a core dependency |
| chrono | 0.4.x | Elapsed time calculation for status panel | Already a dependency |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| lucide-react | 0.577.0 | Icons for status indicators in panel | Already installed, use for tool icons and status badges |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Keyword heuristics | LLM-based routing | Adds latency + cost for marginal accuracy gain; heuristics sufficient for 2 tools |
| Zustand for status | Tauri global events | Events already proven slow per project decision; Zustand is the established pattern |

## Architecture Patterns

### Recommended Project Structure
```
src-tauri/src/
├── router/
│   ├── mod.rs           # TaskRouter trait + implementation
│   ├── rules.rs         # Routing rules and tool strength profiles
│   └── models.rs        # RoutingSuggestion, ToolStrength types
├── commands/
│   └── router.rs        # IPC: suggest_tool, dispatch_task
src/
├── hooks/
│   └── useTaskDispatch.ts  # Unified dispatch replacing useClaudeTask/useGeminiTask
├── components/
│   └── status/
│       └── StatusPanel.tsx  # Live status panel (SAFE-05, SAFE-06)
├── stores/
│   └── taskStore.ts     # Extended task state (tool assignment, dependencies)
```

### Pattern 1: Heuristic Task Router (Rust-side)
**What:** A Rust module that scores each available tool against a task description using keyword matching and availability checks.
**When to use:** Every time a user submits a task prompt.
**Example:**
```rust
// src-tauri/src/router/mod.rs

use crate::adapters::ToolAdapter;
use crate::adapters::claude::ClaudeAdapter;
use crate::adapters::gemini::GeminiAdapter;

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct RoutingSuggestion {
    pub suggested_tool: String,       // "claude" or "gemini"
    pub confidence: f32,              // 0.0 - 1.0
    pub reason: String,               // Human-readable explanation
    pub alternative_tool: Option<String>,
    pub tool_available: bool,         // false if tool is currently busy
}

pub struct TaskRouter;

impl TaskRouter {
    /// Suggest the best tool for a given task based on keyword heuristics
    /// and current tool availability.
    pub fn suggest(
        prompt: &str,
        claude_busy: bool,
        gemini_busy: bool,
    ) -> RoutingSuggestion {
        let lower = prompt.to_lowercase();
        let mut claude_score: f32 = 0.0;
        let mut gemini_score: f32 = 0.0;

        // Claude strengths: refactoring, architecture, complex logic
        let claude_keywords = [
            ("refactor", 0.8), ("architect", 0.8), ("redesign", 0.7),
            ("fix bug", 0.6), ("debug", 0.5), ("implement", 0.4),
            ("write test", 0.5), ("type", 0.3),
        ];

        // Gemini strengths: large codebase reads, analysis, search
        let gemini_keywords = [
            ("read", 0.6), ("analyze", 0.7), ("search", 0.6),
            ("find", 0.5), ("explain", 0.6), ("summarize", 0.7),
            ("review", 0.5), ("understand", 0.5), ("large", 0.4),
        ];

        for (kw, weight) in &claude_keywords {
            if lower.contains(kw) { claude_score += weight; }
        }
        for (kw, weight) in &gemini_keywords {
            if lower.contains(kw) { gemini_score += weight; }
        }

        // Availability adjustment: penalize busy tools
        if claude_busy { claude_score *= 0.3; }
        if gemini_busy { gemini_score *= 0.3; }

        // Default bias: Claude for general tasks (it's the stronger code generator)
        if claude_score == 0.0 && gemini_score == 0.0 {
            claude_score = 0.5;
        }

        let (tool, alt, score, reason) = if claude_score >= gemini_score {
            ("claude", Some("gemini"), claude_score, Self::explain_choice("Claude Code", &lower, claude_busy))
        } else {
            ("gemini", Some("claude"), gemini_score, Self::explain_choice("Gemini CLI", &lower, gemini_busy))
        };

        let confidence = (score / 2.0).min(1.0); // Normalize

        RoutingSuggestion {
            suggested_tool: tool.to_string(),
            confidence,
            reason,
            alternative_tool: alt.map(|s| s.to_string()),
            tool_available: !(tool == "claude" && claude_busy || tool == "gemini" && gemini_busy),
        }
    }

    fn explain_choice(tool: &str, prompt: &str, busy: bool) -> String {
        if busy {
            return format!("{} suggested but currently busy", tool);
        }
        // Generate brief explanation based on matched keywords
        format!("{} recommended for this task type", tool)
    }
}
```

### Pattern 2: Unified Task Dispatch (Frontend)
**What:** A single `useTaskDispatch` hook that handles the full flow: suggest tool -> show suggestion -> allow override -> dispatch via the correct adapter.
**When to use:** Replaces the current separate Claude/Gemini task buttons.
**Example:**
```typescript
// src/hooks/useTaskDispatch.ts
import { create } from 'zustand';

export type ToolName = 'claude' | 'gemini';
export type TaskStatus = 'pending' | 'routing' | 'running' | 'completed' | 'failed' | 'waiting';

export interface TaskEntry {
  taskId: string;
  prompt: string;
  toolName: ToolName;
  status: TaskStatus;
  description: string;      // Short display description
  startedAt: number | null;  // Date.now() when started
  dependsOn: string | null;  // taskId of dependency, if any
}
```

### Pattern 3: Live Status Panel with Elapsed Time
**What:** A component that polls or subscribes to process state and renders real-time status with elapsed time.
**When to use:** Always visible when tasks are active.
**Example:**
```typescript
// Status panel reads from useProcessStore + extended task metadata
// Uses requestAnimationFrame or 1-second interval for elapsed time updates
function useElapsedTime(startedAt: number | null): string {
  const [elapsed, setElapsed] = useState('');
  useEffect(() => {
    if (!startedAt) { setElapsed(''); return; }
    const interval = setInterval(() => {
      const secs = Math.floor((Date.now() - startedAt) / 1000);
      const min = Math.floor(secs / 60);
      const sec = secs % 60;
      setElapsed(`${min}:${sec.toString().padStart(2, '0')}`);
    }, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);
  return elapsed;
}
```

### Pattern 4: Task Dependency Waiting
**What:** When task B depends on task A's output, task B enters a "waiting" state and only dispatches after task A completes.
**When to use:** Success criterion 5 -- "A task that depends on another tool's output waits for that tool to finish before dispatching."
**Example:**
```typescript
// In task dispatch logic:
async function dispatchWithDependency(task: TaskEntry) {
  if (task.dependsOn) {
    const depProcess = useProcessStore.getState().processes.get(task.dependsOn);
    if (depProcess && depProcess.status === 'running') {
      // Mark as waiting, subscribe to dependency completion
      updateTaskStatus(task.taskId, 'waiting');
      await waitForCompletion(task.dependsOn);
    }
    // Check if dependency failed
    const depFinal = useProcessStore.getState().processes.get(task.dependsOn);
    if (depFinal?.status === 'failed') {
      updateTaskStatus(task.taskId, 'failed');
      return; // Don't dispatch if dependency failed
    }
  }
  // Proceed with dispatch
  await actualDispatch(task);
}
```

### Anti-Patterns to Avoid
- **Separate spawn buttons per tool:** The current UI has separate Claude/Gemini buttons. Phase 7 should unify into a single "Submit Task" flow with routing.
- **Blocking on tool suggestion:** The router should return instantly (heuristic-based, not LLM-based). Never add latency to task submission.
- **Polling for process status:** The existing Zustand store already provides reactive state. Don't add a polling loop for status -- subscribe to the store.
- **Removing existing hooks entirely:** Keep `useClaudeTask`/`useGeminiTask` as internal implementation. The new `useTaskDispatch` should compose them, not replace their internals.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Elapsed time display | Manual Date math with edge cases | Simple interval + Math.floor pattern | Only needs second precision, no timezone issues |
| Reactive status updates | Custom pub/sub for status changes | Zustand subscriptions | Already the established pattern in the app |
| Process isolation | Custom file locking | Git worktree per task (already built) | Phase 5 solved this completely |
| Tool availability check | Polling backend | Read from AppState.processes directly | Already tracked per ProcessEntry.status |

**Key insight:** Most of the hard infrastructure (worktree isolation, process tracking, adapter abstraction) already exists. Phase 7 is primarily a composition/orchestration layer on top of existing primitives.

## Common Pitfalls

### Pitfall 1: Race Condition on Simultaneous Spawn
**What goes wrong:** Two tasks submitted rapidly could both check "is tool X available?" and both proceed, exceeding the intended parallelism limit.
**Why it happens:** Frontend state updates are asynchronous; `useProcessStore.setState` is not atomic across checks.
**How to avoid:** Gate parallel dispatch on the Rust backend. Add a `max_concurrent_per_tool: 1` check in the spawn command that returns an error if the tool already has a running process. Frontend shows the error gracefully.
**Warning signs:** Two Claude processes running simultaneously on different worktrees.

### Pitfall 2: Stale Status After Process Crash
**What goes wrong:** If a process is killed externally (OOM, force quit), the status panel shows "running" indefinitely.
**Why it happens:** The waiter task in `process/manager.rs` might not fire if the tokio runtime is disrupted.
**How to avoid:** The existing waiter task handles this correctly for normal exits. For crash scenarios, add a periodic liveness check (e.g., `kill(pgid, 0)` to test if process exists) that runs every 5 seconds for "running" processes.
**Warning signs:** Process shows "running" but no output for extended periods.

### Pitfall 3: Dependency Deadlock
**What goes wrong:** Task A depends on Task B, and Task B depends on Task A (circular dependency).
**Why it happens:** User error or UI allowing circular dependency selection.
**How to avoid:** Validate dependency graph before accepting. With only 2 concurrent tasks, this is simple: if A depends on B, B cannot depend on A. Reject circular dependencies at submission time.
**Warning signs:** Both tasks stuck in "waiting" state.

### Pitfall 4: ProcessInfo Missing Tool Metadata
**What goes wrong:** The status panel needs to show which tool is running, but `ProcessInfo.cmd` only stores a truncated command string like `"claude: Refactor the auth..."`.
**Why it happens:** Current `ProcessInfo` was designed for display, not structured data.
**How to avoid:** Extend `ProcessInfo` with explicit `toolName: ToolName` and `taskDescription: string` fields rather than parsing `cmd`.
**Warning signs:** Status panel has to regex-parse the `cmd` field to determine tool type.

### Pitfall 5: Worktree Cleanup on Failed Parallel Tasks
**What goes wrong:** If both tasks fail or one is cancelled, their worktrees accumulate without being cleaned up.
**Why it happens:** Cleanup only happens on next spawn via `cleanup_stale_worktrees`, but if no new task is spawned, worktrees persist.
**How to avoid:** Add cleanup-on-completion: when a task finishes (completed/failed), clean up its worktree if the user doesn't want to merge. The existing `remove_worktree` method handles this.
**Warning signs:** `.whalecode-worktrees/` directory grows with abandoned worktrees.

## Code Examples

### Suggest Tool IPC Command
```rust
// src-tauri/src/commands/router.rs
#[tauri::command]
#[specta::specta]
pub async fn suggest_tool(
    prompt: String,
    state: tauri::State<'_, AppState>,
) -> Result<RoutingSuggestion, String> {
    let inner = state.lock().map_err(|e| e.to_string())?;

    // Check which tools are currently busy
    let claude_busy = inner.processes.values().any(|p| {
        matches!(p.status, ProcessStatus::Running) // Would need tool_name on ProcessEntry
    });
    let gemini_busy = inner.processes.values().any(|p| {
        matches!(p.status, ProcessStatus::Running)
    });

    // Note: to properly check per-tool busyness, ProcessEntry needs a tool_name field.
    // Alternative: check via TaskInfo or a new field on ProcessEntry.

    Ok(TaskRouter::suggest(&prompt, claude_busy, gemini_busy))
}
```

### Extended ProcessEntry for Tool Tracking
```rust
// Extension to state.rs
#[derive(Debug)]
pub struct ProcessEntry {
    pub pgid: i32,
    pub status: ProcessStatus,
    pub tool_name: String,        // NEW: "claude" or "gemini"
    pub task_description: String, // NEW: user's prompt (truncated)
    pub started_at: i64,          // NEW: unix timestamp millis
}
```

### Dispatch Task IPC Command
```rust
// src-tauri/src/commands/router.rs
#[tauri::command]
#[specta::specta]
pub async fn dispatch_task(
    prompt: String,
    project_dir: String,
    tool_name: String,  // "claude" or "gemini" -- possibly overridden by user
    on_event: Channel<OutputEvent>,
    state: tauri::State<'_, AppState>,
    context_store: tauri::State<'_, ContextStore>,
) -> Result<String, String> {
    match tool_name.as_str() {
        "claude" => spawn_claude_task(prompt, project_dir, on_event, state, context_store).await,
        "gemini" => spawn_gemini_task(prompt, project_dir, on_event, state, context_store).await,
        _ => Err(format!("Unknown tool: {}", tool_name)),
    }
}
```

### Frontend Status Panel Component
```typescript
// src/components/status/StatusPanel.tsx
interface StatusPanelProps {
  className?: string;
}

export function StatusPanel({ className }: StatusPanelProps) {
  const processes = useProcessStore((s) => s.processes);
  const processList = Array.from(processes.values());

  return (
    <div className={className}>
      <div className="text-xs font-semibold text-zinc-400 mb-2">Tool Status</div>
      <div className="space-y-2">
        {processList.length === 0 ? (
          <div className="text-xs text-zinc-600">All tools idle</div>
        ) : (
          processList.map((proc) => (
            <StatusRow key={proc.taskId} process={proc} />
          ))
        )}
      </div>
    </div>
  );
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Tool-specific spawn buttons | Unified task submission with routing | Phase 7 | Single entry point for all tasks |
| Manual tool selection only | Suggested + overridable routing | Phase 7 | Reduces cognitive load on user |
| Single task at a time | Two parallel tasks on same project | Phase 7 | Core product differentiator |
| No status overview | Live status panel with elapsed time | Phase 7 | User always knows what each tool is doing |

## Open Questions

1. **Maximum concurrent tasks per tool**
   - What we know: Requirements say "two tasks run simultaneously." The worktree system supports arbitrary parallel worktrees.
   - What's unclear: Should the limit be 1 per tool (Claude + Gemini simultaneously) or 2 of any mix (2x Claude, 2x Gemini, or 1+1)?
   - Recommendation: Implement as 1 per tool for v1 (total max 2). This matches the "two tools" mental model and avoids API rate limit issues from running multiple instances of the same tool.

2. **Routing rule extensibility**
   - What we know: Only 2 tools in v1 (REQUIREMENTS.md: "More than 3 tools in v1" is out of scope).
   - What's unclear: How sophisticated should routing be?
   - Recommendation: Keep it simple -- keyword heuristics. The ToolAdapter trait already supports adding tools; routing rules can be extended when a third tool is added.

3. **Task dependency UI**
   - What we know: Success criterion 5 requires dependency waiting.
   - What's unclear: How does the user specify a dependency? Auto-detect vs manual?
   - Recommendation: Start with manual (optional dropdown "Wait for: [task X]" at submission). Auto-detection is Phase 8+ territory.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 3.x (frontend), cargo test (backend) |
| Config file | vite.config.ts (test section), Cargo.toml |
| Quick run command | `cd src-tauri && cargo test router` / `npx vitest run --reporter=verbose` |
| Full suite command | `cd src-tauri && cargo test && cd .. && npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ROUT-01 | Router suggests correct tool for task types | unit | `cd src-tauri && cargo test router -x` | Wave 0 |
| ROUT-02 | User override changes dispatched tool | unit | `npx vitest run src/tests/taskDispatch.test.ts` | Wave 0 |
| ROUT-03 | Claude scored higher for refactoring keywords, Gemini for analysis | unit | `cd src-tauri && cargo test router::tests::strength -x` | Wave 0 |
| ROUT-04 | Busy tool gets lower score | unit | `cd src-tauri && cargo test router::tests::availability -x` | Wave 0 |
| PROC-03 | Two processes can run simultaneously | integration | `cd src-tauri && cargo test parallel -x` | Wave 0 |
| SAFE-05 | Status panel renders correct states | unit | `npx vitest run src/tests/StatusPanel.test.tsx` | Wave 0 |
| SAFE-06 | Status panel shows description and elapsed time | unit | `npx vitest run src/tests/StatusPanel.test.tsx` | Wave 0 |

### Sampling Rate
- **Per task commit:** `cd src-tauri && cargo test router && npx vitest run`
- **Per wave merge:** Full suite
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src-tauri/src/router/mod.rs` -- routing logic with unit tests
- [ ] `src/tests/taskDispatch.test.ts` -- frontend dispatch hook tests
- [ ] `src/tests/StatusPanel.test.tsx` -- status panel rendering tests

## Sources

### Primary (HIGH confidence)
- Project codebase direct inspection -- all source files listed in research
- `src-tauri/src/adapters/mod.rs` -- ToolAdapter trait with Phase 7 doc comment
- `src-tauri/src/state.rs` -- AppState with ProcessEntry/ProcessStatus
- `src-tauri/src/process/manager.rs` -- spawn_with_env supporting multiple concurrent processes
- `src-tauri/src/worktree/manager.rs` -- worktree isolation per task
- `src/hooks/useProcess.ts` -- Zustand store already tracking multiple processes
- `src/hooks/useClaudeTask.ts` / `useGeminiTask.ts` -- existing per-tool spawn patterns

### Secondary (MEDIUM confidence)
- `.planning/REQUIREMENTS.md` -- requirement definitions and traceability
- `.planning/STATE.md` -- project decisions and accumulated context

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all libraries already in use, no new dependencies needed
- Architecture: HIGH - building on existing patterns (ToolAdapter, ProcessStore, worktrees)
- Pitfalls: HIGH - identified from direct code analysis of existing spawn/state flows

**Research date:** 2026-03-06
**Valid until:** 2026-04-06 (stable -- no external dependency changes expected)
