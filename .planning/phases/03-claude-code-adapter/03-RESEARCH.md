# Phase 3: Claude Code Adapter - Research

**Researched:** 2026-03-05
**Domain:** Claude Code CLI integration, NDJSON streaming, macOS keychain credential storage
**Confidence:** HIGH

## Summary

Phase 3 connects WhaleCode to Claude Code by spawning it as a subprocess in headless mode (`-p`) with `--output-format stream-json`, parsing NDJSON streaming output line-by-line, detecting silent failures (zero-token or empty responses), handling API rate limits with backoff and user notification, and storing the API key securely in the macOS Keychain.

The existing Phase 2 infrastructure provides a generic process manager (`process::manager::spawn`) that already handles subprocess spawning, pgid isolation, stdout/stderr streaming via `Channel<OutputEvent>`, and process lifecycle management. Phase 3 builds a Claude Code-specific adapter on top of this foundation. The adapter must parse the structured NDJSON output (which includes `init`, `message`, `tool_use`, `tool_result`, and `result` event types), validate that responses contain actual content (not silent failures), and manage the `ANTHROPIC_API_KEY` securely.

**Primary recommendation:** Build a `ClaudeAdapter` Rust module that wraps the existing `process::manager::spawn` with Claude Code-specific argument construction, NDJSON line parsing, result validation, and rate-limit detection. Use the `keyring` crate directly (not a Tauri plugin) for macOS Keychain storage of the API key.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PROC-01 | User can spawn a Claude Code subprocess in headless mode and see streaming output in real-time | Claude Code CLI `-p --output-format stream-json --verbose` flags; existing `process::manager::spawn` for subprocess lifecycle; NDJSON parsing for structured output rendering |
| INTG-01 | Claude Code adapter uses CLI subprocess with `--output-format stream-json` | Stream-json format documented; NDJSON event types (init, message, tool_use, tool_result, result) identified; line-by-line parsing via `serde_json::from_str` on each stdout line |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| keyring | 3.6.3 | macOS Keychain credential storage | De facto Rust crate for OS-native credential stores; uses Security.framework on macOS |
| serde_json | 1.x | NDJSON line parsing | Already in Cargo.toml; parse each stream-json line into typed structs |
| tokio | 1.x | Async I/O, timers for backoff | Already in Cargo.toml; provides `tokio::time::sleep` for retry delays |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| serde | 1.x | Derive Serialize/Deserialize for stream event types | Already in Cargo.toml |
| uuid | 1.x | Task ID generation | Already in Cargo.toml |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| keyring crate directly | tauri-plugin-keyring (0.1.0) | Plugin is v0.1.0, single release, thin wrapper; keyring crate is mature (v3.6.3), no plugin overhead |
| keyring crate | tauri-plugin-stronghold | Stronghold is IOTA's custom vault, not OS-native keychain; requirement says "OS keychain" |

**Installation:**
```bash
# In src-tauri/
cargo add keyring --features apple-native
```

No new npm packages needed on the frontend.

## Architecture Patterns

### Recommended Project Structure
```
src-tauri/src/
├── adapters/
│   ├── mod.rs              # Adapter trait + module exports
│   └── claude.rs           # Claude Code adapter implementation
├── credentials/
│   ├── mod.rs              # Credential manager trait
│   └── keychain.rs         # macOS Keychain via keyring crate
├── commands/
│   ├── mod.rs
│   ├── process.rs          # (existing) generic process commands
│   └── claude.rs           # Claude-specific IPC commands
├── process/                # (existing) generic process manager
├── ipc/
│   └── events.rs           # (extend) add Claude-specific event variants
└── state.rs                # (extend) add credential state
```

### Pattern 1: Claude Code Adapter
**What:** A Rust module that constructs the Claude Code CLI command, spawns it through the existing process manager, and post-processes NDJSON output.
**When to use:** Every time a user submits a task to Claude Code.
**Example:**
```rust
// Source: Claude Code CLI docs (https://code.claude.com/docs/en/headless)
pub struct ClaudeAdapter;

impl ClaudeAdapter {
    pub fn build_command(prompt: &str, cwd: &str, api_key: &str) -> ClaudeCommand {
        ClaudeCommand {
            cmd: "claude".to_string(),
            args: vec![
                "-p".to_string(),
                prompt.to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--verbose".to_string(),
                "--allowedTools".to_string(),
                "Bash,Read,Edit,Write,Glob,Grep".to_string(),
            ],
            env: vec![
                ("ANTHROPIC_API_KEY".to_string(), api_key.to_string()),
                ("NO_COLOR".to_string(), "1".to_string()),
            ],
            cwd: cwd.to_string(),
        }
    }
}
```

