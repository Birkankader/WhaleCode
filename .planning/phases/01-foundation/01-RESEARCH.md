# Phase 1: Foundation - Research

**Researched:** 2026-03-05
**Domain:** Tauri v2 desktop app scaffolding, Rust IPC channels, React frontend with streaming terminal output
**Confidence:** HIGH

## Summary

Phase 1 establishes the complete application scaffold for WhaleCode: a Tauri v2 desktop window with a Rust backend managing shared state and a React+TypeScript frontend displaying streaming terminal output. All decisions were pre-locked by the CONTEXT.md discussion phase, so this research focuses on verifying those decisions and filling in implementation-level specifics that the planner needs.

The stack is well-established and production-ready. `create-tauri-app` with the React+TypeScript+Vite template is the canonical starting point. `tauri-specta 2.x` (currently at RC stage, stable for use with locked versions) provides type-safe IPC bindings from day one. The `tauri::ipc::Channel` API (not the event system) is the correct streaming mechanism for subprocess output. xterm.js 5.x + react-xtermjs is the correct terminal renderer.

**Primary recommendation:** Bootstrap with `npm create tauri-app@latest`, select React + TypeScript, then layer in tauri-specta, Zustand, Tailwind 4.x, shadcn/ui, and @xterm/xterm 5.x in that order. Wire the Channel pipeline before any UI polish — it is the hardest integration and must work before Phase 2 starts.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**App Shell Layout**
- Single-window app with sidebar + main content area
- Sidebar: navigation for future tool panels (placeholder for now)
- Main area: streaming output console (xterm.js terminal) — this is the primary view in Phase 1
- Dark theme by default — coding tools are used in dark environments
- Window title: "WhaleCode"
- Minimum window size: 800x600

**Project Structure**
- Monorepo: `src-tauri/` (Rust backend) + `src/` (React frontend)
- Use `create-tauri-app` with React + TypeScript + Vite template as starting point
- tauri-specta for type-safe IPC from day one — no manual TypeScript type definitions for commands
- Frontend state: Zustand for ephemeral UI state (tool panels, sidebar collapse, etc.)
- Styling: Tailwind CSS 4.x + shadcn/ui components

**Rust Backend Architecture**
- AppState struct with `std::sync::Mutex` (not tokio::sync::Mutex) — research confirmed this
- AppState contains: task registry (`HashMap<TaskId, TaskInfo>`), process registry (`Vec<Child>` for cleanup)
- Use `tauri::async_runtime::spawn()` for async work — never block in command handlers
- `RunEvent::Exit` hook for process cleanup — verified zombie-free shutdown
- Do NOT use `#[tokio::main]` — conflicts with Tauri's internal runtime

**IPC Streaming Pipeline**
- Use `tauri::Channel<OutputEvent>` for streaming subprocess output to frontend
- OutputEvent enum: `{ Stdout(String), Stderr(String), Exit(i32), Error(String) }`
- One channel per future tool task — not a single shared channel
- Frontend subscribes to channel via tauri-specta generated bindings
- Batch output in 100-500ms windows to prevent IPC bottleneck

**Terminal Output Console**
- @xterm/xterm 5.5.0 with react-xtermjs wrapper
- Single terminal panel for Phase 1 — will split into per-tool panels in Phase 2
- Show timestamped output lines
- Support ANSI color codes from CLI output
- Scrollback buffer: 10,000 lines

