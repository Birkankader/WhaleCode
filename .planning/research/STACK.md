# Stack Research

**Domain:** AI coding tool orchestration macOS desktop app
**Researched:** 2026-03-05
**Confidence:** MEDIUM-HIGH (core Tauri stack HIGH; AI CLI integration patterns MEDIUM due to rapidly evolving tooling)

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Tauri | 2.10.2 (latest stable) | Desktop app shell — Rust backend + WebView frontend | Chosen in PROJECT.md. 10-50x smaller binaries than Electron, native macOS feel, Rust performance for process management. WebView is native WKWebView on macOS. |
| Rust | 1.77+ (MSRV per Tauri) | Backend runtime — process spawning, PTY, state | Required by Tauri. Ownership model prevents the race conditions that would otherwise plague multi-process orchestration. No GC pauses. |
| React | 19.x | Frontend UI framework | Larger ecosystem than Svelte for complex UIs (multi-pane terminals, real-time status). More community patterns for xterm.js integration. TypeScript-first. |
| TypeScript | 5.x | Frontend language | End-to-end type safety with tauri-specta for Rust↔TypeScript IPC. Essential for a complex event-driven UI. |
| Vite | 6.x | Frontend build tool | Official Tauri recommendation. HMR works correctly with Tauri's WebView. Fastest build times for TypeScript projects. |
| Tokio | 1.x (bundled in Tauri) | Async runtime for Rust | Tauri bundles Tokio internally. Use `tauri::async_runtime` for commands. Add `tokio` directly only for advanced process stream handling. |

### PTY and Process Management (Rust)

| Library | Version | Purpose | Why Recommended |
|---------|---------|---------|-----------------|
| tauri-plugin-pty | 0.1.1 | Tauri-native PTY plugin — bridges portable-pty to frontend | Purpose-built for Tauri v2. Handles the Tauri IPC plumbing for PTY data streams so you don't build it from scratch. Uses portable-pty ^0.9 under the hood. |
| portable-pty | ^0.9 (via plugin) | Cross-platform PTY creation and management | Used by wezterm. Battle-tested. Provides PtySize, CommandBuilder, and spawn_command. tauri-plugin-pty wraps this — only use directly if you need lower-level control. |
| tokio::process | 1.x (bundled) | Async subprocess spawning without PTY | For headless CLI invocations (claude -p, gemini -p) where you don't need a full PTY — just stdin/stdout pipes. Simpler than PTY when interactive terminal is not needed. |

### Frontend Terminal UI

| Library | Version | Purpose | Why Recommended |
|---------|---------|---------|-----------------|
| @xterm/xterm | 5.5.0 | Terminal emulator UI in WebView | Industry standard. Used in VS Code. Actively maintained under the new scoped `@xterm/*` namespace (old `xterm` package is deprecated). |
| @xterm/addon-fit | 5.x | Resize terminal to container | Essential — without it the terminal doesn't fill its container on window resize. |
| @xterm/addon-web-links | 5.x | Clickable links in terminal output | UX improvement for file paths and URLs in AI tool output. |
| @xterm/addon-canvas | 5.x | Canvas renderer (performance) | Faster rendering than default DOM renderer for rapid AI output streams. Use instead of webgl addon for broader compatibility. |
| react-xtermjs | 1.0.9 | React wrapper for xterm.js | Maintained by Qovery. Provides `useXTerm` hook and `XTerm` component. More idiomatic than direct xterm.js DOM mounting in React. |

### IPC — Frontend ↔ Rust

| Library | Version | Purpose | Why Recommended |
|---------|---------|---------|-----------------|
| tauri-specta | 2.x | Auto-generate TypeScript types from Rust command signatures | Eliminates the entire class of runtime errors from mismatched IPC types. Exports `.ts` bindings during dev builds. Works with events too, not just commands. |
| @tauri-apps/api | 2.x | Official Tauri JS API | invoke(), listen(), emit() — the core IPC primitives. Required. |
| @tauri-apps/plugin-shell | 2.x | Controlled subprocess spawning from frontend | Use for sidecar binaries. Also needed if you spawn CLI tools directly from JS side (less recommended vs. Rust-side spawning). |