### Pattern 2: NDJSON Line Parser
**What:** Parse each stdout line as a discrete JSON event, dispatch typed events to the frontend.
**When to use:** In the stdout reading loop, replacing raw line forwarding with parsed events.
**Example:**
```rust
// Source: stream-json format (https://code.claude.com/docs/en/headless)
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ClaudeStreamEvent {
    #[serde(rename = "init")]
    Init { session_id: Option<String> },

    #[serde(rename = "message")]
    Message {
        role: Option<String>,
        content: Option<Vec<ContentBlock>>,
    },

    #[serde(rename = "tool_use")]
    ToolUse {
        name: Option<String>,
        input: Option<serde_json::Value>,
    },

    #[serde(rename = "tool_result")]
    ToolResult {
        output: Option<String>,
    },

    #[serde(rename = "result")]
    Result {
        status: Option<String>,
        duration_ms: Option<u64>,
        result: Option<String>,
        // For stream events with --verbose --include-partial-messages
        subtype: Option<String>,
        is_error: Option<bool>,
        total_cost_usd: Option<f64>,
        num_turns: Option<u32>,
        session_id: Option<String>,
    },

    // When --verbose --include-partial-messages is used, raw API events appear
    #[serde(rename = "stream_event")]
    StreamEvent {
        event: Option<serde_json::Value>,
    },
}

#[derive(Debug, Deserialize)]
pub struct ContentBlock {
    #[serde(rename = "type")]
    pub block_type: String,
    pub text: Option<String>,
    pub name: Option<String>,
    pub input: Option<serde_json::Value>,
}
```

### Pattern 3: Silent Failure Detection
**What:** After Claude Code exits with code 0, validate the result event for actual content.
**When to use:** In the waiter task, after process exit.
**Example:**
```rust
// Source: STATE.md blocker note on ~8% silent failure rate
pub fn validate_claude_result(result_event: &ClaudeStreamEvent) -> Result<(), String> {
    match result_event {
        ClaudeStreamEvent::Result {
            status, result, is_error, num_turns, ..
        } => {
            // Check for explicit error
            if *is_error == Some(true) {
                return Err("Claude Code reported an error".to_string());
            }
            // Check for empty/missing result
            if result.as_ref().map_or(true, |r| r.trim().is_empty()) {
                return Err("Claude Code returned empty result (silent failure)".to_string());
            }
            // Check for zero turns (nothing happened)
            if *num_turns == Some(0) {
                return Err("Claude Code completed zero turns (silent failure)".to_string());
            }
            // Check status
            if status.as_deref() != Some("success") {
                return Err(format!("Claude Code status: {:?}", status));
            }
            Ok(())
        }
        _ => Err("No result event received from Claude Code".to_string()),
    }
}
```

### Pattern 4: Rate Limit Detection and Retry
**What:** Detect rate-limit/overloaded errors in stderr or NDJSON events, notify user, and retry with exponential backoff.
**When to use:** When Claude Code outputs rate limit errors during execution.
**Example:**
```rust
pub fn detect_rate_limit(line: &str) -> Option<RateLimitInfo> {
    // Claude Code outputs rate limit errors to stderr or as error events
    if line.contains("rate_limit") || line.contains("Rate limit")
        || line.contains("overloaded") || line.contains("529")
        || line.contains("429") {
        Some(RateLimitInfo {
            retry_after_secs: None, // Parse retry-after if available
        })
    } else {
        None
    }
}

pub struct RetryPolicy {
    pub max_retries: u32,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
}

impl RetryPolicy {
    pub fn default_claude() -> Self {
        Self {
            max_retries: 3,
            base_delay_ms: 5_000,  // 5 seconds
            max_delay_ms: 60_000,  // 1 minute
        }
    }

    pub fn delay_for_attempt(&self, attempt: u32) -> u64 {
        let delay = self.base_delay_ms * 2u64.pow(attempt);
        delay.min(self.max_delay_ms)
    }
}
```