### Claude's Discretion
- Exact sidebar width and collapse behavior
- Font choices and spacing
- Error boundary implementation details
- Dev tooling setup (ESLint, Prettier config)
- Exact Vite configuration

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope (decisions made autonomously based on research findings)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| FOUN-01 | App launches as native macOS window with Tauri v2 shell | Covered by create-tauri-app scaffold + tauri.conf.json window config (minWidth, minHeight, title) |
| FOUN-02 | Rust backend initializes with managed AppState and IPC channels | Covered by AppState + Mutex pattern, tauri::Channel API, RunEvent::Exit hook |
| FOUN-03 | Frontend renders React app with routing and base layout | Covered by React Router v7, Zustand store, xterm.js terminal component, Tailwind+shadcn layout |
</phase_requirements>

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| tauri | 2.10.x | Desktop app runtime, Rust+WebView bridge | Official Tauri v2 stable — all other tools depend on this version |
| tauri-build | 2.10.x | Build-time code generation | Must match tauri minor version exactly — mismatch causes build failures |
| @tauri-apps/api | 2.x | Frontend JS bindings to Tauri runtime | Official JS SDK, provides Channel, invoke, event APIs |
| tauri-specta | =2.0.0-rc.21 | Type-safe IPC: generates TypeScript bindings from Rust command signatures | Eliminates manual TypeScript type definitions; must be pinned with `=` prefix to avoid RC breakage |
| specta | =2.0.0-rc.x | Type reflection macro system (tauri-specta dependency) | Required peer for tauri-specta |
| react | 19.x | UI framework | Official Tauri template default |
| react-dom | 19.x | DOM renderer | Paired with react |
| react-router | 7.x | Client-side routing | V7 is non-breaking upgrade from V6; better TypeScript support |
| zustand | 5.x | Ephemeral UI state management | Lightweight, no-provider API, ideal for sidebar/panel state |
| @xterm/xterm | 5.5.0 | Terminal emulator | ANSI color, scrollback, xterm standard |
| react-xtermjs | 1.0.10 | React wrapper for xterm.js | Hook-based API, TypeScript support, latest April 2025 |
| @xterm/addon-fit | 0.10.0 | Resize terminal to container | Required for responsive layout |
| tailwindcss | 4.x | Utility CSS framework | No PostCSS required in v4, Vite plugin integration |
| @tailwindcss/vite | 4.x | Tailwind Vite plugin | Replaces postcss pipeline entirely in v4 |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| shadcn/ui | latest | Accessible component primitives | Sidebar, layout components, future dialog/tooltip |
| @types/node | latest | Node.js types for Vite config | Required for `path` module in vite.config.ts |
| vitest | latest | Unit/component test runner | Vite-native, mocks Tauri IPC |
| @testing-library/react | latest | React component testing | Render + user-event simulation |
| @tauri-apps/api/mocks | (bundled) | Mock Tauri invoke() in tests | Required for testing commands without actual Rust backend |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| tauri-specta | Manual TypeScript types | Manual types drift as Rust changes; specta enforces sync |
| tauri::Channel | Tauri global events (emit/listen) | Events have no ordering guarantee and are slower for high-rate data; Channel is purpose-built for streaming |
| std::sync::Mutex | tokio::sync::Mutex | tokio Mutex requires .await to lock; cannot hold across sync code; std Mutex is simpler and correct unless holding lock across .await points |
| react-xtermjs | Raw xterm.js Terminal class | react-xtermjs saves lifecycle wiring boilerplate; both work equally well |
| Zustand | Context API / Redux | Zustand has no provider overhead; ideal for 2-3 small stores |
| Tailwind 4.x | Tailwind 3.x | v4 has no PostCSS config requirement, faster builds, Vite plugin |

**Installation:**
```bash
# Frontend dependencies
npm install react-router zustand @xterm/xterm react-xtermjs @xterm/addon-fit
npm install -D vitest @testing-library/react @testing-library/user-event @types/node

# Tailwind + shadcn
npm install tailwindcss @tailwindcss/vite
npx shadcn@latest init

# Rust (Cargo.toml)
# tauri = { version = "=2.10.x", features = ["macos-private-api"] }
# tauri-specta = { version = "=2.0.0-rc.21", features = ["derive", "typescript"] }
# specta-typescript = "0.0.7"
# serde = { version = "1", features = ["derive"] }
```

---

## Architecture Patterns

