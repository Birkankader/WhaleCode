# Phase 8: Prompt Engine - Research

**Researched:** 2026-03-06
**Domain:** Prompt optimization, tool-specific conventions, context injection
**Confidence:** HIGH

## Summary

Phase 8 adds a prompt engine that transforms a single user-written prompt into tool-specific optimized versions for Claude Code and Gemini CLI. The current codebase already has context injection (`build_context_preamble` in `context/injection.rs`) that prepends recent project history to prompts, but it applies the **same format to both tools**. The prompt engine must introduce tool-specific formatting conventions and a preview mechanism.

The architecture is straightforward: a new `prompt` module in Rust provides `optimize_prompt()` which takes a raw prompt, tool name, and context data, then applies tool-specific templates. The frontend adds a preview panel so users can inspect the optimized prompt before sending. The existing `dispatch_task` flow in `commands/router.rs` is modified to call the prompt engine before building the tool command.

**Primary recommendation:** Build the prompt engine as a pure Rust module with tool-specific template functions, expose an IPC command for frontend preview, and modify `dispatch_task` to use optimized prompts instead of raw prompts with generic context preamble.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PMPT-01 | User writes a single prompt for a task | Already partially supported -- `ProcessPanel` has task input. Engine must accept this single prompt as input |
| PMPT-02 | App automatically optimizes the prompt for each target tool's conventions and strengths | New `PromptEngine` module with tool-specific templates; Claude gets planning preamble, Gemini gets large-context structure |
| PMPT-03 | User can preview the optimized prompt before sending | New IPC command `optimize_prompt` returns optimized text; frontend `PromptPreview` component displays it |
| PMPT-04 | Prompt optimization includes relevant project context and recent change history | Existing `build_context_preamble` provides context data; engine restructures it per tool conventions |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Rust (existing) | edition 2021 | Prompt engine module | All backend logic is Rust; maintains consistency |
| rusqlite | 0.38 | Context data retrieval | Already used for ContextStore; prompt engine queries same DB |
| tauri-specta | 2.0.0-rc.21 | IPC type generation | Already used for all commands; preview command needs type-safe IPC |
| React + Zustand | 19.1 / 5.0 | Preview UI state | Already used for all frontend state management |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none needed) | - | - | No new dependencies required |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Rust-side templates | Frontend-side templates | Rust is better: keeps prompt logic server-side, testable with unit tests, no round-trip needed for dispatch |
| Handlebars/Tera templates | String formatting | Templates add dependency for simple string assembly; `format!()` is sufficient for v1 |
| LLM-based optimization | Rule-based templates | LLM adds latency, cost, unpredictability; rule-based is deterministic and fast |

**Installation:**
```bash
# No new packages needed -- all dependencies already in Cargo.toml and package.json
```

## Architecture Patterns

### Recommended Project Structure
```
src-tauri/src/
  prompt/
    mod.rs           # PromptEngine struct + optimize() entry point
    templates.rs     # Tool-specific template functions
    models.rs        # OptimizedPrompt, PromptContext types (specta-exported)
  commands/
    prompt.rs        # optimize_prompt IPC command (new)
    router.rs        # Modified to call prompt engine before dispatch

src/
  components/
    prompt/
      PromptPreview.tsx  # Side-by-side optimized prompt preview panel
  hooks/
    useTaskDispatch.ts   # Modified to include preview step
```

