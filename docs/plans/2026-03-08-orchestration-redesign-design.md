# Orchestration Redesign: Interactive Master + Single-shot Workers

**Date:** 2026-03-08
**Status:** Approved

## Problem

Current orchestration has three issues:
1. **JSON parse failure**: Master agent outputs thinking/exec text before JSON. Parser fails to extract the result, silently falls back to single-agent mode.
2. **Stateless master**: Master runs as 3 separate processes (decompose → workers → review). No continuity, no ability to answer worker questions mid-execution.
3. **Inconsistent agent output**: Each agent's raw output looks different. No unified display format.

## Design

### Approach: Interactive Master + Single-shot Workers

Master agent runs in interactive mode (no `-p` flag, stdin/stdout multi-turn). Workers run single-shot (`-p <prompt>`). Master stays alive throughout the orchestration lifecycle.

### Master Agent Lifecycle

- Spawned without `-p` flag, in interactive mode
- `--output-format stream-json` preserved for NDJSON event parsing
- New adapter method: `build_interactive_command()` (alongside existing `build_command()`)
- All prompts sent via stdin, newline-terminated
- Responses read from NDJSON stream, turn completion detected via `is_turn_complete()` (e.g. `Result` event)
- Master lives until `/clear` or session close

**State change:**
```rust
pub struct OrchestrationPlan {
    // ... existing fields
    pub master_process_id: Option<String>,
    pub phase: OrchestrationPhase, // adds WaitingForInput variant
}
```

### Orchestration Flow

**Phase 1 - Decompose:**
1. Master spawned (interactive)
2. Decompose prompt sent to stdin
3. `Result` event waited from NDJSON stream
4. Adapter's `extract_result()` extracts JSON → `DecompositionResult`
5. Parse failure → explicit error to user (no silent single-agent fallback)

**Phase 2 - Execute:**
1. Workers spawned per sub-task (single-shot, `-p`)
2. Worker streams monitored
3. Worker asks a question:
   - Adapter `detect_question()` → `Some(Question)`
   - Worker process naturally pauses on stdin
   - Question forwarded to master's stdin: `"Worker [agent] asks: ..."`
   - Master responds:
     - Normal answer → written to worker's stdin, worker continues
     - `{"ask_user": "..."}` → UI shows input prompt → user answers → answer to master → master formulates response → written to worker's stdin
4. Multiple concurrent questions queued (FIFO), sent to master one at a time
5. Worker completion → `WorkerResult` collected

**Phase 3 - Review:**
1. All worker results sent to master's stdin as review prompt
2. Master analyzes, returns summary
3. Shown in UI as `ReviewResult`
4. Master process stays alive

**Phase 4 - Continue (new):**
- User sends new prompt → sent directly to master's stdin
- Master can request new workers (JSON format) or respond directly

### ToolAdapter Extensions

```rust
pub trait ToolAdapter {
    // --- existing ---
    fn build_command(&self, prompt: &str, cwd: &str, api_key: &str) -> ToolCommand;
    fn parse_stream_line(&self, line: &str) -> Option<String>;
    fn validate_result_json(&self, result_json: &str) -> Result<(), String>;
    fn detect_rate_limit(&self, line: &str) -> Option<RateLimitInfo>;
    fn retry_policy(&self) -> RetryPolicy;
    fn name(&self) -> &str;

    // --- new ---
    fn build_interactive_command(&self, cwd: &str, api_key: &str) -> ToolCommand;
    fn detect_question(&self, event: &StreamEvent) -> Option<Question>;
    fn parse_display_output(&self, line: &str) -> Option<DisplayLine>;
    fn extract_result(&self, output_lines: &[String]) -> Option<String>;
    fn is_turn_complete(&self, event: &StreamEvent) -> bool;
}
```

**New types:**
```rust
pub struct Question {
    pub source_agent: String,
    pub content: String,
    pub question_type: QuestionType,
}

pub enum QuestionType {
    Technical,
    Clarification,
    Permission,
}

pub struct DisplayLine {
    pub content: String,
    pub line_type: DisplayLineType,
}

pub enum DisplayLineType {
    AgentThinking,
    ToolExecution,
    Result,
    Info,
}
```

**Per-adapter responsibilities:**
- `parse_display_output()`: Normalizes each agent's raw stream into uniform `DisplayLine` format
- `extract_result()`: Agent-specific JSON extraction, replaces generic `parse_decomposition_json()`
- `detect_question()`: Agent-specific question pattern detection from NDJSON events

### `/clear` and Context Management

**`/clear` flow:**
1. User triggers `/clear`
2. Backend sends context backup prompt to master's stdin:
   ```
   Back up all context. Write a comprehensive summary including:
   - Original task and sub-tasks
   - What each worker did and their results
   - Which files changed
   - Open questions or remaining work
   - Decisions and rationale

   Output as {"context_backup": "<markdown content>"} JSON format.
   ```
3. Master returns `{"context_backup": "..."}`
4. Backend writes content to `<project_dir>/context.md`
5. All agent processes killed (master included)
6. UI cleared, `OrchestrationPlan` reset

**Context restore (new prompt after `/clear`):**
1. New master spawned (interactive)
2. First stdin prompt:
   ```
   Previous session context is below. Read and remember, then proceed to the new task.

   <context.md contents>

   ---
   New task: <user's new prompt>
   ```
3. Master decomposes → normal flow continues
4. Master includes relevant context in worker prompts

**context.md management:**
- Each `/clear` overwrites previous `context.md` (single file, simple)
- Written to project root directory
- Not auto-added to `.gitignore` — left to user

### Frontend Changes

**Output display:**
- `MultiAgentOutput` uses `DisplayLine` types
- Uniform format across all agents via `parse_display_output()`
- Styling by `DisplayLineType`:
  - `AgentThinking` → dim/gray text
  - `ToolExecution` → mono font, dark background
  - `Result` → normal text
  - `Info` → blue/info color

**Question/Answer UI:**
- `{"ask_user": "..."}` triggers input prompt in `MessengerPanel`
- Shows question source (which agent asked)
- User types answer → backend → master's stdin
- Worker's status badge shows `waiting` while question pending

**Context info:**
- `ContextInfoPanel` unchanged (token/cost display)
- On orchestration completion, remaining context per agent shown
- Master status shows `idle` (alive, awaiting new prompt)

**`/clear` button:**
- `/clear` command or button in UI
- Shows "Backing up context..." loading state
- On completion, output cleared, new prompt area activated

### Error Handling

**Master process dies:**
- Stream cut detected by waiter task
- All pending worker questions error out
- User notification: "Master agent terminated unexpectedly"
- Option: spawn new master (with context.md restore if available) or cancel orchestration

**Worker process dies:**
- Existing `WorkerResult` collects exit code + output
- Master notified: "Worker [agent] terminated with exit code [N]"
- Master continues coordinating remaining workers
- Failed workers reported in review phase

**JSON parse failure (current bug fix):**
- `extract_result()` is now adapter-specific → each agent knows its own format
- On failure: explicit error to user instead of silent single-agent fallback
- Optional: remind master to respond in JSON format (retry, max 1 time)

**`/clear` timeout:**
- 30-second timeout for master context backup
- On timeout: backend creates fallback summary from existing `output_lines`
- Processes killed regardless

**Concurrent questions:**
- Multiple workers asking simultaneously → FIFO queue
- Sent to master one at a time, responses routed to correct worker
