# Project Research Summary

**Project:** WhaleCode
**Domain:** AI coding tool orchestration macOS desktop app (Tauri v2)
**Researched:** 2026-03-05
**Confidence:** MEDIUM-HIGH

## Executive Summary

WhaleCode is an AI coding tool orchestrator — a Tauri v2 desktop app that manages multiple AI coding CLIs (Claude Code, Gemini CLI, Codex CLI) in parallel on behalf of a developer. The core premise is that no single AI tool excels at every task, and the coordination overhead of managing multiple tools manually defeats the productivity benefit of using them. WhaleCode solves this by providing shared project context, intelligent task routing, per-tool prompt optimization, and parallel execution with conflict detection. Research confirms this product category is real and actively contested: OpenAI Codex App, Augment Intent, and Cursor Agents all target adjacent problems, but none offer heterogeneous cross-tool orchestration. WhaleCode's primary differentiator — routing tasks to the best tool and rewriting the prompt for each tool's conventions — has no direct competitor today.

The recommended architecture is clear: a Tauri v2 Rust backend manages all subprocess lifecycle (PTY/process spawning via `tokio::process`), shared state, conflict detection, and context persistence. The React + TypeScript frontend handles real-time output display (via xterm.js and Tauri Channels), task submission, and status monitoring. All AI tool integration runs as headless CLI subprocesses from Rust — not from the WebView. Context is stored in SQLite (via `rusqlite`) as a write-ahead log of file changes and decisions, and injected per-tool before each task. This architecture keeps API keys in the Rust process, streams output efficiently via Tauri Channels (not events), and isolates tool processes so one crash cannot take down others.

The dominant risk is premature parallelism: running two tools against the same working directory without git worktree isolation and a file-lock registry will produce silent file overwrites that destroy developer trust immediately. All research sources converge on the same mitigation: git worktree isolation per agent must be built before parallel dispatch is enabled, period. Secondary risks include brittle CLI output parsing (use structured output flags and snapshot tests), context drift (treat context as a write-ahead log, not a snapshot), and Tauri IPC bottlenecks under streaming load (batch output, use Channels not events). These are all solvable with disciplined architecture but will punish shortcuts.

---

## Key Findings

### Recommended Stack

The stack is anchored by Tauri v2 (Rust backend + WKWebView frontend) chosen for native macOS performance, small binary size, and Rust's ownership model that naturally prevents the race conditions multi-process orchestration would otherwise encounter. The frontend uses React 19 + TypeScript 5 + Vite 6, selected over Svelte for its larger ecosystem around xterm.js integration and complex multi-pane UIs.

For AI tool integration, all three CLIs (Claude Code, Gemini, Codex) are spawned as subprocesses via `tokio::process::Command` from Rust — never from the WebView. This keeps API keys out of the inspectable JavaScript context and gives direct async access to stdout/stderr streams. The PTY layer (`tauri-plugin-pty` wrapping `portable-pty`) is available when interactive terminal UI is needed, but headless subprocess pipes are simpler and sufficient for orchestrated tool invocation. Type-safe IPC between Rust and TypeScript is achieved via `tauri-specta`, eliminating a whole class of runtime type mismatch bugs.

**Core technologies:**
- **Tauri v2.10.2:** Desktop shell — Rust backend + WKWebView; native macOS, 10-50x smaller than Electron
- **Rust 1.77+ / Tokio:** Async runtime for process spawning, state management, IPC; ownership prevents race conditions
- **React 19 + TypeScript 5 + Vite 6:** Frontend UI — type-safe, strong xterm.js ecosystem, fast HMR
- **tauri-specta 2.x:** Auto-generates TypeScript types from Rust command signatures — eliminates IPC type drift
- **@xterm/xterm 5.5.0 + react-xtermjs:** Terminal emulator UI for displaying streaming AI tool output
- **Zustand 5.x:** Frontend ephemeral state; Rust `Mutex<AppState>` manages authoritative backend state
- **tokio::process:** Headless subprocess spawning for Claude Code (`-p`), Gemini CLI, Codex CLI from Rust
- **SQLite via rusqlite:** Embedded context store for project memory, file change log, decision history
- **Tailwind CSS 4.x + shadcn/ui:** UI component layer — polished native-feel desktop UI, no runtime overhead
- **serde / serde_json:** JSON serialization for CLI output parsing and Tauri IPC payloads