### Recommended Project Structure
```
WhaleCode/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs          # Entry point — builds Tauri app, no logic
│   │   ├── lib.rs           # App builder, command registration, RunEvent handler
│   │   ├── state.rs         # AppState struct, TaskId type alias, TaskInfo
│   │   ├── commands/
│   │   │   └── mod.rs       # All #[tauri::command] fns, re-exports
│   │   └── ipc/
│   │       └── events.rs    # OutputEvent enum definition
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/
│   ├── main.tsx             # React entry — createRoot
│   ├── App.tsx              # Router + layout shell
│   ├── routes/
│   │   └── index.tsx        # Route definitions
│   ├── components/
│   │   ├── layout/
│   │   │   ├── AppShell.tsx # Sidebar + main content wrapper
│   │   │   └── Sidebar.tsx  # Placeholder nav
│   │   └── terminal/
│   │       └── OutputConsole.tsx  # xterm.js terminal component
│   ├── stores/
│   │   └── uiStore.ts       # Zustand: sidebar collapse, panel state
│   ├── bindings.ts          # Auto-generated by tauri-specta (gitignored in CI)
│   └── index.css            # @import "tailwindcss"
├── vite.config.ts
├── tsconfig.json
└── tsconfig.app.json
```

### Pattern 1: AppState with Mutex
**What:** Wrap all mutable backend state in `std::sync::Mutex`; let Tauri manage Arc.
**When to use:** All shared mutable state accessed from multiple commands.
**Example:**
```rust
// Source: https://v2.tauri.app/develop/state-management/
use std::sync::Mutex;
use std::collections::HashMap;
use tauri::{Builder, Manager};

type TaskId = String;

#[derive(Debug)]
struct TaskInfo {
    description: String,
}

#[derive(Default)]
struct AppStateInner {
    tasks: HashMap<TaskId, TaskInfo>,
    // Vec<Child> added in Phase 2 when process spawning is introduced
}

type AppState = Mutex<AppStateInner>;

fn main() {
    Builder::default()
        .setup(|app| {
            app.manage(AppState::default());
            Ok(())
        })
        .run(tauri::generate_context!())
        .unwrap();
}
```

### Pattern 2: tauri::Channel for Streaming Output
**What:** Pass a `Channel<OutputEvent>` as a command parameter; Rust sends events; frontend receives ordered stream.
**When to use:** Any streaming data from Rust to frontend (subprocess output, progress, logs).
**Example:**
```rust
// Source: https://v2.tauri.app/develop/calling-frontend/
use tauri::ipc::Channel;
use serde::Serialize;
use specta::Type;

#[derive(Clone, Serialize, Type)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
enum OutputEvent {
    Stdout(String),
    Stderr(String),
    Exit(i32),
    Error(String),
}

#[tauri::command]
#[specta::specta]
async fn start_stream(on_event: Channel<OutputEvent>) -> Result<(), String> {
    // Spawn async work — never block command handler thread
    tauri::async_runtime::spawn(async move {
        on_event.send(OutputEvent::Stdout("hello".to_string())).ok();
        on_event.send(OutputEvent::Exit(0)).ok();
    });
    Ok(())
}
```

Frontend usage (TypeScript, from generated bindings):
```typescript
// Source: https://v2.tauri.app/develop/calling-frontend/
import { Channel } from '@tauri-apps/api/core';
import * as commands from './bindings';

const channel = new Channel<OutputEvent>();
channel.onmessage = (msg) => {
    if (msg.event === 'stdout') {
        terminal.writeln(msg.data);
    }
};
await commands.startStream(channel);
```

### Pattern 3: tauri-specta Bindings Export
**What:** Annotate commands with `#[specta::specta]`; build exports TypeScript bindings on debug builds.
**When to use:** Every command visible to the frontend.
**Example:**
```rust
// Source: https://specta.dev/docs/tauri-specta/v2
use tauri_specta::{collect_commands, ts};

pub fn run() {
    let builder = ts::builder()
        .commands(collect_commands![start_stream, get_status]);

    #[cfg(debug_assertions)]
    let builder = builder.path("../src/bindings.ts");

    let specta_plugin = builder.build().unwrap();

    tauri::Builder::default()
        .plugin(specta_plugin)
        .invoke_handler(tauri::generate_handler![start_stream, get_status])
        // ...
}
```