### Frontend State Management

| Library | Version | Purpose | Why Recommended |
|---------|---------|---------|-----------------|
| Zustand | 5.x | Frontend state — per-window, ephemeral UI state | Best fit for Tauri. Community-validated pattern: Zustand manages frontend state, Rust backend manages authoritative global state. Small bundle, hooks-based, no boilerplate. |
| Rust `Mutex<T>` + `tauri::State<T>` | (stdlib) | Backend authoritative state — active processes, tool registry, shared context | Tauri wraps State in Arc automatically. Use `tokio::sync::Mutex` for async commands, `std::sync::Mutex` for sync commands. |

### AI Tool Integration

| Library | Version | Purpose | Why Recommended |
|---------|---------|---------|-----------------|
| @anthropic-ai/claude-code | 2.1.66 | Claude Code SDK (Node.js/TypeScript) | Official Anthropic package. Provides programmatic access to the Claude Code agent loop. Use the Agent SDK for structured callbacks vs. raw subprocess. |
| Claude Code CLI (`claude -p`) via tokio::process | — | Headless CLI invocation from Rust | Use `--output-format json` for structured output, `--output-format stream-json` for streaming. Session IDs allow multi-turn conversations. Spawn via `tokio::process::Command`. |
| Gemini CLI (`gemini -p`) via tokio::process | — | Headless CLI invocation from Rust | Gemini CLI supports headless mode: pass prompt as positional arg, use `--output-format json` for structured responses. Spawn via `tokio::process::Command`. |
| Codex CLI (`codex exec`) via tokio::process | — | Headless CLI invocation from Rust | Use `codex exec --json` for JSONL streaming output. Also supports `codex app-server` JSON-RPC over stdio for stateful sessions. |
| reqwest | 0.12.x | Async HTTP client for Rust | For direct Anthropic/Google/OpenAI REST API calls when bypassing CLI. Tokio-compatible, TLS built in. |
| serde / serde_json | 1.x | JSON (de)serialization in Rust | Required for parsing CLI JSON output streams and for Tauri IPC (all invoke args/returns must be serde-serializable). |

### UI Component Layer

| Library | Version | Purpose | Why Recommended |
|---------|---------|---------|-----------------|
| Tailwind CSS | 4.x | Utility-first styling | Fastest way to build polished desktop UI. Pairs with shadcn/ui. No runtime overhead — all purged at build. |
| shadcn/ui | Latest | Headless component library | Not a dependency — you own the component source. Radix UI primitives under the hood give you accessible components. Well-documented Tauri + shadcn community templates exist. |
| Lucide React | Latest | Icon set | Ships with shadcn/ui. SVG-based, tree-shakeable. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `create-tauri-app` | Project scaffolding | Use the React + TypeScript + Vite template as starting point |
| Cargo | Rust package manager | Pin tauri, tauri-build to same minor version |
| Vitest | Frontend unit testing | Tauri provides mock APIs for testing IPC calls offline |
| @tauri-apps/api/mocks | Mock Tauri APIs in tests | Lets you test invoke() calls without a Rust binary running |
| rust-analyzer | Rust IDE support | Essential for Rust backend development in VS Code |
| tauri-specta dev export | Type generation | Run during dev to regenerate TS bindings after Rust command changes |

---

## Installation