### Pattern 1: PromptEngine as Pure Function Module
**What:** A stateless module with pure functions that take (prompt, tool_name, context_data) and return optimized prompt strings. No struct state needed.
**When to use:** Always -- this is the core pattern.
**Example:**
```rust
// src-tauri/src/prompt/mod.rs
pub mod models;
pub mod templates;

use models::{OptimizedPrompt, PromptContext};

pub struct PromptEngine;

impl PromptEngine {
    /// Optimize a user prompt for a specific tool, injecting relevant context.
    pub fn optimize(
        raw_prompt: &str,
        tool_name: &str,
        context: &PromptContext,
    ) -> OptimizedPrompt {
        let optimized_text = match tool_name {
            "claude" => templates::claude_template(raw_prompt, context),
            "gemini" => templates::gemini_template(raw_prompt, context),
            _ => templates::default_template(raw_prompt, context),
        };

        OptimizedPrompt {
            tool_name: tool_name.to_string(),
            original_prompt: raw_prompt.to_string(),
            optimized_prompt: optimized_text,
        }
    }

    /// Optimize for all available tools at once (for preview).
    pub fn optimize_all(
        raw_prompt: &str,
        context: &PromptContext,
    ) -> Vec<OptimizedPrompt> {
        vec![
            Self::optimize(raw_prompt, "claude", context),
            Self::optimize(raw_prompt, "gemini", context),
        ]
    }
}
```

### Pattern 2: Tool-Specific Templates
**What:** Separate template functions per tool that structure prompts according to each tool's conventions.
**When to use:** For each supported tool.
**Example:**
```rust
// src-tauri/src/prompt/templates.rs
use super::models::PromptContext;

/// Claude Code template: planning preamble, structured context, explicit task.
/// Claude benefits from: role framing, step-by-step instructions, explicit
/// file references, planning before action.
pub fn claude_template(prompt: &str, context: &PromptContext) -> String {
    let mut sections = Vec::new();

    // Planning preamble -- Claude responds well to structured approach
    sections.push("## Task Plan\n\nBefore making changes, analyze the codebase and plan your approach.".to_string());

    // Context section (if any)
    if !context.recent_events.is_empty() {
        sections.push(format_context_for_claude(context));
    }

    // User task
    sections.push(format!("## Task\n\n{}", prompt));

    sections.join("\n\n---\n\n")
}

/// Gemini CLI template: large-context optimized, flat structure, explicit scope.
/// Gemini benefits from: all context upfront, clear boundaries, direct instruction.
pub fn gemini_template(prompt: &str, context: &PromptContext) -> String {
    let mut sections = Vec::new();

    // Context first -- Gemini handles large context windows well
    if !context.recent_events.is_empty() {
        sections.push(format_context_for_gemini(context));
    }

    // Direct task instruction
    sections.push(format!("Task: {}", prompt));

    sections.join("\n\n")
}
```

### Pattern 3: Preview via IPC Command
**What:** An IPC command that returns optimized prompts for all tools without dispatching, enabling frontend preview.
**When to use:** When user wants to inspect prompts before sending.
**Example:**
```rust
// src-tauri/src/commands/prompt.rs
#[tauri::command]
#[specta::specta]
pub async fn optimize_prompt(
    prompt: String,
    project_dir: String,
    context_store: tauri::State<'_, ContextStore>,
) -> Result<Vec<OptimizedPrompt>, String> {
    // Fetch context
    let context = build_prompt_context(&context_store, &project_dir).await?;
    // Generate optimized versions for all tools
    Ok(PromptEngine::optimize_all(&prompt, &context))
}
```

### Pattern 4: Integrating with Existing Dispatch Flow
**What:** Modify `dispatch_task` to use the prompt engine instead of raw `build_context_preamble`.
**When to use:** This replaces the current generic context injection.
**Example:**
```rust
// In commands/router.rs dispatch_task():
// BEFORE (current):
//   let full_prompt = format!("{}\n\n---\nUser task:\n{}", context_preamble, prompt);
//   adapter.build_command(&full_prompt, &cwd, &api_key)

// AFTER (with prompt engine):
//   let context = build_prompt_context(&context_store, &project_dir).await?;
//   let optimized = PromptEngine::optimize(&prompt, &tool_name, &context);
//   adapter.build_command(&optimized.optimized_prompt, &cwd, &api_key)
```