**Critical version notes:**
- `tauri` and `tauri-build` must match minor version (both 2.10.x)
- `tauri-plugin-pty 0.1.1` is Tauri v2 only
- All `@xterm/*` addons must be the same major version (5.x)
- Do NOT use `#[tokio::main]` on the Rust main function — conflicts with Tauri's internal runtime

See `.planning/research/STACK.md` for full installation commands and alternatives considered.

---

### Expected Features

No competitor provides cross-tool heterogeneous orchestration. WhaleCode's unique position is combining two or more AI coding tools (each with different strengths) under a single orchestrator that manages shared context, prompt adaptation, and conflict detection. The competitive moat is the combination — not any single feature.

**Must have for launch (table stakes):**
- **Git worktree isolation per agent** — parallel execution without isolation causes immediate silent overwrites; this is non-negotiable
- **Parallel execution (Claude Code + Gemini CLI)** — the core product hypothesis; two tools simultaneously
- **Persistent shared project context** — CLAUDE.md-compatible context maintained by WhaleCode and injected per tool; the #1 user pain point today
- **Task history event log** — file-level change log per agent, readable by other agents before they start
- **Conflict detection** — file-level overlap detection before merge; even a simple warning is sufficient for v1
- **Diff review before commit** — mandatory human review gate; no auto-commit; trust-critical
- **Live agent status panel** — per-tool running/paused/done state with elapsed time
- **Cancel/pause per agent** — control over runaway processes
- **Per-tool output log** — scrollable log per agent with timestamps

**Should have (competitive differentiators, add in v1.x):**
- **Automatic prompt optimization per tool** — rewrite user prompt for each tool's conventions; no competitor does this today; highest differentiation value
- **Intelligent task routing** — assign task to optimal tool based on task type; start rule-based, evolve to scored
- **Bounded autonomy controls** — per-task file allowlist/denylist; builds trust for power users running multiple parallel agents
- **Codex CLI adapter** — third tool; add once two-tool architecture is stable

**Defer to v2+:**
- Task decomposition assistant (requires routing + orchestration model working well first)
- Conflict resolution suggestions (requires strong diff infrastructure)
- Cross-team context sharing (v1 is single-developer)
- Automation scheduling (background agent runs)

See `.planning/research/FEATURES.md` for full feature dependency graph and competitor analysis.

---

### Architecture Approach

The architecture follows a strict layered separation: WebView frontend (React) communicates with Rust backend via Tauri IPC (`invoke`/`listen`/`Channel`). The Rust backend manages all business logic via an Orchestrator layer (Task Router, Process Manager, Output Multiplexer, Conflict Resolver, Prompt Engine) backed by a shared `Mutex<AppState>`. Each AI CLI tool runs as a separate OS subprocess spawned by `tokio::process::Command`. Streaming output from each tool goes through a dedicated `tauri::Channel<OutputEvent>` (not Tauri global events, which are too slow for high-throughput streaming). Internal Rust components communicate via `tokio::sync::mpsc` channels for async, non-blocking event passing.

**Major components and responsibilities:**
1. **Command Layer** — thin Tauri command handlers (`#[tauri::command]`) that delegate to Orchestrator; keeps IPC surface clean
2. **Task Router** — decides which tool handles which task based on task type and tool capabilities; v1 is rule-based
3. **Process Manager** — spawns, tracks, kills CLI subprocesses via `tokio::process::Command`; stores `Child` handles in AppState
4. **Output Multiplexer** — reads stdout line-by-line per spawned process; fans out to per-tool `tauri::Channel` to frontend
5. **Context Store** — SQLite write-ahead log of file changes, tool decisions, and project memory; queried by Prompt Engine
6. **Prompt Engine** — transforms user prompt into tool-optimized variant using per-tool templates + relevant context from Context Store
7. **Conflict Resolver** — maintains `file_locks: HashMap<PathBuf, ToolId>` in AppState; checks for overlapping file writes before dispatch
8. **Tool Trait + Adapters** — `Tool` trait with `spawn()`, `kill()`, `capabilities()`; each CLI is one adapter implementing this trait; adding Codex is adding one file