```bash
# Bootstrap the project
npm create tauri-app@latest whalecode -- --template react-ts
cd whalecode

# Tauri JS API (already included by template)
npm install @tauri-apps/api

# Terminal UI
npm install @xterm/xterm @xterm/addon-fit @xterm/addon-web-links @xterm/addon-canvas react-xtermjs

# Frontend state
npm install zustand

# UI components
npm install tailwindcss @tailwindcss/vite
# Initialize shadcn/ui after Tailwind setup:
npx shadcn@latest init

# Icons
npm install lucide-react

# AI SDK (TypeScript side — optional if using CLI subprocess only)
npm install @anthropic-ai/claude-code

# Dev dependencies
npm install -D vitest @tauri-apps/api

# Rust side (Cargo.toml additions)
# cargo add tauri-plugin-pty
# cargo add serde --features derive
# cargo add serde_json
# cargo add reqwest --features json,rustls-tls
# cargo add tokio --features full  (only if you need beyond tauri::async_runtime)
```

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| React 19 | Svelte / SvelteKit | Svelte has better runtime performance and smaller bundles. Choose it if the team prefers it and the xterm.js integration complexity is acceptable. No architectural reason to avoid it. |
| React 19 | Vue 3 | Vue is a solid middle ground. Choose it if the team is Vue-experienced. Good Tauri community support. |
| tauri-plugin-pty | Raw portable-pty in Rust + custom IPC | Use raw portable-pty if you need fine-grained control over PTY lifecycle events not exposed by the plugin, or if the plugin's event model doesn't fit your streaming architecture. More work but more flexible. |
| Zustand | Jotai | Jotai's atomic model suits apps with many independently updating state slices. For WhaleCode's process-centric state (a handful of active AI tool sessions), Zustand's simpler model is sufficient. |
| Zustand | Redux Toolkit | Unnecessary complexity for a single-user desktop app. No need for Redux DevTools or time-travel debugging here. |
| tokio::process (Rust-side) | @tauri-apps/plugin-shell (JS-side) | Spawn AI CLI tools from Rust — it gives you direct access to stdout/stderr streams, proper async handling, and process lifecycle management. JS-side spawning adds an extra IPC hop. |
| tauri-specta | Manual type declarations | Manual types drift from Rust implementation. tauri-specta auto-generates and keeps them in sync. Only skip it for trivial projects. |
| @xterm/xterm v5 | node-pty + custom WebSocket transport | node-pty is Node.js-specific and adds an extra process. In a Tauri app, the PTY lives in Rust via portable-pty. No need for node-pty. |
| reqwest (Rust) | axios / fetch (TypeScript) | Make API calls from Rust, not from the frontend WebView. API keys stay in the Rust process and are never exposed to the WebView. |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `xterm` (old package) | Deprecated. Replaced by scoped `@xterm/*` packages. Will not receive updates. | `@xterm/xterm` |
| `node-pty` | Node.js-specific. In Tauri, the PTY backend is Rust + portable-pty. Adding node-pty creates a Node.js sidecar process dependency with no benefit. | `tauri-plugin-pty` + `portable-pty` |
| Electron | 10x larger binaries, higher memory usage, no compelling reason to switch given the project already chose Tauri. Electron would be the right call only if the team had zero Rust knowledge. | Tauri v2 |
| Redux (react-redux) | Extreme boilerplate overhead for a desktop app where state complexity is manageable. Adds hundreds of lines of ceremony. | Zustand |
| `Arc<Mutex<T>>` wrapping Tauri State | Tauri's `State<T>` already wraps in Arc internally. Double-wrapping causes confusion and is redundant. | `tauri::State<Mutex<T>>` |
| `#[tokio::main]` on the Rust main fn | Conflicts with Tauri's internal Tokio runtime setup and causes runtime panics. | Use `tauri::async_runtime::spawn()` or `tauri::Builder::default()` — Tauri manages the runtime. |
| Storing API keys in frontend state | WebView JavaScript is inspectable. API keys in Zustand or localStorage are accessible. | Store keys in Rust State, pass only results to frontend via IPC. |
| Real-time collaboration between AI tools (v1) | Scope creep — PROJECT.md explicitly calls this out of scope. Async coordination is sufficient for v1. | Sequential/parallel task dispatch with result aggregation |
| Next.js as Tauri frontend | SSR is meaningless in a desktop app. Next.js adds build complexity with no benefit. SSG mode works but adds unnecessary overhead vs. plain Vite+React. | Vite + React |

---

## Stack Patterns by Variant

**For Claude Code integration (primary v1 tool):**
- Use `claude -p "prompt" --output-format stream-json --allowedTools "..."` spawned via `tokio::process::Command`
- Parse streaming JSONL from stdout in Rust, emit events to frontend via Tauri's `emit()` mechanism
- Use session IDs (`--resume session_id`) to maintain multi-turn context
- For structured results, use `--output-format json` and parse with `serde_json`