### Anti-Patterns to Avoid
- **LLM-powered prompt optimization:** Adding an LLM call to optimize prompts adds latency, cost, and non-determinism. Use templates.
- **Modifying ToolAdapter trait:** The prompt engine is separate from adapters. Don't add `optimize_prompt()` to `ToolAdapter` -- adapters handle CLI interaction, not prompt formatting.
- **Frontend-side template logic:** Keep templates in Rust so they are testable, deterministic, and don't require round-trips for dispatch.
- **Over-engineering templates:** v1 templates should be simple string formatting. Don't build a template DSL or use Handlebars/Tera.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Context retrieval | Custom SQL queries | Existing `build_context_preamble` / `get_recent_events` | Already implemented in Phase 4, battle-tested |
| IPC type generation | Manual TypeScript types | `tauri-specta` auto-generation | Project convention; ensures type safety |
| State management for preview | Custom state | Zustand store (extend `taskStore` or new `promptStore`) | Project convention |

**Key insight:** The prompt engine is mostly a transformation layer -- input data (context, prompt) already exists, output format (CLI prompt string) already works. The new code is the transformation rules and preview UI.

## Common Pitfalls

### Pitfall 1: Prompt Too Long for CLI Arguments
**What goes wrong:** Tool-specific templates with full context can produce prompts exceeding shell argument length limits (typically 256KB on macOS, but CLI tools may have lower limits).
**Why it happens:** Combining planning preamble + full context history + user prompt with no size guard.
**How to avoid:** Keep the `max_chars` truncation from existing `build_context_preamble` (currently 2000 chars). Apply it within tool-specific templates too. Total optimized prompt should stay under 8000 chars.
**Warning signs:** Tools fail silently or truncate input.

### Pitfall 2: Context Preamble Duplication
**What goes wrong:** Both `spawn_claude_task` and `spawn_gemini_task` currently call `build_context_preamble` directly. If the prompt engine also injects context, context appears twice.
**Why it happens:** Forgetting to remove the old context injection when adding the new one.
**How to avoid:** The prompt engine MUST replace the current `build_context_preamble` call in `spawn_claude_task` / `spawn_gemini_task`. Remove the old injection from those functions and have `dispatch_task` use the engine instead.
**Warning signs:** Duplicate "## Recent Project Context" sections in prompts.

### Pitfall 3: Preview Shows Stale Context
**What goes wrong:** User opens preview, then a tool finishes a task (adding new context events), but the preview still shows old context.
**Why it happens:** Preview fetches context once and caches it.
**How to avoid:** Re-fetch context each time the preview panel opens or refresh button is clicked. Don't cache optimized prompts -- they're cheap to generate.
**Warning signs:** Preview shows different context than what actually gets sent.

### Pitfall 4: Breaking Existing Dispatch Flow
**What goes wrong:** Modifying `dispatch_task` or spawn functions breaks existing task submission.
**Why it happens:** Changing the prompt pipeline without maintaining backwards compatibility.
**How to avoid:** Keep the same function signatures. The prompt engine is called INSIDE `dispatch_task` before passing to spawn functions. Spawn functions receive already-optimized prompts and should NOT call `build_context_preamble` anymore.
**Warning signs:** Tasks fail to spawn, empty prompts reach tools.

### Pitfall 5: Template Testing Without Real Tools
**What goes wrong:** Templates look good in unit tests but produce poor results with actual tools.
**Why it happens:** Can't verify tool output quality without actually running the tools.
**How to avoid:** Unit test template structure (sections present, context included, no duplication). Accept that prompt quality is empirical -- STATE.md already notes "Prompt optimization effectiveness cannot be confirmed by research alone -- plan empirical measurement after Phase 8 ships."
**Warning signs:** Tools ignore context or planning instructions.

## Code Examples

### PromptContext Model
```rust
// src-tauri/src/prompt/models.rs
use serde::Serialize;
use specta::Type;

/// Context data gathered from the project for prompt optimization.
#[derive(Debug, Clone)]
pub struct PromptContext {
    /// Recent project events (tool completions, file changes)
    pub recent_events: Vec<ContextEventSummary>,
    /// Project directory path
    pub project_dir: String,
}

/// Simplified event data for prompt templates
#[derive(Debug, Clone)]
pub struct ContextEventSummary {
    pub tool_name: String,
    pub event_type: String,
    pub summary: String,
    pub files: Vec<String>,
    pub created_at: String,
}

/// The result of prompt optimization, returned via IPC for preview.
#[derive(Debug, Clone, Serialize, Type)]
pub struct OptimizedPrompt {
    pub tool_name: String,
    pub original_prompt: String,
    pub optimized_prompt: String,
}
```