### Pattern 4: RunEvent::Exit Cleanup Hook
**What:** Register exit handler to kill child processes before app terminates.
**When to use:** Phase 1 wires the hook even though no processes exist yet — required by Phase 2.
**Example:**
```rust
// Source: https://docs.rs/tauri/latest/tauri/enum.RunEvent.html
app.run(|app_handle, event| {
    if let tauri::RunEvent::Exit = event {
        // Phase 2 will populate: kill all child processes from AppState
        println!("App exiting cleanly");
    }
});
```

### Pattern 5: tauri.conf.json Window Configuration
```json
{
  "app": {
    "windows": [
      {
        "title": "WhaleCode",
        "width": 1200,
        "height": 800,
        "minWidth": 800,
        "minHeight": 600,
        "resizable": true
      }
    ]
  }
}
```
**Known issue (verified):** `minWidth` only works when `minHeight` is also set — both are required.

### Pattern 6: xterm.js Terminal Component
```typescript
// Source: https://github.com/Qovery/react-xtermjs
import { useXTerm } from 'react-xtermjs';
import { FitAddon } from '@xterm/addon-fit';
import { useEffect, useRef } from 'react';

export function OutputConsole() {
    const { instance, ref } = useXTerm({
        options: {
            scrollback: 10000,
            theme: {
                background: '#1a1a2e',
                foreground: '#e2e2e2',
            },
            convertEol: true,   // Convert \n to \r\n for proper line breaks
            fontFamily: 'monospace',
        }
    });
    const fitAddon = useRef(new FitAddon());

    useEffect(() => {
        if (instance) {
            instance.loadAddon(fitAddon.current);
            fitAddon.current.fit();
        }
    }, [instance]);

    // Fit on container resize
    useEffect(() => {
        const observer = new ResizeObserver(() => fitAddon.current?.fit());
        if (ref.current) observer.observe(ref.current);
        return () => observer.disconnect();
    }, [ref]);

    return <div ref={ref} style={{ width: '100%', height: '100%' }} />;
}
```

### Pattern 7: Tailwind 4.x + shadcn/ui Setup
```typescript
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: { '@': path.resolve(__dirname, './src') },
    },
    // Required for Tauri: disable default port to use Tauri's devserver
    server: { port: 1420, strictPort: true },
})
```

```css
/* src/index.css */
@import "tailwindcss";
```

shadcn/ui init (run after Tailwind):
```bash
npx shadcn@latest init
```

### Anti-Patterns to Avoid
- **Multiple `invoke_handler!` calls:** Only the last one is used. Always pass ALL commands in a single `tauri::generate_handler![cmd1, cmd2, ...]`.
- **Blocking in command handlers:** Never call `.await` on a long-running future directly in a command. Use `tauri::async_runtime::spawn()` and return immediately.
- **`#[tokio::main]` on fn main:** Creates a second Tokio runtime that conflicts with Tauri's internal runtime. Use Tauri's runtime via `tauri::async_runtime::spawn()` instead.
- **Forgetting `convertEol: true` in xterm:** CLI output uses `\n`; xterm needs `\r\n`. Without this, output renders as staircase pattern.
- **Missing both minWidth AND minHeight:** Setting only `minWidth` has no effect — both must be specified together.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| TypeScript types for Rust commands | Manual interface definitions | tauri-specta | Types drift silently when Rust changes; specta regenerates on every debug build |
| Terminal renderer | Custom `<pre>` or `<div>` with text | @xterm/xterm | ANSI escape code parsing, scrollback, selection, fonts — all edge-case hell |
| Terminal resize handling | Custom resize event listeners | @xterm/addon-fit + ResizeObserver | FitAddon handles row/col calculation correctly; DIY gets font metrics wrong |
| React state boilerplate | Context.Provider + useReducer | Zustand | Provider-free, TypeScript-native, devtools support |
| CSS component system | Custom component CSS | shadcn/ui + Tailwind | Accessibility (keyboard nav, ARIA), dark mode, consistent tokens |
| IPC type marshalling | JSON.stringify/parse with manual validation | tauri-specta Channel types | Type safety end-to-end, no runtime cast errors |

**Key insight:** The terminal and IPC type system are the two areas where "just do it manually" leads to rewrite-level pain. Both have decades of edge cases that the libraries handle.

---

