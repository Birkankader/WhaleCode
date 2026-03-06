# Phase 6: Gemini CLI Adapter - Research

**Researched:** 2026-03-06
**Domain:** Gemini CLI integration, Tool trait abstraction, output validation, rate limit handling
**Confidence:** MEDIUM

## Summary

Phase 6 adds a second AI tool adapter (Gemini CLI) to WhaleCode, proving the Tool trait pattern works with multiple implementations. The existing Claude Code adapter (`src-tauri/src/adapters/claude.rs`, `src-tauri/src/commands/claude.rs`, `src/hooks/useClaudeTask.ts`, `src/lib/claude.ts`) provides the exact blueprint -- the Gemini adapter mirrors every layer: Rust adapter module, IPC commands, frontend hook, and event formatter.

Gemini CLI (npm `@google/gemini-cli` v0.32.x) supports headless mode via `-p "prompt"` with `--output-format stream-json` for NDJSON streaming and `--output-format json` for single-response JSON. The stream-json format emits event types matching Claude's pattern: `init`, `message`, `tool_use`, `tool_result`, `error`, and `result`. This is fortunate -- both adapters can share the same general event taxonomy, simplifying the frontend formatting layer.

**Primary recommendation:** Mirror the Claude adapter structure exactly for Gemini. Extract shared patterns (retry policy, rate limit detection shape, validation trait) into common modules only where duplication is truly mechanical. Do NOT build a generic "Tool trait" as a Rust trait object -- keep it as a structural pattern (same function signatures, same IPC shape) that the frontend and process manager consume identically. The Phase 7 router will formalize the dispatch interface.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PROC-02 | User can spawn a Gemini CLI subprocess in headless mode and see streaming output in real-time | Gemini CLI supports `-p "prompt" --output-format stream-json` for NDJSON streaming; process manager `spawn_with_env` is reusable |
| INTG-02 | Gemini CLI adapter uses CLI subprocess with JSON output mode | `--output-format stream-json` confirmed working in v0.32.x (merged PR #10883); NDJSON event types: init, message, tool_use, tool_result, result |
| INTG-03 | Each adapter validates output content (not just exit codes) for silent failures | Gemini result event has `stats` and `response` fields; validate non-empty response + check error event presence; mirror `validate_result` pattern |
| INTG-04 | Adapters handle API rate limits with backoff and user notification | Gemini returns 429 RESOURCE_EXHAUSTED for quota; `general.maxAttempts` configurable up to 10; detect via stderr "429" / "RESOURCE_EXHAUSTED" / "quota" strings |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @google/gemini-cli | 0.32.x | Gemini CLI binary | Official Google CLI, npm-distributed, supports headless + stream-json |
| keyring | 3.x | macOS Keychain access for Gemini API key | Already used for Claude; same pattern, different user string |
| serde / serde_json | existing | NDJSON parsing for Gemini events | Already in project for Claude adapter |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| uuid | existing | Task ID generation | Already in project |
| tokio | existing | Async subprocess management | Already in project |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| CLI subprocess | Gemini API directly (REST) | CLI gives tool execution, sandboxing, ReAct loop for free; API would require reimplementing agent loop |
| stream-json format | json (single response) | stream-json gives real-time visibility matching Claude UX; json only returns at completion |

**Installation:**
```bash
npm install -g @google/gemini-cli
```
No new Rust crates needed -- existing dependencies cover all requirements.

## Architecture Patterns

### Recommended Project Structure
```
src-tauri/src/
├── adapters/
│   ├── mod.rs            # pub mod claude; pub mod gemini;
│   ├── claude.rs         # (existing) Claude NDJSON parser, command builder, validator
│   └── gemini.rs         # (NEW) Gemini NDJSON parser, command builder, validator
├── commands/
│   ├── mod.rs            # (extend) pub mod gemini; pub use gemini::*;
│   ├── claude.rs         # (existing) spawn_claude_task, set/has/delete_claude_api_key, validate_claude_result
│   └── gemini.rs         # (NEW) spawn_gemini_task, set/has/delete_gemini_api_key, validate_gemini_result
├── credentials/
│   ├── mod.rs            # (extend) pub mod gemini_keychain;
│   ├── keychain.rs       # (existing) Claude keychain functions
│   └── gemini_keychain.rs # (NEW) Gemini keychain with "gemini-api-key" user
src/
├── lib/
│   ├── claude.ts         # (existing) Claude event types + formatter
│   └── gemini.ts         # (NEW) Gemini event types + formatter
├── hooks/
│   ├── useClaudeTask.ts  # (existing) Claude task hook
│   └── useGeminiTask.ts  # (NEW) Gemini task hook, mirrors useClaudeTask
├── components/
│   ├── settings/
│   │   ├── ApiKeySettings.tsx  # (extend) Add Gemini tab/section
```

### Pattern 1: Adapter Module Structure (Mirror Claude Exactly)
**What:** Each adapter has the same internal structure: event enum, command builder, stream parser, result validator, rate limit detector, retry policy.
**When to use:** For every new tool adapter.
**Example:**
```rust
// src-tauri/src/adapters/gemini.rs
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum GeminiStreamEvent {
    #[serde(rename = "init")]
    Init {
        session_id: Option<String>,
        model: Option<String>,
        timestamp: Option<String>,
    },

    #[serde(rename = "message")]
    Message {
        role: Option<String>,
        content: Option<String>,
        timestamp: Option<String>,
    },

    #[serde(rename = "tool_use")]
    ToolUse {
        tool_name: Option<String>,
        tool_id: Option<String>,
        parameters: Option<serde_json::Value>,
        timestamp: Option<String>,
    },

    #[serde(rename = "tool_result")]
    ToolResult {
        tool_id: Option<String>,
        status: Option<String>,
        output: Option<String>,
        timestamp: Option<String>,
    },

    #[serde(rename = "error")]
    Error {
        message: Option<String>,
        timestamp: Option<String>,
    },

    #[serde(rename = "result")]
    Result {
        status: Option<String>,
        response: Option<String>,
        stats: Option<GeminiStats>,
        timestamp: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
pub struct GeminiStats {
    pub total_tokens: Option<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub duration_ms: Option<u64>,
    pub tool_calls: Option<u32>,
}
```

### Pattern 2: Command Builder (Gemini-Specific Flags)
**What:** Build the CLI invocation with Gemini-specific flags.
**Example:**
```rust
pub struct GeminiCommand {
    pub cmd: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: String,
}

pub fn build_command(prompt: &str, cwd: &str, api_key: &str) -> GeminiCommand {
    GeminiCommand {
        cmd: "gemini".to_string(),
        args: vec![
            "-p".to_string(),
            prompt.to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--yolo".to_string(),  // Auto-approve tool calls in headless mode
        ],
        env: vec![
            ("GEMINI_API_KEY".to_string(), api_key.to_string()),
            ("NO_COLOR".to_string(), "1".to_string()),
        ],
        cwd: cwd.to_string(),
    }
}
```

### Pattern 3: IPC Command (Same Shape as Claude)
**What:** The spawn_gemini_task command follows the exact same flow as spawn_claude_task.
**Example:**
```rust
#[tauri::command]
#[specta::specta]
pub async fn spawn_gemini_task(
    prompt: String,
    project_dir: String,
    on_event: Channel<OutputEvent>,
    state: tauri::State<'_, AppState>,
    context_store: tauri::State<'_, ContextStore>,
) -> Result<String, String> {
    // 1. Clean stale worktrees (same as Claude)
    // 2. Retrieve GEMINI API key from keychain
    // 3. Build context preamble (same as Claude)
    // 4. Generate task_id
    // 5. Create worktree (same as Claude)
    // 6. Build Gemini command
    // 7. Spawn via process manager spawn_with_env
}
```

### Pattern 4: Frontend Hook (useGeminiTask mirrors useClaudeTask)
**What:** Same retry-loop + spawnOnce + validation pattern, different IPC commands and event formatter.
**Key differences from useClaudeTask:**
- Calls `commands.spawnGeminiTask` instead of `commands.spawnClaudeTask`
- Uses `formatGeminiEvent` instead of `formatClaudeEvent`
- Calls `commands.validateGeminiResult` instead of `commands.validateClaudeResult`
- Registers in process store with `gemini: {prompt}` label instead of `claude: {prompt}`

### Anti-Patterns to Avoid
- **Premature trait object abstraction:** Do NOT create a `Box<dyn ToolAdapter>` trait object yet. The two adapters have subtly different event schemas and validation logic. A premature abstraction will fight the differences. Phase 7 router will introduce the dispatch interface when needed.
- **Shared event enum:** Do NOT merge ClaudeStreamEvent and GeminiStreamEvent into one enum. They have different field names (Claude: `name`/`input`, Gemini: `tool_name`/`parameters`). Keep them separate.
- **Generic API key functions:** Do NOT try to make keychain functions generic. The service name is constant; just have separate functions with clear names: `get_gemini_api_key()`, `set_gemini_api_key()`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| NDJSON parsing | Custom line-by-line parser | `serde_json::from_str` on trimmed lines | Same pattern as Claude; serde handles all edge cases |
| Keychain access | Custom security framework | `keyring` crate with different user string | Battle-tested, already in project |
| Process spawning | New process manager | Existing `spawn_with_env` | Already handles pgid isolation, zombie cleanup, streaming |
| Exponential backoff | Custom retry math | Copy RetryPolicy from Claude adapter | Same pattern, potentially different defaults |
| Worktree lifecycle | Separate worktree code | Existing WorktreeManager | Adapter-agnostic by design |

**Key insight:** 95% of the infrastructure already exists from Phases 2-5. The Gemini adapter is primarily new parsing logic + new IPC commands + new frontend hook, all wired through existing infrastructure.

## Common Pitfalls

### Pitfall 1: Gemini CLI Not Installed / Wrong Version
**What goes wrong:** `gemini` binary not found or outdated version lacks `--output-format stream-json`.
**Why it happens:** Gemini CLI is npm-installed, not system-bundled. User may have v0.5.x (lacks JSON output) instead of v0.32.x.
**How to avoid:** Add version check on first spawn. Parse `gemini --version` output. Require >= 0.6.0 for JSON output support.
**Warning signs:** "Unknown arguments: output-format" error on stderr.

### Pitfall 2: NDJSON Field Name Differences from Claude
**What goes wrong:** Assuming Gemini events use the same field names as Claude (e.g., `name` vs `tool_name`, `input` vs `parameters`).
**Why it happens:** Both are NDJSON streams with similar event types but different schemas.
**How to avoid:** Use `Option<T>` for ALL fields in GeminiStreamEvent. Use separate types, not shared ones.
**Warning signs:** Deserialization silently returning None for expected fields.

### Pitfall 3: Gemini Rate Limit Messages Differ from Claude
**What goes wrong:** Rate limit detection misses Gemini-specific error strings.
**Why it happens:** Gemini uses "RESOURCE_EXHAUSTED" and "quota" while Claude uses "rate_limit" and "overloaded".
**How to avoid:** Detect: "429", "RESOURCE_EXHAUSTED", "quota", "Too Many Requests" in stderr.
**Warning signs:** Task keeps failing without triggering retry loop.

### Pitfall 4: Gemini Needs --yolo for Headless Tool Execution
**What goes wrong:** Gemini CLI prompts for tool approval in non-interactive mode, causing the subprocess to hang.
**Why it happens:** Without `--yolo`, Gemini requires interactive approval for each tool call (file write, shell exec).
**How to avoid:** Always pass `--yolo` flag in headless mode. The worktree isolation provides the safety boundary.
**Warning signs:** Process hangs indefinitely with no output after initial message.

### Pitfall 5: API Key Environment Variable Name
**What goes wrong:** Using wrong env var name for Gemini authentication.
**Why it happens:** Gemini accepts both `GEMINI_API_KEY` and `GOOGLE_API_KEY` but for different auth modes.
**How to avoid:** Use `GEMINI_API_KEY` for standard API key auth (matches free tier and paid plans).
**Warning signs:** "Authentication failed" or "No API key found" errors.

### Pitfall 6: Gemini Result Validation Differs from Claude
**What goes wrong:** Applying Claude validation logic (is_error, num_turns, status=="success") to Gemini output.
**Why it happens:** Gemini result event has different structure: `response` field (not `result`), `stats` object (not flat fields).
**How to avoid:** Write Gemini-specific validation: check `response` non-empty, check no `error` events, check `status` field in result.
**Warning signs:** False positive silent failure detection on valid Gemini responses.

### Pitfall 7: Exit Code Semantics
**What goes wrong:** Assuming exit code 0 means success and non-zero means failure across both tools.
**Why it happens:** Gemini has specific exit codes: 0 (success), 1 (general error), 42 (input error), 53 (turn limit exceeded).
**How to avoid:** Map Gemini exit codes to specific error messages. Exit code 53 is not a fatal error -- it means the task was too complex for the turn limit.
**Warning signs:** Legitimate "turn limit exceeded" results shown as crashes.

## Code Examples

### Gemini Rate Limit Detection
```rust
// Source: Derived from GitHub issues analysis of Gemini CLI rate limit behavior
pub fn detect_rate_limit(line: &str) -> Option<RateLimitInfo> {
    let lower = line.to_lowercase();
    if lower.contains("429")
        || lower.contains("resource_exhausted")
        || lower.contains("quota")
        || lower.contains("too many requests")
        || lower.contains("rate limit")
    {
        Some(RateLimitInfo {
            retry_after_secs: None,
        })
    } else {
        None
    }
}
```

### Gemini Result Validation
```rust
pub fn validate_result(event: &GeminiStreamEvent) -> Result<(), String> {
    match event {
        GeminiStreamEvent::Result {
            status,
            response,
            ..
        } => {
            if response.as_ref().map_or(true, |r| r.trim().is_empty()) {
                return Err("Gemini returned empty response (silent failure)".to_string());
            }
            if status.as_deref() == Some("error") {
                return Err("Gemini reported an error".to_string());
            }
            Ok(())
        }
        GeminiStreamEvent::Error { message, .. } => {
            Err(format!("Gemini error: {}", message.as_deref().unwrap_or("unknown")))
        }
        _ => Err("No result event received from Gemini".to_string()),
    }
}
```

### Gemini Frontend Event Formatter
```typescript
// Source: Derived from Gemini CLI stream-json documentation
export function formatGeminiEvent(line: string): string {
  const event = parseGeminiEvent(line);
  if (!event) return line;

  switch (event.type) {
    case 'init':
      return `[Session started] model=${event.model ?? 'unknown'}`;
    case 'message':
      return event.content ?? '';
    case 'tool_use':
      return `[Tool: ${event.tool_name}] ${JSON.stringify(event.parameters)}`;
    case 'tool_result':
      return `[Result] ${event.output ?? ''}`;
    case 'error':
      return `[Error] ${event.message ?? 'Unknown error'}`;
    case 'result': {
      const stats = event.stats;
      return `[Done] tokens=${stats?.total_tokens ?? '?'}, duration=${stats?.duration_ms ?? '?'}ms`;
    }
    default:
      return line;
  }
}
```

### Keychain Functions for Gemini
```rust
// Source: Direct mirror of existing credentials/keychain.rs
const GEMINI_API_KEY_USER: &str = "gemini-api-key";

pub fn get_gemini_api_key() -> Result<String, String> {
    let entry = Entry::new(SERVICE_NAME, GEMINI_API_KEY_USER)
        .map_err(|e| format!("Failed to create keychain entry: {}", e))?;
    entry.get_password()
        .map_err(|e| format!("Failed to retrieve Gemini API key: {}", e))
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `--output-format json` unavailable in stable | Available since v0.6.0+ (PR #10883) | Oct 2025 | JSON and stream-json now work in stable releases |
| No stream-json support | `--output-format stream-json` merged | Oct 2025 | Real-time NDJSON streaming matches Claude Code pattern |
| Gemini CLI v0.5.x (stable) | v0.32.x (current stable, March 2026) | Ongoing weekly releases | Rapid iteration, pin minimum version |

**Deprecated/outdated:**
- Gemini CLI v0.5.x: Lacks `--output-format` flag entirely. Minimum v0.6.0 required, v0.30+ recommended.
- `GOOGLE_API_KEY` for standard auth: Use `GEMINI_API_KEY` instead (clearer intent, works with free tier).

## Open Questions

1. **Exact stream-json event schema fields**
   - What we know: Event types match (init, message, tool_use, tool_result, result). Field names differ from Claude (tool_name vs name, parameters vs input).
   - What's unclear: The exact JSON schema for each event type is not fully documented. The field names above come from documentation references and may have additional fields.
   - Recommendation: Use `Option<T>` for ALL fields (matching Claude adapter resilience pattern). Parse a real Gemini CLI stream-json output during development to verify field names. Use `#[serde(flatten)] pub extra: HashMap<String, serde_json::Value>` as a fallback capture.

2. **Gemini CLI built-in retry behavior**
   - What we know: `general.maxAttempts` setting (default 10, max 10) controls CLI's own retry logic.
   - What's unclear: Whether the CLI's built-in retry conflicts with WhaleCode's retry loop.
   - Recommendation: Set `general.maxAttempts` to 1 (or rely on CLI default) and let WhaleCode's retry loop handle rate limits, matching Claude adapter behavior. This gives the user consistent UX across both tools.

3. **Gemini API key format validation**
   - What we know: Claude keys start with `sk-ant-`. Gemini API keys have no well-known prefix.
   - What's unclear: Whether there is a consistent prefix or format for Gemini API keys.
   - Recommendation: Validate non-empty and reasonable length (>10 chars) only. Do NOT enforce a prefix pattern.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Rust: `cargo test`, Frontend: vitest |
| Config file | vitest via package.json `"test": "vitest"` |
| Quick run command | `cd src-tauri && cargo test adapters::gemini` |
| Full suite command | `cd src-tauri && cargo test && cd .. && npm test` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PROC-02 | Gemini CLI spawns in headless mode | integration | Manual verification (requires Gemini CLI + API key) | N/A - manual |
| INTG-02 | Gemini NDJSON parsing | unit | `cd src-tauri && cargo test adapters::gemini` | Wave 0 |
| INTG-03 | Output validation catches silent failures | unit | `cd src-tauri && cargo test adapters::gemini::tests::test_validate` | Wave 0 |
| INTG-03 | Frontend event formatting | unit | `npm test -- --run src/tests/gemini.test.ts` | Wave 0 |
| INTG-04 | Rate limit detection | unit | `cd src-tauri && cargo test adapters::gemini::tests::test_detect_rate_limit` | Wave 0 |
| INTG-04 | Retry policy delays | unit | `cd src-tauri && cargo test adapters::gemini::tests::test_retry_policy` | Wave 0 |

### Sampling Rate
- **Per task commit:** `cd src-tauri && cargo test adapters::gemini`
- **Per wave merge:** `cd src-tauri && cargo test && cd .. && npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src-tauri/src/adapters/gemini.rs` -- Gemini adapter with event parsing, validation, rate limit detection, and unit tests (mirrors claude.rs test structure)
- [ ] `src/tests/gemini.test.ts` -- Frontend Gemini event formatting tests (mirrors claude.test.ts)
- [ ] `src/lib/gemini.ts` -- Frontend Gemini event types and formatter

## Sources

### Primary (HIGH confidence)
- [Gemini CLI headless docs](https://geminicli.com/docs/cli/headless/) -- headless mode, output formats, exit codes
- [Gemini CLI configuration](https://geminicli.com/docs/reference/configuration/) -- env vars, settings.json, maxAttempts, auth
- [Gemini CLI npm](https://www.npmjs.com/package/@google/gemini-cli) -- current version 0.32.x
- Existing codebase: `src-tauri/src/adapters/claude.rs`, `src-tauri/src/commands/claude.rs` -- adapter pattern blueprint

### Secondary (MEDIUM confidence)
- [Gemini CLI stream-json PR #10883](https://github.com/google-gemini/gemini-cli/issues/8203) -- stream-json feature implemented, merged Oct 2025
- [Phil Schmid cheatsheet](https://www.philschmid.de/gemini-cli-cheatsheet) -- flags reference (-p, --yolo, --sandbox, --model)
- [GitHub rate limit issues](https://github.com/google-gemini/gemini-cli/issues/9248) -- 429 RESOURCE_EXHAUSTED behavior, retry logic

### Tertiary (LOW confidence)
- Stream-json event schema field names -- derived from documentation snippets and issue descriptions, not from parsing actual CLI output. Field names (tool_name, parameters, etc.) need runtime verification.
- [Gemini CLI JSON support issue #9009](https://github.com/google-gemini/gemini-cli/issues/9009) -- historical; JSON was broken in v0.5.4 but fixed in later versions

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- Gemini CLI is well-established, npm-distributed, actively maintained
- Architecture: HIGH -- Direct mirror of proven Claude adapter pattern in existing codebase
- Event schema details: MEDIUM -- Event types confirmed, exact field names need runtime verification
- Rate limit handling: MEDIUM -- Error patterns identified from GitHub issues, not from official spec
- Pitfalls: MEDIUM -- Derived from community reports and documentation gaps

**Research date:** 2026-03-06
**Valid until:** 2026-03-20 (Gemini CLI releases weekly; pin minimum version)