### Building PromptContext from ContextStore
```rust
// Helper to build PromptContext from existing context store
pub async fn build_prompt_context(
    context_store: &ContextStore,
    project_dir: &str,
) -> Result<PromptContext, String> {
    let store = context_store.clone();
    let dir = project_dir.to_string();
    tokio::task::spawn_blocking(move || {
        store.with_conn(|conn| {
            let events = crate::context::queries::get_recent_events(conn, &dir, 5)?;
            let summaries = events
                .into_iter()
                .map(|(event, files)| ContextEventSummary {
                    tool_name: event.tool_name,
                    event_type: event.event_type,
                    summary: event.summary.unwrap_or_default(),
                    files,
                    created_at: event.created_at,
                })
                .collect();
            Ok(PromptContext {
                recent_events: summaries,
                project_dir: dir.clone(),
            })
        })
    })
    .await
    .map_err(|e| format!("Context fetch failed: {}", e))?
}
```

### Claude-Specific Context Formatting
```rust
fn format_context_for_claude(context: &PromptContext) -> String {
    let mut out = String::from("## Project Context\n\nRecent changes by other tools in this project:\n\n");
    for event in &context.recent_events {
        out.push_str(&format!(
            "- [{}] {} ({}): {}\n",
            event.created_at, event.tool_name, event.event_type, event.summary
        ));
        if !event.files.is_empty() {
            out.push_str(&format!("  Files changed: {}\n", event.files.join(", ")));
        }
    }
    out.push_str("\nConsider these recent changes when planning your approach.");
    out
}
```

### Gemini-Specific Context Formatting
```rust
fn format_context_for_gemini(context: &PromptContext) -> String {
    let mut out = String::from("Context: Recent project changes:\n");
    for event in &context.recent_events {
        let files_str = if event.files.is_empty() {
            String::new()
        } else {
            format!(" [{}]", event.files.join(", "))
        };
        out.push_str(&format!(
            "- {} by {} at {}{}\n",
            event.summary, event.tool_name, event.created_at, files_str
        ));
    }
    out
}
```