## Common Pitfalls

### Pitfall 1: tauri/tauri-build Version Mismatch
**What goes wrong:** Build fails with cryptic linker or codegen errors.
**Why it happens:** `tauri` and `tauri-build` must have matching minor versions. Using `tauri = "2"` and `tauri-build = "2"` will resolve to different patch versions after `cargo update`.
**How to avoid:** Pin both with exact versions: `tauri = "=2.10.x"` and `tauri-build = "=2.10.x"`.
**Warning signs:** Build errors mentioning ABI mismatch or unresolved symbols immediately after `cargo update`.

### Pitfall 2: tauri-specta RC Version Drift
**What goes wrong:** After `cargo update`, tauri-specta breaks because a newer RC changed the builder API.
**Why it happens:** tauri-specta 2.x is in RC; each RC has breaking changes (RC.12 had "completely new builder syntax").
**How to avoid:** Pin with `=` prefix: `tauri-specta = "=2.0.0-rc.21"`. Do not use `"^2.0.0-rc.21"`.
**Warning signs:** Compilation errors in tauri-specta macros after any `cargo update`.

### Pitfall 3: xterm.js Addon Version Mismatch
**What goes wrong:** Runtime TypeError from addon API incompatibility.
**Why it happens:** `@xterm/addon-fit` v0.10.0 expects the xterm 5.x internal API; using v0.9.x addon with 5.5.0 terminal fails at runtime.
**How to avoid:** All `@xterm/*` packages must be the same major version (5.x). Pin exact versions in package.json.
**Warning signs:** `TypeError: fitAddon.fit is not a function` or `Terminal.loadAddon` throws.

### Pitfall 4: #[tokio::main] Conflict
**What goes wrong:** App panics with "there is no reactor running, must be called from the context of a Tokio 1.x runtime".
**Why it happens:** `#[tokio::main]` creates its own Tokio runtime; Tauri creates another internally. The two runtimes conflict for I/O resources.
**How to avoid:** Never annotate `fn main()` with `#[tokio::main]`. Use `tauri::async_runtime::spawn()` for all async work.
**Warning signs:** Panic at startup with runtime message, or panic when emitting events in window listeners.

### Pitfall 5: IPC Flooding
**What goes wrong:** App becomes unresponsive when subprocess produces output at high rate (e.g., compilation output).
**Why it happens:** Sending one IPC message per stdout line at high rates (thousands/sec) overwhelms the WebView JS bridge.
**How to avoid:** Batch output server-side in 100-500ms windows using a Tokio interval. Accumulate lines in a `Vec<String>`, flush on interval tick.
**Warning signs:** Frontend freezes during high-output operations; xterm.js render queue backs up.

### Pitfall 6: xterm.js Line Ending Staircase
**What goes wrong:** Output renders as:
```
line1
     line2
          line3
```
**Why it happens:** CLI tools emit `\n`; xterm.js requires `\r\n` for carriage return.
**How to avoid:** Set `convertEol: true` in terminal options. This converts `\n` to `\r\n` automatically.
**Warning signs:** Output "staircase" visible immediately in first test event.

### Pitfall 7: Channel send() After Frontend Unmount
**What goes wrong:** Rust panics or silently fails after frontend navigates away.
**Why it happens:** `on_event.send()` returns an error if the Channel receiver has been dropped (component unmounted).
**How to avoid:** Always use `.ok()` instead of `.unwrap()` on `channel.send()`. Log errors at DEBUG level only.
**Warning signs:** `thread 'tokio-runtime-worker' panicked` in Rust logs after navigation.

### Pitfall 8: shadcn/ui with Tailwind v4 Compatibility
**What goes wrong:** shadcn components don't render styles correctly.
**Why it happens:** shadcn docs default to Tailwind v3 patterns; v4 changed the config system.
**How to avoid:** Use `npx shadcn@latest` (not `shadcn-ui`). When prompted, select Tailwind v4 config. Current shadcn v3.x+ supports Tailwind v4.
**Warning signs:** Components render without Tailwind styles; CSS variables for shadcn not applied.

---

## Code Examples

Verified patterns from official sources:

### Command Registration (single generate_handler! call required)
```rust
// Source: https://v2.tauri.app/develop/calling-rust/
tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
        start_stream,
        get_app_state,
        // ALL commands here — second call overrides first
    ])
    .run(tauri::generate_context!())
    .unwrap();
```

### Accessing State in Async Command
```rust
// Source: https://v2.tauri.app/develop/state-management/
#[tauri::command]
#[specta::specta]
async fn get_task_count(state: tauri::State<'_, AppState>) -> Result<usize, String> {
    let inner = state.lock().map_err(|e| e.to_string())?;
    Ok(inner.tasks.len())
}
```

### Vitest Setup for Tauri Mocking
```typescript
// Source: https://v2.tauri.app/develop/tests/mocking/
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { randomFillSync } from "crypto";
import { beforeAll, afterEach, vi } from 'vitest';

beforeAll(() => {
    Object.defineProperty(window, 'crypto', {
        value: { getRandomValues: (buffer: any) => randomFillSync(buffer) },
    });
});

afterEach(() => {
    clearMocks();
});

// In test:
mockIPC((cmd, args) => {
    if (cmd === 'get_task_count') return 3;
});
```

### Zustand UI Store
```typescript
// Standard Zustand pattern for UI state
import { create } from 'zustand';

interface UIState {
    sidebarCollapsed: boolean;
    setSidebarCollapsed: (collapsed: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
    sidebarCollapsed: false,
    setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
}));
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Tauri events (emit/listen) for streaming | `tauri::ipc::Channel` | Tauri 2.0 (Oct 2024) | Ordered delivery, purpose-built for streaming, lower overhead |
| PostCSS pipeline for Tailwind | `@tailwindcss/vite` plugin | Tailwind 4.0 (2025) | Zero config, 5x faster full builds, 100x faster incremental |
| `tauri::Manager::emit_all()` for global events | `app_handle.emit()` / Channel | Tauri 2.0 | New emit() API; emit_all() deprecated |
| Tailwind v3 `tailwind.config.js` | CSS-first config via `@import "tailwindcss"` | Tailwind 4.0 | No JS config file needed |
| React Router v6 | React Router v7 | Nov 2024 | Non-breaking upgrade; better TypeScript; merged with Remix |
| `xterm` npm package | `@xterm/xterm` scoped package | xterm.js 5.x | Old package deprecated; all addons now `@xterm/*` |

**Deprecated/outdated:**
- `xterm` (unscoped npm package): Replaced by `@xterm/xterm`. Never install the old package.
- `xterm-addon-fit`: Replaced by `@xterm/addon-fit`. All addons moved to `@xterm/` scope.
- PostCSS Tailwind setup: Replaced by `@tailwindcss/vite` plugin in Tailwind 4.x.
- `tauri::Manager::emit_all()`: Deprecated in Tauri 2.0; use `app_handle.emit()`.
- `#[tokio::main]`: Never compatible with Tauri; use `tauri::async_runtime::spawn()`.

---

## Open Questions

1. **tauri-specta RC.21 + Tauri 2.10.x compatibility**
   - What we know: RC.21 temporarily required a git-patched Tauri for a specific bug (PR #12371). That PR may have shipped in Tauri 2.x by now.
   - What's unclear: Whether RC.21 works cleanly with Tauri 2.10.x from crates.io without a Cargo.toml patch override.
   - Recommendation: During Wave 0, run `cargo build` immediately after adding tauri-specta to validate. If compilation fails with specta-related errors, check GitHub issues for the latest compatible RC.

2. **xterm.js @xterm/addon-fit exact version for @xterm/xterm 5.5.0**
   - What we know: Both must be the same major (5.x). FitAddon 0.10.0 is the latest published.
   - What's unclear: Whether a newer FitAddon patch was released since April 2025.
   - Recommendation: Use `npm install @xterm/xterm@5.5.0 @xterm/addon-fit` and let npm resolve the compatible addon version. Lock with package-lock.json.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (latest) + @testing-library/react |
| Config file | `vite.config.ts` — vitest config inline (no separate file needed) |
| Quick run command | `npm run test -- --run` |
| Full suite command | `npm run test -- --run --reporter=verbose` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FOUN-01 | App window launches without error (macOS native) | smoke/manual | `npm run tauri dev` — visual check | ❌ Wave 0 |
| FOUN-02 | AppState initializes, IPC Channel pipeline works end-to-end | unit + integration | `npm run test -- --run src/tests/ipc.test.ts` | ❌ Wave 0 |
| FOUN-03 | React renders layout with sidebar + terminal, no console errors | component | `npm run test -- --run src/tests/AppShell.test.tsx` | ❌ Wave 0 |

**Note on FOUN-01:** Native window launch is not automatable without a Tauri E2E harness (WebDriver). This is verified manually in the success criteria check. The unit/component tests cover FOUN-02 and FOUN-03 programmatically.

### Sampling Rate
- **Per task commit:** `npm run test -- --run` (all unit/component tests, ~5 seconds)
- **Per wave merge:** `npm run test -- --run --reporter=verbose`
- **Phase gate:** Full suite green + manual `npm run tauri dev` smoke test before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/tests/ipc.test.ts` — covers FOUN-02: mock Channel send, verify OutputEvent types flow through
- [ ] `src/tests/AppShell.test.tsx` — covers FOUN-03: render AppShell, assert sidebar + terminal areas present
- [ ] `vitest.config.ts` or vitest block in `vite.config.ts` — test environment: jsdom, global setup for Tauri mocks
- [ ] `src/tests/setup.ts` — shared beforeAll for `window.crypto` polyfill (required by @tauri-apps/api/mocks)
- [ ] Framework install: `npm install -D vitest @testing-library/react @testing-library/user-event jsdom`

---

## Sources

### Primary (HIGH confidence)
- https://v2.tauri.app/develop/calling-frontend/ — Channel API, OutputEvent pattern, JS usage
- https://v2.tauri.app/develop/state-management/ — AppState + Mutex, command access patterns
- https://v2.tauri.app/develop/calling-rust/ — command definition, error handling, async patterns
- https://v2.tauri.app/learn/window-customization/ — tauri.conf.json window config syntax
- https://v2.tauri.app/start/create-project/ — create-tauri-app command and options
- https://v2.tauri.app/develop/tests/mocking/ — Vitest + mockIPC setup
- https://specta.dev/docs/tauri-specta/v2 — tauri-specta builder API, command registration
- https://ui.shadcn.com/docs/installation/vite — shadcn/ui + Tailwind 4 setup steps
- https://tailwindcss.com/blog/tailwindcss-v4 — Tailwind 4 Vite plugin, zero-config approach
- https://github.com/Qovery/react-xtermjs — react-xtermjs API, version 1.0.10
- https://xtermjs.org/docs/guides/using-addons/ — FitAddon usage, addon loading pattern

### Secondary (MEDIUM confidence)
- https://github.com/specta-rs/tauri-specta/releases — RC.21 release notes, breaking change history (RC.12 builder rewrite)
- https://github.com/tauri-apps/tauri/discussions/7146 — IPC rate limit reality check; batch-before-send recommendation
- https://github.com/tauri-apps/tauri/issues/13330 — #[tokio::main] conflict confirmation
- https://rfdonnelly.github.io/posts/tauri-async-rust-process/ — async Rust process with mpsc pattern
- https://github.com/tauri-apps/tauri/issues/7075 — minWidth requires minHeight bug confirmation

### Tertiary (LOW confidence — verify at implementation time)
- tauri-specta RC.21 + Tauri 2.10.x clean compatibility: unverified, needs first `cargo build` to confirm

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries verified via official docs, versions confirmed
- Architecture: HIGH — Channel API, AppState, and xterm patterns from official Tauri and xterm.js docs
- Pitfalls: HIGH — most pitfalls verified by official bug reports and GitHub issues
- tauri-specta RC version compatibility: MEDIUM — RC stability confirmed but exact patch compat with latest Tauri needs runtime check

**Research date:** 2026-03-05
**Valid until:** 2026-04-04 (30 days — stack is stable but tauri-specta RC may advance)