**For Gemini CLI integration (secondary v1 tool):**
- Use `gemini -p "prompt" --output-format json` spawned via `tokio::process::Command`
- Gemini CLI headless mode activates when run in non-TTY context or with prompt as positional arg
- No official Rust SDK — CLI subprocess is the correct integration path

**For Codex CLI integration (future v2 tool):**
- Use `codex exec --json` for JSONL streaming or `codex app-server` for stateful JSON-RPC sessions
- The `codex app-server` mode (JSON-RPC over stdio) is better for multi-turn orchestration than one-shot exec

**For direct API calls (fallback / prompt optimization):**
- Use `reqwest` in Rust + Anthropic REST API (`api.anthropic.com/v1/messages`) for tasks that don't need the full Claude Code agent loop (e.g., prompt optimization itself)
- Never route API keys through the frontend

**For shared project context (cross-tool memory):**
- Store in Rust `State<Mutex<ProjectContext>>` — single authoritative source
- Serialize to disk via `serde_json` for persistence across app restarts
- Expose read-only snapshots to frontend via Tauri commands

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| tauri 2.10.x | tauri-build 2.10.x | Must match minor version — both update together |
| tauri 2.x | tokio 1.x | Tauri bundles tokio 1.x; adding tokio = "1" directly is safe |
| tauri-plugin-pty 0.1.1 | tauri ^2, portable-pty ^0.9 | Tauri v2 only — does not work with Tauri v1 |
| @xterm/xterm 5.x | @xterm/addon-* 5.x | All xterm addons must be the same major version |
| React 19 | react-xtermjs 1.0.9 | react-xtermjs 1.0.9 supports React 18+; verify peer deps if upgrading |
| Tailwind CSS 4.x | @tailwindcss/vite 4.x | Tailwind 4 changed config format — use `@tailwindcss/vite` plugin, not PostCSS plugin |
| shadcn/ui | Tailwind CSS 3.x or 4.x | shadcn/ui has Tailwind 4 support as of early 2025; use `npx shadcn@latest init` |

---

## Sources

- [Tauri v2 Release Page](https://v2.tauri.app/release/) — confirmed v2.10.2 as latest stable (HIGH confidence)
- [Tauri IPC Documentation](https://v2.tauri.app/concept/inter-process-communication/) — commands/events patterns (HIGH confidence)
- [Tauri State Management](https://v2.tauri.app/develop/state-management/) — Mutex/State patterns (HIGH confidence)
- [Claude Code Headless Docs](https://code.claude.com/docs/en/headless) — `-p` flag, output formats, session IDs (HIGH confidence)
- [Gemini CLI Headless Mode](https://google-gemini.github.io/gemini-cli/docs/cli/headless.html) — headless invocation patterns (HIGH confidence)
- [tauri-plugin-pty on crates.io](https://crates.io/crates/tauri-plugin-pty) — v0.1.1, portable-pty ^0.9 dependency (MEDIUM confidence — crates.io load failed, cross-referenced with lib.rs)
- [tauri-plugin-pty GitHub](https://github.com/Tnze/tauri-plugin-pty) — Tauri v2 PTY plugin (MEDIUM confidence)
- [tauri-specta GitHub](https://github.com/specta-rs/tauri-specta) — type-safe IPC generation (HIGH confidence)
- [@anthropic-ai/claude-code npm](https://www.npmjs.com/package/@anthropic-ai/claude-code) — v2.1.66 (HIGH confidence)
- [xterm.js npm (@xterm/xterm)](https://www.npmjs.com/@xterm/xterm) — v5.5.0 current stable, v6.0.0 available (HIGH confidence)
- [react-xtermjs npm](https://www.npmjs.com/package/react-xtermjs) — v1.0.9 by Qovery (HIGH confidence)
- [Tokio process docs](https://docs.rs/tokio/latest/tokio/process/index.html) — async subprocess API (HIGH confidence)
- [OpenAI Codex CLI docs](https://developers.openai.com/codex/cli/) — exec/app-server modes (MEDIUM confidence — relatively new)
- [tauri-global-state-management example](https://github.com/robosushie/tauri-global-state-management) — Zustand + Rust State pattern (MEDIUM confidence)

---

*Stack research for: WhaleCode — AI coding tool orchestration macOS desktop app*
*Researched: 2026-03-05*