### Pattern 5: Keychain Credential Storage
**What:** Store/retrieve ANTHROPIC_API_KEY from macOS Keychain using the `keyring` crate.
**When to use:** On app startup (retrieve) and settings (store/update).
**Example:**
```rust
// Source: keyring crate docs (https://docs.rs/keyring/3.6.3)
use keyring::Entry;

const SERVICE_NAME: &str = "com.whalecode.app";
const CLAUDE_API_KEY_USER: &str = "anthropic-api-key";

pub fn get_api_key() -> Result<String, String> {
    let entry = Entry::new(SERVICE_NAME, CLAUDE_API_KEY_USER)
        .map_err(|e| format!("Keychain error: {}", e))?;
    entry.get_password()
        .map_err(|e| format!("API key not found in keychain: {}", e))
}

pub fn set_api_key(key: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, CLAUDE_API_KEY_USER)
        .map_err(|e| format!("Keychain error: {}", e))?;
    entry.set_password(key)
        .map_err(|e| format!("Failed to store API key: {}", e))
}

pub fn delete_api_key() -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, CLAUDE_API_KEY_USER)
        .map_err(|e| format!("Keychain error: {}", e))?;
    entry.delete_credential()
        .map_err(|e| format!("Failed to delete API key: {}", e))
}
```