**Key patterns to follow:**
- Use `tauri::Channel<OutputEvent>` (one per task) for streaming output — NOT global Tauri events
- Use `std::sync::Mutex` (not `tokio::sync::Mutex`) for AppState unless you hold the lock across `.await` points
- Spawn process management tasks with `tauri::async_runtime::spawn()`, never block in a command handler
- Model the Task Router as a DAG scheduler, not just a routing table — dependency ordering is more important than tool selection

**Recommended build order:** AppState scaffold → Tool trait + Claude Code adapter → Process Manager + Output Multiplexer → Frontend output console → Context Store → Prompt Engine → Task Router → Gemini adapter → Conflict Resolver → Full dashboard

See `.planning/research/ARCHITECTURE.md` for full project structure, data flow diagrams, and code examples.

---

### Critical Pitfalls

Eight production-validated pitfalls were identified. The top five are:

1. **Parallel agents silently overwriting each other's files** — Two tools touch overlapping files; the later write silently wins and no error fires. Prevention: git worktree isolation per agent (mandatory before enabling parallel dispatch); file-lock registry in AppState; pre-dispatch file overlap analysis. Do not ship parallel execution without this.

2. **Orphaned CLI processes after app shutdown** — Tauri window-close events are unreliable; spawned CLI processes survive app exit and accumulate. Prevention: track all PIDs in `Arc<Mutex<Vec<Child>>>`, use `RunEvent::Exit` hook (not window events), verify cleanup on every restart with `pgrep`.

3. **Brittle CLI output parsing** — CLI tools change output format on every version update; regex-based parsing breaks silently. Prevention: always use structured output flags (`--output-format json` for Claude Code, `--format json` for Gemini), set `NO_COLOR=1` and `TERM=dumb` in subprocess env, write snapshot tests against recorded real output.

4. **Context drift between tools** — Tool B acts on stale pre-Task-A state, calling renamed functions and obsolete APIs. Prevention: treat context as a write-ahead log updated on every task completion; only dispatch truly independent tasks in parallel (different modules/files); never share a context snapshot between parallel tasks.

5. **Claude Code headless silent failures** — Claude Code `-p` mode returns exit code 0 with empty or irrelevant output ~8% of the time. Prevention: never trust exit code 0 alone; validate JSON output `result` field length and token count; treat zero-token responses as failures and re-queue.

Additional pitfalls to address: Tauri IPC streaming bottleneck (batch output in 100-500ms windows, use Channels not events), API rate limit collisions across parallel tool instances (centralized quota tracking, staggered starts, jitter on retry), and task dependency ignored in routing (model tasks as DAG, not queue; scheduling order matters as much as tool selection).

See `.planning/research/PITFALLS.md` for the full pitfall list, security mistakes, performance traps, and the "Looks Done But Isn't" verification checklist.

---

## Implications for Roadmap

Based on the feature dependency graph from FEATURES.md, the component build order from ARCHITECTURE.md, and the phase mappings from PITFALLS.md, the following phase structure is strongly recommended.

### Phase 1: Foundation — Tauri Scaffold + Process Management

**Rationale:** Everything else depends on a working, clean process management layer. The most dangerous pitfalls (orphaned processes, IPC bottleneck) must be solved first or they'll corrupt every subsequent phase. This phase has no AI logic — it's pure infrastructure.

**Delivers:**
- Tauri v2 project scaffold (React + TypeScript + Vite)
- AppState (`Mutex<AppState>`) with task registry, file lock registry
- `tokio::process::Command` subprocess spawning with PID tracking
- `RunEvent::Exit` cleanup hooks — verified zombie-free shutdown
- `tauri::Channel<OutputEvent>` streaming pipeline to frontend
- Basic xterm.js output console wired to channel

**Addresses:** Orphaned process pitfall, IPC streaming bottleneck pitfall

**Research flag:** Well-documented Tauri patterns — skip `/gsd:research-phase` here. Use STACK.md code examples directly.

---

### Phase 2: Claude Code Adapter + Single-Tool Headless Execution

**Rationale:** Validate the Tool trait abstraction and headless execution pipeline with one tool before building routing on top. Claude Code is the primary tool and has the most nuanced integration requirements (NDJSON streaming, silent failure detection, session IDs). Get this right in isolation.