### Frontend PromptPreview Component Pattern
```typescript
// src/components/prompt/PromptPreview.tsx
import { useState, useEffect } from 'react';
import { commands } from '../../bindings';
import type { OptimizedPrompt } from '../../bindings';

interface PromptPreviewProps {
  prompt: string;
  projectDir: string;
  visible: boolean;
  onClose: () => void;
}

export function PromptPreview({ prompt, projectDir, visible, onClose }: PromptPreviewProps) {
  const [previews, setPreviews] = useState<OptimizedPrompt[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible || !prompt.trim()) return;
    setLoading(true);
    commands.optimizePrompt(prompt, projectDir).then((result) => {
      if (result.status === 'ok') setPreviews(result.data);
      setLoading(false);
    });
  }, [visible, prompt, projectDir]);

  if (!visible) return null;

  return (
    <div className="border-t border-zinc-800 bg-zinc-900/80 p-3 space-y-2">
      <div className="flex justify-between items-center">
        <span className="text-xs font-semibold text-zinc-400">Prompt Preview</span>
        <button onClick={onClose} className="text-xs text-zinc-500 hover:text-zinc-300">
          Close
        </button>
      </div>
      <div className="flex gap-3">
        {previews.map((p) => (
          <div key={p.tool_name} className="flex-1 rounded bg-zinc-800 p-2">
            <div className="text-xs font-mono text-zinc-400 mb-1">{p.tool_name}</div>
            <pre className="text-xs text-zinc-300 whitespace-pre-wrap max-h-48 overflow-y-auto">
              {p.optimized_prompt}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Generic context prepend for all tools | Tool-specific prompt templates | Phase 8 (now) | Better tool utilization; Claude gets planning frame, Gemini gets flat context |
| No preview before send | Preview panel shows optimized prompts | Phase 8 (now) | User transparency, trust building |

**Current codebase state:**
- `build_context_preamble()` already assembles context but uses identical format for both tools
- Both `spawn_claude_task` and `spawn_gemini_task` inject context identically
- `dispatch_task` in `commands/router.rs` routes to the correct spawn function
- The prompt engine replaces the per-spawn context injection with centralized, tool-aware optimization

## Open Questions

1. **Optimal Claude planning preamble wording**
   - What we know: Claude responds well to "think step by step" and planning-before-action patterns
   - What's unclear: Exact wording that maximizes Claude Code CLI quality
   - Recommendation: Start with simple planning frame, iterate based on empirical results post-Phase 8

2. **Gemini context window utilization**
   - What we know: Gemini has large context windows and handles lots of upfront context
   - What's unclear: Whether more context (higher `max_events`/`max_chars`) improves Gemini results
   - Recommendation: Start with same limits (5 events / 2000 chars), can increase Gemini limits later

3. **Template versioning**
   - What we know: Prompt effectiveness may change as tool CLIs update
   - What's unclear: How often templates need updating
   - Recommendation: Keep templates simple so they're easy to modify; log template version in context events for future A/B testing

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework (Rust) | cargo test (built-in) |
| Framework (Frontend) | vitest 4.0.18 + jsdom |
| Config file (Frontend) | vite.config.ts (test section) |
| Quick run command | `cd src-tauri && cargo test prompt` / `npx vitest run --reporter=verbose` |
| Full suite command | `cd src-tauri && cargo test && cd .. && npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PMPT-01 | Single prompt accepted by engine | unit | `cd src-tauri && cargo test prompt::tests::optimize_accepts_raw_prompt -x` | Wave 0 |
| PMPT-02 | Different output per tool | unit | `cd src-tauri && cargo test prompt::tests::claude_and_gemini_differ -x` | Wave 0 |
| PMPT-03 | Preview returns optimized prompts via IPC | unit | `npx vitest run src/tests/prompt.test.ts` | Wave 0 |
| PMPT-04 | Context included in optimized prompt | unit | `cd src-tauri && cargo test prompt::tests::context_included -x` | Wave 0 |

### Sampling Rate
- **Per task commit:** `cd src-tauri && cargo test prompt`
- **Per wave merge:** `cd src-tauri && cargo test && cd .. && npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src-tauri/src/prompt/mod.rs` -- PromptEngine with unit tests
- [ ] `src-tauri/src/prompt/templates.rs` -- template functions with tests
- [ ] `src-tauri/src/prompt/models.rs` -- OptimizedPrompt type (specta-exported)
- [ ] `src-tauri/src/commands/prompt.rs` -- optimize_prompt IPC command
- [ ] `src/tests/prompt.test.ts` -- frontend preview component tests

## Sources

### Primary (HIGH confidence)
- Direct codebase analysis: `src-tauri/src/adapters/mod.rs`, `claude.rs`, `gemini.rs` -- current ToolAdapter trait and build_command implementations
- Direct codebase analysis: `src-tauri/src/context/injection.rs` -- current context preamble building
- Direct codebase analysis: `src-tauri/src/commands/router.rs` -- current dispatch_task flow
- Direct codebase analysis: `src-tauri/src/commands/claude.rs`, `gemini.rs` -- current spawn functions with context injection

### Secondary (MEDIUM confidence)
- Claude Code CLI behavior: Training knowledge about Claude's `-p` flag and response to structured prompts
- Gemini CLI behavior: Training knowledge about Gemini's context handling preferences

### Tertiary (LOW confidence)
- Optimal template wording for each tool: empirical, needs real-world testing post-implementation

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new dependencies, all existing patterns
- Architecture: HIGH - clear integration points, pure function transformation
- Pitfalls: HIGH - identified from direct codebase analysis of existing flows
- Template effectiveness: LOW - prompt optimization is inherently empirical

**Research date:** 2026-03-06
**Valid until:** 2026-04-06 (stable -- no external dependency changes expected)