### Anti-Patterns to Avoid
- **Storing API key in config files or localStorage:** Violates security requirement; must use OS keychain
- **Trusting exit code 0 alone:** Claude Code has ~8% silent failure rate in headless mode; always validate the `result` event
- **Parsing entire NDJSON stream as one JSON blob:** Each line is independent; parse line-by-line with `serde_json::from_str`
- **Building a custom process spawner for Claude:** Reuse `process::manager::spawn`; only add NDJSON parsing on top
- **Blocking on keychain access in async context:** `keyring` operations are synchronous; use `tokio::task::spawn_blocking` for keychain calls

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Credential storage | Custom encryption + file storage | `keyring` crate with `apple-native` feature | macOS Keychain handles encryption, ACLs, Secure Enclave; rolling your own is a security risk |
| Retry with backoff | Custom sleep loop | Structured `RetryPolicy` with exponential backoff + jitter | Naive retries cause rate-limit cascades (known Claude Code issue #583) |
| NDJSON parsing | Custom string splitting | `serde_json::from_str` per line into typed enum | Handles all edge cases (escaped newlines, Unicode, nested objects) |

**Key insight:** The main complexity in this phase is NOT subprocess management (Phase 2 solved that), but the Claude Code-specific protocol: NDJSON event types, silent failure detection, rate limit handling, and secure credential flow.

## Common Pitfalls

### Pitfall 1: Silent Failures (Exit Code 0 but No Output)
**What goes wrong:** Claude Code exits with code 0 but produces no meaningful output (~8% of headless runs per STATE.md).
**Why it happens:** API timeouts, empty context windows, malformed prompts, or transient backend issues can cause Claude to return nothing.
**How to avoid:** Validate every run: check `result` event exists, `status == "success"`, `result` text is non-empty, `num_turns > 0`.
**Warning signs:** Exit event with code 0 but no preceding `message` events, or `result` event with empty `result` field.

### Pitfall 2: Rate Limit Cascading
**What goes wrong:** When rate-limited, Claude Code's internal retry fires multiple immediate retries without backoff, generating 14+ additional 429 errors.
**Why it happens:** Claude Code's built-in retry logic is aggressive (known issue).
**How to avoid:** Detect rate-limit errors in stderr, kill the current process, and retry from WhaleCode with proper exponential backoff (5s, 10s, 20s, cap at 60s). Do NOT let Claude Code handle its own retries for rate limits.
**Warning signs:** Multiple `429` or `overloaded` messages in stderr within seconds.

### Pitfall 3: API Key Leaking to Logs
**What goes wrong:** `ANTHROPIC_API_KEY` appears in process output, debug logs, or error messages.
**Why it happens:** The key is passed as an environment variable to the subprocess; careless logging exposes it.
**How to avoid:** Never log the full API key. When logging commands, redact env vars. Filter stderr for key patterns before forwarding to frontend.
**Warning signs:** String starting with `sk-ant-` appearing in output console.

### Pitfall 4: Keychain Access Blocking Async Runtime
**What goes wrong:** `keyring` crate calls are synchronous; calling them from async context blocks the tokio runtime.
**Why it happens:** `keyring` uses `security-framework` which makes synchronous FFI calls to macOS Security.framework.
**How to avoid:** Wrap all keychain calls in `tokio::task::spawn_blocking`.
**Warning signs:** UI freezing briefly when accessing credentials.

### Pitfall 5: NDJSON Parse Failures on Non-JSON Lines
**What goes wrong:** Claude Code sometimes emits non-JSON lines to stdout (startup messages, warnings).
**Why it happens:** Not all stdout output is NDJSON; some is plain text from the CLI bootstrap.
**How to avoid:** Wrap `serde_json::from_str` in a Result; if parsing fails, treat the line as raw text and forward as `OutputEvent::Stdout`.
**Warning signs:** `serde_json` deserialization errors in the output.

### Pitfall 6: Claude CLI Not Found
**What goes wrong:** `claude` binary not in PATH when spawned from a Tauri app bundle.
**Why it happens:** macOS app bundles have a minimal PATH; npm global installs may not be in it.
**How to avoid:** Check common install locations (`/usr/local/bin/claude`, `~/.npm/bin/claude`, `$(which claude)`). Provide a settings field for custom Claude binary path. Fall back to shell-based PATH resolution.
**Warning signs:** "Failed to spawn process: No such file or directory" error.

## Code Examples

### Extending the Process Manager for Claude

```rust
// In src-tauri/src/adapters/claude.rs
// Source: existing process::manager::spawn pattern

use crate::credentials::keychain;
use crate::ipc::events::OutputEvent;
use crate::process;
use crate::state::AppState;
use tauri::ipc::Channel;

pub async fn spawn_claude_task(
    prompt: &str,
    project_dir: &str,
    channel: Channel<OutputEvent>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    // Retrieve API key from keychain (blocking call)
    let api_key = tokio::task::spawn_blocking(|| {
        keychain::get_api_key()
    }).await.map_err(|e| e.to_string())??;

    // Build Claude-specific command
    let args = vec![
        "-p".to_string(),
        prompt.to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
    ];

    // Spawn through existing process manager
    // NOTE: process::manager::spawn needs to be extended to accept env vars
    process::manager::spawn_with_env(
        "claude",
        &args,
        project_dir,
        &[("ANTHROPIC_API_KEY", &api_key)],
        channel,
        state,
    ).await
}
```

### Frontend: Rendering NDJSON Events

```typescript
// Source: existing useProcess.ts pattern + Claude stream-json format

interface ClaudeStreamEvent {
  type: 'init' | 'message' | 'tool_use' | 'tool_result' | 'result' | 'stream_event';
  session_id?: string;
  role?: string;
  content?: Array<{ type: string; text?: string; name?: string }>;
  name?: string;
  input?: unknown;
  output?: string;
  status?: string;
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
}

function parseClaudeEvent(line: string): ClaudeStreamEvent | null {
  try {
    return JSON.parse(line) as ClaudeStreamEvent;
  } catch {
    return null; // Non-JSON line, treat as raw text
  }
}
```

### IPC Command for Claude Task

```rust
// In src-tauri/src/commands/claude.rs

#[tauri::command]
#[specta::specta]
pub async fn spawn_claude_task(
    prompt: String,
    project_dir: String,
    on_event: Channel<OutputEvent>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    crate::adapters::claude::spawn_claude_task(
        &prompt,
        &project_dir,
        on_event,
        state,
    ).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_claude_api_key(key: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        crate::credentials::keychain::set_api_key(&key)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn has_claude_api_key() -> Result<bool, String> {
    tokio::task::spawn_blocking(|| {
        crate::credentials::keychain::get_api_key().is_ok()
    }).await.map_err(|e| e.to_string())
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `claude -p` only with text output | `--output-format stream-json` with NDJSON streaming | 2025 | Enables structured real-time parsing, not just raw text |
| Custom process management | Reuse Phase 2 `process::manager` | Phase 2 (just completed) | No need to rebuild subprocess lifecycle |
| Store keys in config files | OS Keychain via `keyring` crate | Best practice | Keys never touch disk in plaintext |
| Trust exit codes | Validate `result` event content | Requirement (INTG-03 pattern) | Catches ~8% silent failure rate |

**Deprecated/outdated:**
- `--output-format json` (non-streaming): Returns single JSON blob after completion; no real-time feedback
- `tauri-plugin-stronghold`: Uses IOTA's custom vault, not OS-native keychain; doesn't meet "OS keychain" requirement

## Open Questions

1. **Exact NDJSON schema when `--include-partial-messages` is used**
   - What we know: With `--verbose --include-partial-messages`, Claude Code emits `stream_event` type lines wrapping raw API events (content_block_delta, message_start, etc.)
   - What's unclear: Whether to use `--include-partial-messages` for token-by-token streaming or rely on higher-level `message` events for simpler parsing
   - Recommendation: Start WITHOUT `--include-partial-messages`; use `--verbose` only. The `message`, `tool_use`, `tool_result`, and `result` events are sufficient for the output log. Add partial messages later if users want character-by-character streaming.

2. **Claude CLI binary path on macOS**
   - What we know: Typically installed via `npm install -g @anthropic-ai/claude-code` to `~/.npm-global/bin/claude` or `/usr/local/bin/claude`
   - What's unclear: Exact PATH available inside Tauri app bundle context
   - Recommendation: At spawn time, resolve path with a shell (`/bin/sh -c "which claude"`) and cache it. Provide a settings override for custom path.

3. **Rate limit retry: WhaleCode vs Claude Code internal**
   - What we know: Claude Code has its own retry logic for rate limits, but it's known to be buggy (cascading retries)
   - What's unclear: Whether Claude Code's internal retry is fixed in latest versions
   - Recommendation: Detect rate-limit errors in stderr. If detected, cancel the process and retry from WhaleCode with exponential backoff. This is safer than relying on Claude Code's internal retry.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (frontend), cargo test (Rust) |
| Config file | `vitest.config.ts` (frontend), `Cargo.toml` (Rust) |
| Quick run command | `cd src-tauri && cargo test` / `npm run test` |
| Full suite command | `cd src-tauri && cargo test && cd .. && npm run test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PROC-01 | Claude Code spawns in headless mode with streaming output | integration | `cd src-tauri && cargo test adapters::claude::tests -x` | No - Wave 0 |
| INTG-01 | stream-json NDJSON output parsed correctly | unit | `cd src-tauri && cargo test adapters::claude::tests::parse_ -x` | No - Wave 0 |
| INTG-01 | Silent failure detected (empty result) | unit | `cd src-tauri && cargo test adapters::claude::tests::silent_failure -x` | No - Wave 0 |
| INTG-01 | Rate limit detected in stderr | unit | `cd src-tauri && cargo test adapters::claude::tests::rate_limit -x` | No - Wave 0 |
| N/A | API key stored/retrieved from keychain | unit | `cd src-tauri && cargo test credentials::keychain::tests -x` | No - Wave 0 |

### Sampling Rate
- **Per task commit:** `cd src-tauri && cargo test`
- **Per wave merge:** `cd src-tauri && cargo test && cd .. && npm run test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src-tauri/src/adapters/claude.rs` -- NDJSON parsing unit tests (covers INTG-01)
- [ ] `src-tauri/src/credentials/keychain.rs` -- keychain storage tests (covers API key requirement)
- [ ] `src/tests/claude.test.ts` -- frontend Claude event parsing tests

## Sources

### Primary (HIGH confidence)
- [Claude Code CLI headless docs](https://code.claude.com/docs/en/headless) - `-p` flag, `--output-format stream-json`, `--verbose`, `--include-partial-messages` usage
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) - All CLI flags including `--max-turns`, `--max-budget-usd`, `--allowedTools`, `--fallback-model`
- [Agent SDK streaming docs](https://platform.claude.com/docs/en/agent-sdk/streaming-output) - StreamEvent types (message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop), message flow
- [keyring crate docs](https://docs.rs/keyring/3.6.3) - v3.6.3, `apple-native` feature for macOS Keychain, Entry API

### Secondary (MEDIUM confidence)
- [Claude Code rate limit issue #583](https://github.com/anthropics/claude-code/issues/583) - Overloaded retry behavior, cascading 429 errors
- [tauri-plugin-keyring](https://github.com/HuakunShen/tauri-plugin-keyring) - v0.1.0, thin wrapper over keyring crate (decided against in favor of direct keyring usage)
- [Stream-JSON Chaining wiki](https://github.com/ruvnet/ruflo/wiki/Stream-Chaining) - NDJSON event types and structure examples

### Tertiary (LOW confidence)
- Stream-json exact field names for each event type: verified via multiple sources but no single authoritative schema document exists. The typed enum in Code Examples section is best-effort and should be validated against actual CLI output during implementation.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - keyring crate is well-documented, serde_json is already in use
- Architecture: HIGH - builds directly on existing Phase 2 process manager, patterns are straightforward
- NDJSON format: MEDIUM - event types confirmed by multiple sources, but exact field names may vary; deserialize flexibly with `Option<>` fields
- Pitfalls: HIGH - rate limit issues and silent failures are well-documented in GitHub issues and STATE.md

**Research date:** 2026-03-05
**Valid until:** 2026-04-05 (stable domain, Claude Code CLI format unlikely to break)