**Delivers:**
- `Tool` trait definition (`spawn`, `kill`, `capabilities`)
- Claude Code adapter: headless `-p` invocation, `--output-format stream-json` NDJSON parsing
- Response validation: exit code + JSON `result` field + token count check (addresses silent failure pitfall)
- Session ID management for multi-turn context
- Snapshot tests for output parsing against recorded real output
- API key storage via `tauri-plugin-keyring` (OS keychain, not plaintext)

**Addresses:** Claude Code silent failure pitfall, brittle output parsing pitfall, security mistake (plaintext keys)

**Research flag:** Needs `/gsd:research-phase` — Claude Code NDJSON streaming protocol details, `--allowedTools` scoping syntax, session resume behavior, and current silent failure rate. Official docs exist but the edge cases need targeted research.

---

### Phase 3: Context Store + Shared Project Memory

**Rationale:** Context is required by the Prompt Engine (Phase 5) and Conflict Resolver (Phase 6), and must be built before parallel execution is enabled (Pitfall 4: context drift). Cannot share meaningful context between tools without this layer.

**Delivers:**
- SQLite context store via `rusqlite` — embedded, no server
- Write-ahead log schema: `{timestamp, tool_id, files_changed, summary, git_diff}`
- Context query API: recency-weighted + task-relevant retrieval
- CLAUDE.md / AGENTS.md file writer — exports context in each tool's native format
- Context injected into every tool invocation as structured preamble

**Addresses:** Context drift pitfall, persistent shared project context (table stakes feature)

**Research flag:** Well-documented SQLite embedded patterns in Rust — skip research. The context schema design is product judgment, not a research question.

---

### Phase 4: Git Worktree Isolation + Conflict Detection

**Rationale:** This is the mandatory prerequisite for parallel execution. No parallel dispatch before this phase is complete and verified. The file-lock registry and worktree setup are simpler than they appear, but they must be proven correct before any parallelism is enabled.

**Delivers:**
- Git worktree creation per task (`git worktree add`)
- File-lock registry in AppState: `file_locks: HashMap<PathBuf, ToolId>`
- Pre-dispatch conflict check: blocks overlapping tasks or warns user
- Post-task conflict detection via MPSC event from Process Manager to Conflict Resolver
- Worktree cleanup and merge-back workflow with diff review UI
- Verification: two agents editing the same file produces a conflict warning, not a silent overwrite

**Addresses:** Silent file overwrite pitfall (the most critical pitfall in all research), conflict detection (table stakes feature), diff review before commit (table stakes feature)

**Research flag:** Needs `/gsd:research-phase` — git worktree lifecycle edge cases (detached HEAD state recovery, worktree cleanup on crash, partial merge strategies). The `clash` tool is worth examining as a reference implementation.

---

### Phase 5: Gemini CLI Adapter + Task Router (v1 Parallel Execution)

**Rationale:** With worktree isolation and context store in place, adding the second tool enables the core product hypothesis. The Task Router v1 is rule-based (Claude for refactoring/architecture, Gemini for large-codebase reads). Route-then-dispatch with DAG dependency resolution.

**Delivers:**
- Gemini CLI adapter: headless invocation, structured output parsing, quota tracking
- Task Router: rule-based tool selection + DAG dependency resolution (task B waits for task A if they share files)
- Parallel dispatch with staggered starts (1-3 second jitter) to prevent API rate limit thundering herd
- Centralized quota tracker across all spawned tool instances
- Live agent status panel: per-tool running/waiting/done/error state with elapsed time
- Cancel/pause per agent controls

**Addresses:** API rate limit collision pitfall, task dependency ordering pitfall, parallel execution (table stakes), live agent status (table stakes), cancel/pause (table stakes)

**Research flag:** Needs `/gsd:research-phase` — Gemini CLI headless mode stability (documented as lacking full programmatic SDK support), multi-root workspace limitation, quota exhaustion / multi-day lockout behavior, and current `--output_format json` flag availability. Gemini CLI integration is MEDIUM confidence in research.

---

### Phase 6: Prompt Engine + Tool-Specific Optimization

**Rationale:** The highest-value differentiator. No competitor does cross-tool prompt rewriting. Now that both adapters are stable and the context store is populated with real project history, the Prompt Engine can reliably inject relevant context and apply per-tool prompt conventions.

**Delivers:**
- Per-tool prompt templates (Claude: extended thinking + explicit planning; Gemini: large context dumps; Codex: concise task framing)
- Context-aware preamble injection: recent + task-relevant entries from Context Store, capped at ~2000 tokens
- Prompt quality validation: length check, ambiguity detection, tool-specific required fields
- A/B comparison tooling: raw user prompt vs. optimized prompt output side-by-side (internal dev tool)

**Addresses:** Monolithic context blob anti-pattern, automatic prompt optimization (differentiator feature)

**Research flag:** Needs `/gsd:research-phase` — current Claude Code and Gemini CLI prompt conventions, extended thinking flags, recommended context structure for each tool's best performance. Prompt effectiveness is empirical — plan for iteration after shipping.

---

### Phase 7: Polish + Bounded Autonomy + Codex CLI Adapter

**Rationale:** With the core two-tool orchestration validated, this phase adds the third tool and the trust-building controls that unlock power users running multiple parallel agents. Dashboard polish comes here — not before core functionality is proven.

**Delivers:**
- Bounded autonomy controls: per-task file allowlist/denylist, command-level permission scoping for `--allowedTools`
- Codex CLI adapter: `codex exec --json` JSONL parsing or `codex app-server` JSON-RPC for stateful sessions
- Full dashboard polish: active tool prominence, collapsed idle tools, conflict UI in human-readable form
- Per-tool output log: scrollable, timestamped, with "raw output" expandable detail
- macOS native polish: menubar integration, notifications for task completion, keyboard shortcuts

**Addresses:** Bounded autonomy controls (differentiator), Codex CLI adapter (P2 feature), native macOS experience (table stakes)

**Research flag:** Needs `/gsd:research-phase` for Codex CLI — `codex app-server` JSON-RPC protocol is relatively new (MEDIUM confidence). The `codex exec --json` JSONL format needs snapshot testing before the adapter is built.

---

### Phase Ordering Rationale

- **Phases 1-2 before anything else:** You cannot safely build routing or parallelism without a verified process lifecycle and a working single-tool adapter. Skip this and every subsequent phase is built on uncertain ground.
- **Phase 3 before Phase 4:** Conflict detection is meaningless without knowing what context each tool has. The conflict resolver injects pre-task context from the store; the store must exist first.
- **Phase 4 before Phase 5:** This is the hard invariant from all four research files. Do not enable parallel dispatch without worktree isolation and the file-lock registry. No exceptions.
- **Phase 5 before Phase 6:** The Prompt Engine needs real tool adapters to optimize for, and real context store entries to draw from. Building it earlier produces a prompt optimizer with nothing to optimize over.
- **Phase 6 before Phase 7:** Third-tool adapters (Codex) benefit from having a working Prompt Engine template to plug into. Polish and tooling correctness before expansion.

---

### Research Flags Summary

| Phase | Research Needed? | Reason |
|-------|-----------------|--------|
| Phase 1: Foundation | No | Well-documented Tauri v2 patterns; use STACK.md examples directly |
| Phase 2: Claude Code Adapter | Yes | NDJSON streaming edge cases, `--allowedTools` syntax, silent failure rate validation |
| Phase 3: Context Store | No | Standard SQLite embedded Rust patterns; schema is product judgment |
| Phase 4: Worktree Isolation | Yes | Git worktree lifecycle edge cases on crash/partial merge; `clash` reference |
| Phase 5: Gemini + Task Router | Yes | Gemini CLI headless stability, quota lockout behavior, DAG scheduling patterns |
| Phase 6: Prompt Engine | Yes | Current per-tool prompt conventions; empirical iteration required |
| Phase 7: Polish + Codex | Yes | Codex app-server JSON-RPC protocol; `--allowedTools` scoping for bounded autonomy |

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Core Tauri v2 + Rust stack verified against official docs; version compatibility confirmed. `tauri-plugin-pty` is MEDIUM (crates.io load failed, cross-referenced lib.rs). |
| Features | MEDIUM-HIGH | Table stakes validated against OpenAI Codex App, Augment Intent, Cursor competitor analysis. Differentiator claims (prompt optimization, cross-tool routing) lack competitor benchmarks — no one has shipped this to validate demand. |
| Architecture | HIGH | Tauri v2 component patterns from official docs. Orchestrator-specific patterns (DAG scheduling, context store schema) are MEDIUM — derived from general multi-agent patterns, not WhaleCode-specific prior art. |
| Pitfalls | HIGH | 8 pitfalls validated across official docs, GitHub issues, and multiple community sources. All have direct citations. Process cleanup and IPC bottleneck issues are especially well-documented in Tauri's own GitHub. |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address

- **Gemini CLI integration stability:** Gemini CLI lacks a full programmatic SDK and has a documented multi-root workspace limitation. Actual headless invocation behavior needs hands-on validation in Phase 5 — plan to adjust the adapter if `--output_format json` is unavailable or unstable.

- **Prompt optimization effectiveness:** No research can validate whether per-tool prompt rewriting actually improves output quality without empirical testing. Phase 6 should include an explicit measurement protocol (same task raw vs. optimized, compare file change quality) before shipping.

- **Context store token budget:** The "inject under 2000 tokens" recommendation is a heuristic, not a tested number. The actual effective context window per tool and the right summarization threshold should be calibrated empirically in Phase 6.

- **Codex CLI app-server protocol:** Described as MEDIUM confidence in STACK.md due to the tool's relative newness. The JSON-RPC protocol details for stateful sessions need dedicated research before Phase 7 builds the adapter.

- **macOS API key keychain behavior:** `tauri-plugin-keyring` replaces the deprecated `stronghold` plugin — confirm the keyring plugin is stable and production-ready for Tauri v2 before Phase 2 ships.

---

## Sources

### Primary (HIGH confidence)
- [Tauri v2 official docs](https://v2.tauri.app/) — architecture, IPC, state management, channels vs. events
- [Claude Code headless documentation](https://code.claude.com/docs/en/headless) — `-p` mode, `--output-format`, session IDs, `--allowedTools`
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) — NDJSON streaming protocol
- [Gemini CLI headless mode docs](https://google-gemini.github.io/gemini-cli/docs/cli/headless.html) — headless invocation
- [tokio::process documentation](https://docs.rs/tokio/latest/tokio/process/) — async subprocess management
- [@anthropic-ai/claude-code npm](https://www.npmjs.com/package/@anthropic-ai/claude-code) — v2.1.66
- [@xterm/xterm npm](https://www.npmjs.com/package/@xterm/xterm) — v5.5.0
- [tauri-specta GitHub](https://github.com/specta-rs/tauri-specta) — type-safe IPC generation
- [OpenAI Codex App docs](https://openai.com/index/introducing-the-codex-app/) — competitor feature analysis
- [Augment Intent docs](https://docs.augmentcode.com/intent/overview) — competitor feature analysis

### Secondary (MEDIUM confidence)
- [tauri-plugin-pty crates.io/GitHub](https://github.com/Tnze/tauri-plugin-pty) — Tauri v2 PTY plugin (crates.io load failed, lib.rs cross-reference)
- [Tauri GitHub Discussion #7146](https://github.com/tauri-apps/tauri/discussions/7146) — IPC performance at high throughput
- [Tauri sidecar lifecycle issue #3062](https://github.com/tauri-apps/plugins-workspace/issues/3062) — orphaned process behavior
- [clash — parallel agent conflict detection](https://github.com/clash-sh/clash) — git worktree conflict tooling reference
- [Gemini CLI limitations](https://milvus.io/ai-quick-reference/what-are-the-limitations-of-gemini-cli) — multi-root workspace, programmatic SDK gaps
- [Gemini CLI multi-root issue #17323](https://github.com/google-gemini/gemini-cli/issues/17323) — workspace limitation
- [METR research on autonomous agent speedup](https://addyosmani.com/blog/future-agentic-coding/) — referenced in FEATURES.md anti-feature rationale
- Community articles on Tauri async patterns, multi-agent orchestration anti-patterns

### Tertiary (LOW confidence)
- OpenAI Codex CLI `app-server` JSON-RPC protocol — relatively new, limited documentation
- Per-tool prompt convention effectiveness — no empirical benchmarks available; needs validation during Phase 6

---
*Research completed: 2026-03-05*
*Ready for roadmap: yes*
