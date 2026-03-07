# Phase 10: UI Polish & Bug Fixes - Research

**Researched:** 2026-03-07
**Domain:** React UI polish, resizable panels, conditional rendering, Codex CLI integration, session context
**Confidence:** HIGH

## Summary

Phase 10 is a polish phase covering six discrete improvements: (1) shrink and make the Active Worktrees panel resizable, (2) hide review buttons when no changes exist, (3) reuse session context across tasks until threshold, (4) fix Codex CLI integration, (5) remove dead Claude Code sidebar button, and (6) modernize the overall UI design.

The project already has shadcn/ui (v3.8.5 devDependency), Tailwind CSS 4, class-variance-authority, lucide-react, and radix-ui installed. The shadcn Resizable component wraps `react-resizable-panels` which is the standard solution. The sidebar has a vestigial "Claude Code" nav button that does nothing. The review banner in `index.tsx` correctly appears only when a task is in 'review' status, but the WorktreeStatus panel always renders with full height even when empty. Context injection currently fetches fresh context per task dispatch -- there is no session-level caching or threshold-based reuse.

**Primary recommendation:** Use shadcn's Resizable component for the worktree panel, apply conditional rendering guards on review/merge controls, add a context cache with TTL/task-count threshold in the Rust backend, verify Codex CLI command flags against current CLI version, remove the dead sidebar button, and apply consistent shadcn component patterns across the UI.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| POLISH-01 | Shrink and make Active Worktrees panel resizable | shadcn Resizable component (react-resizable-panels), collapsible panel pattern |
| POLISH-02 | Hide review buttons when no changes exist | Conditional rendering in DiffReview and index.tsx based on diff file count |
| POLISH-03 | Reuse session context across tasks until threshold | Backend PromptContext cache with TTL + task-count invalidation |
| POLISH-04 | Fix Codex CLI integration | Verify codex CLI flags, ensure dispatch_task routing works end-to-end |
| POLISH-05 | Remove dead Claude Code sidebar button | Delete nav button from Sidebar.tsx, keep Settings button |
| POLISH-06 | Modernize the overall UI design | Apply shadcn/ui components consistently, use CSS variables from index.css, dark mode by default |
</phase_requirements>

## Standard Stack

### Core (Already Installed)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| shadcn/ui | 3.8.5 (devDep) | UI component system | Already configured with new-york style, neutral base |
| radix-ui | 1.4.3 | Headless UI primitives | Already installed, shadcn dependency |
| lucide-react | 0.577.0 | Icons | Already installed, shadcn default icon library |
| class-variance-authority | 0.7.1 | Component variants | Already installed |
| tailwind-merge | 3.5.0 | Class merging | Already installed, `cn()` utility exists at `src/lib/utils.ts` |
| Tailwind CSS | 4.2.1 | Styling | Already installed with `@tailwindcss/vite` |
| tw-animate-css | 1.4.0 | Animations | Already installed as devDep |
| zustand | 5.0.11 | State management | Already used for taskStore, uiStore, processStore |

### New Dependencies Needed
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| react-resizable-panels | ^2.x or ^4.x | Resizable panel layouts | For POLISH-01 worktree panel resize |

**Note:** shadcn's Resizable component wraps `react-resizable-panels`. Adding it via `npx shadcn@latest add resizable` will install the dependency automatically.

### No Alternatives Needed
This phase uses only what's already in the project. No new architectural choices required.

**Installation:**
```bash
npx shadcn@latest add resizable
```

This adds `react-resizable-panels` to dependencies and creates `src/components/ui/resizable.tsx`.

## Architecture Patterns

### Current Layout Structure
```
AppShell
  Sidebar (w-56, optional via uiStore.sidebarCollapsed)
  main (flex-1)
    index.tsx Route
      Project dir bar (shrink-0)
      StatusPanel (shrink-0, conditional on tasks.size > 0)
      Review banner (shrink-0, conditional on reviewTask && !reviewTaskId)
      Main content (flex-1)
        DiffReview | ProcessPanel
      WorktreeStatus (shrink-0, conditional on projectDir)
```

### Pattern 1: Resizable Bottom Panel (POLISH-01)
**What:** Replace fixed WorktreeStatus with a collapsible/resizable panel at the bottom
**When to use:** When the worktree panel takes too much vertical space

The approach: wrap the main content area and worktree status in a vertical `ResizablePanelGroup`. The worktree panel gets a small default size (e.g., 20%), min size constraint, and collapsible behavior.

```typescript
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';

// In index.tsx, replace the fixed worktree section:
<ResizablePanelGroup direction="vertical">
  <ResizablePanel defaultSize={80} minSize={40}>
    {/* Main content: DiffReview or ProcessPanel */}
  </ResizablePanel>
  <ResizableHandle withHandle />
  <ResizablePanel
    defaultSize={20}
    minSize={10}
    maxSize={40}
    collapsible
    collapsedSize={0}
  >
    <WorktreeStatus projectDir={projectDir} />
  </ResizablePanel>
</ResizablePanelGroup>
```

### Pattern 2: Conditional Review Controls (POLISH-02)
**What:** Hide merge/discard buttons when diff has zero files
**When to use:** After DiffReview loads and finds no changes

Current state: The review banner in `index.tsx` already conditionally renders based on `reviewTask` status. But WorktreeStatus always shows merge/check-conflicts buttons even when worktrees are empty. Also, the DiffReview bottom bar always shows merge/discard even if no files exist.

Fix locations:
- `WorktreeStatus.tsx`: Hide merge/check-conflicts buttons when `worktrees.length === 0`
- `DiffReview.tsx`: Hide bottom action bar when `files.length === 0`
- `index.tsx`: The review banner already handles this correctly

### Pattern 3: Session Context Cache (POLISH-03)
**What:** Cache the PromptContext between task dispatches to avoid redundant DB queries
**When to use:** When multiple tasks are dispatched in quick succession on the same project

Current flow: `dispatch_task` in `router.rs` calls `build_prompt_context()` every single dispatch. This queries SQLite for recent events each time.

Recommended approach: Add a cached context to AppState with a timestamp and task count. Invalidate when:
- More than N minutes have elapsed (TTL, e.g., 5 minutes)
- More than M tasks have been dispatched since last cache (e.g., 3 tasks)
- The project_dir has changed

```rust
// In state.rs, add to AppStateInner:
pub struct CachedPromptContext {
    pub context: PromptContext,
    pub project_dir: String,
    pub cached_at: std::time::Instant,
    pub tasks_since_cache: u32,
}

// In dispatch_task, check cache before building:
let context = {
    let inner = state.lock().map_err(|e| e.to_string())?;
    if let Some(cached) = &inner.cached_prompt_context {
        if cached.project_dir == project_dir
            && cached.cached_at.elapsed().as_secs() < 300
            && cached.tasks_since_cache < 3
        {
            cached.context.clone()
        } else {
            // Cache miss, will rebuild below
            drop(inner);
            let fresh = build_prompt_context(&store, &project_dir)?;
            // Update cache...
            fresh
        }
    } else {
        drop(inner);
        let fresh = build_prompt_context(&store, &project_dir)?;
        fresh
    }
};
```

### Pattern 4: Sidebar Cleanup (POLISH-05)
**What:** Remove the dead "Claude Code" nav button from Sidebar.tsx
**When to use:** Immediate -- button does nothing

Current state: `Sidebar.tsx` line 17-20 has a non-functional "Claude Code" button in the nav area. It has no onClick handler and serves no purpose. Remove it.

### Pattern 5: Modern UI with shadcn (POLISH-06)
**What:** Replace raw Tailwind utility classes with shadcn components for consistency
**When to use:** For buttons, cards, inputs, badges across the app

Key areas to modernize:
- **Buttons:** Replace hand-styled `<button className="px-3 py-1.5 text-xs rounded bg-zinc-800...">` with shadcn `<Button variant="outline" size="sm">`
- **Cards:** Wrap panels like WorktreeStatus in shadcn Card components
- **Input:** Replace raw `<input className="...">` with shadcn Input
- **Badge:** Use shadcn Badge for status indicators
- **Dark mode:** App already uses zinc-950 bg. Apply `dark` class to root `<html>` element so shadcn dark theme CSS variables activate

Install commonly needed components:
```bash
npx shadcn@latest add button card input badge separator tooltip
```

### Anti-Patterns to Avoid
- **Don't restructure the layout hierarchy:** The current layout works. Only add resizability to the worktree panel, don't rearchitect everything.
- **Don't introduce new state management:** Use existing zustand stores. The context cache belongs in Rust's AppState, not in a new store.
- **Don't change IPC signatures:** The Codex fix should work within existing command signatures. Adding new IPC commands regenerates bindings.ts.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Resizable panels | Custom drag handlers with mouse events | shadcn Resizable / react-resizable-panels | Keyboard accessibility, edge cases, performance |
| Button variants | Per-component className strings | shadcn Button with variant prop | Consistency across the app |
| Dark mode theming | Hardcoded zinc-XXX everywhere | shadcn CSS variables (already in index.css) | Single source of truth |

## Common Pitfalls

### Pitfall 1: Resizable Panel Height in Flex Layout
**What goes wrong:** ResizablePanelGroup requires a defined height container. In a flex layout, if the parent doesn't have `h-full` or explicit height, panels collapse to 0.
**Why it happens:** CSS flex layout quirks -- `flex-1 min-h-0` is needed on the container.
**How to avoid:** Ensure the ResizablePanelGroup wrapper has explicit flex sizing. The current `<div className="flex-1 min-h-0">` pattern in index.tsx is correct -- use it as the ResizablePanelGroup container.
**Warning signs:** Panel renders but has 0 height, or panel doesn't resize.

### Pitfall 2: Shadcn Component Import Paths
**What goes wrong:** Importing from wrong path after shadcn add.
**Why it happens:** shadcn generates components in `src/components/ui/` but the project alias is `@/components/ui/`.
**How to avoid:** The project already has `@` alias configured in vite.config.ts (`resolve.alias: { '@': path.resolve(__dirname, './src') }`). Imports should use `@/components/ui/resizable`.

### Pitfall 3: Codex CLI Flag Compatibility
**What goes wrong:** Codex CLI may not support `--output-format stream-json` or `--full-auto` in all versions.
**Why it happens:** Codex CLI is less mature than Claude Code / Gemini CLI. Flags may have changed.
**How to avoid:** Test with locally installed Codex CLI version. The adapter code in `adapters/codex.rs` looks structurally correct but needs runtime validation.
**Warning signs:** Process exits immediately with non-zero code, or outputs non-JSON text.

### Pitfall 4: Context Cache Mutex Deadlock
**What goes wrong:** Holding AppState lock while calling `build_prompt_context` (which may also need state).
**Why it happens:** `build_prompt_context` uses ContextStore (separate managed state), not AppState. But if code accidentally holds the AppState lock across the call, deadlock occurs.
**How to avoid:** Check cache, drop lock, then build context if cache miss. Re-acquire lock only to update cache.

### Pitfall 5: Breaking Existing Review Flow
**What goes wrong:** Hiding review buttons too aggressively breaks the merge workflow.
**Why it happens:** Over-eager conditional rendering.
**How to avoid:** Only hide merge/discard in DiffReview when `files.length === 0`. Don't hide the review banner itself -- it already has correct guards. Don't hide buttons when diff is loading.

## Code Examples

### Adding shadcn Resizable to index.tsx
```typescript
// Source: shadcn/ui docs + project structure
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable';

// Replace the bottom worktree section in the route:
{projectDir && (
  <ResizablePanelGroup direction="vertical" className="flex-1 min-h-0">
    <ResizablePanel defaultSize={80} minSize={40}>
      {reviewTaskId && reviewBranchName && projectDir ? (
        <DiffReview ... />
      ) : (
        <ProcessPanel projectDir={projectDir} />
      )}
    </ResizablePanel>
    <ResizableHandle withHandle />
    <ResizablePanel defaultSize={20} minSize={8} maxSize={40} collapsible>
      <WorktreeStatus projectDir={projectDir} />
    </ResizablePanel>
  </ResizablePanelGroup>
)}
```

### Context Cache in Rust
```rust
// Source: project pattern from state.rs
use crate::prompt::models::PromptContext;

pub struct CachedPromptContext {
    pub context: PromptContext,
    pub project_dir: String,
    pub cached_at: std::time::Instant,
    pub tasks_since_cache: u32,
}

impl CachedPromptContext {
    const TTL_SECS: u64 = 300; // 5 minutes
    const MAX_TASKS: u32 = 3;

    pub fn is_valid(&self, project_dir: &str) -> bool {
        self.project_dir == project_dir
            && self.cached_at.elapsed().as_secs() < Self::TTL_SECS
            && self.tasks_since_cache < Self::MAX_TASKS
    }
}
```

### Removing Dead Sidebar Button
```typescript
// Before (Sidebar.tsx):
<nav className="flex-1 px-2">
  <button type="button" className="...">Claude Code</button>  // REMOVE THIS
</nav>

// After:
<nav className="flex-1 px-2">
  {/* Navigation items will be added as features grow */}
</nav>
```

### Conditional Review Controls
```typescript
// In DiffReview.tsx bottom bar, wrap with guard:
{files.length > 0 && (
  <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-t ...">
    {/* merge/discard buttons */}
  </div>
)}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| shadcn/ui v0 (add components) | shadcn v3+ CLI | 2025 | `npx shadcn@latest add` replaces `npx shadcn-ui@latest add` |
| react-resizable-panels v2 | react-resizable-panels v4 | Late 2025 | shadcn Resizable updated for v4 API |
| Tailwind CSS v3 | Tailwind CSS v4 | 2025 | `@import "tailwindcss"` replaces `@tailwind` directives (already done) |

## Open Questions

1. **Codex CLI current flag support**
   - What we know: The adapter uses `codex -p <prompt> --output-format stream-json --full-auto`. These flags are based on research from when the adapter was written.
   - What's unclear: Whether the user has Codex CLI installed, and whether current version supports these exact flags.
   - Recommendation: Test with `codex --help` during implementation. If flags have changed, update `adapters/codex.rs::build_command()`. The adapter architecture is correct -- only the flag strings may need updating.

2. **"Modernize the overall UI design" scope**
   - What we know: The user wants a more polished look. shadcn is already set up but not widely used in existing components.
   - What's unclear: How extensive the redesign should be (every component vs. key surfaces only).
   - Recommendation: Focus on high-visibility surfaces: Sidebar, ProcessPanel tab bar, task input area, WorktreeStatus card. Don't touch OutputConsole/xterm styling or DiffReview internals -- those work fine.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.0.18 (frontend), cargo test (Rust backend) |
| Config file | vite.config.ts (test section), Cargo.toml |
| Quick run command | `cd src-tauri && cargo test --lib -- codex 2>&1 \| head -30` |
| Full suite command | `cd src-tauri && cargo test 2>&1` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| POLISH-01 | Worktree panel is resizable | manual-only | Visual: resize handle visible and functional | N/A |
| POLISH-02 | Review buttons hidden when no changes | manual-only | Visual: empty diff shows no action bar | N/A |
| POLISH-03 | Context cache reuses across tasks | unit | `cd src-tauri && cargo test cached_prompt` | Wave 0 |
| POLISH-04 | Codex CLI dispatches correctly | unit | `cd src-tauri && cargo test -- codex` | Exists (27 tests) |
| POLISH-05 | Dead sidebar button removed | unit | `npx vitest run src/tests/AppShell.test.tsx` | Exists |
| POLISH-06 | UI uses shadcn components | manual-only | Visual: consistent button/card styling | N/A |

### Sampling Rate
- **Per task commit:** `cd src-tauri && cargo test --lib 2>&1 | tail -5`
- **Per wave merge:** `cd src-tauri && cargo test 2>&1`
- **Phase gate:** Full Rust test suite green + visual inspection of all 6 requirements

### Wave 0 Gaps
- [ ] `src-tauri/src/state.rs` -- add CachedPromptContext struct and tests for cache validity
- [ ] Manual test checklist for visual requirements (POLISH-01, 02, 06)

## Sources

### Primary (HIGH confidence)
- Project source code: `src/routes/index.tsx`, `src/components/layout/Sidebar.tsx`, `src/components/WorktreeStatus.tsx`, `src/components/review/DiffReview.tsx`, `src-tauri/src/commands/router.rs`, `src-tauri/src/adapters/codex.rs`
- [shadcn/ui Resizable docs](https://ui.shadcn.com/docs/components/radix/resizable) - resizable panel component
- [react-resizable-panels](https://github.com/bvaughn/react-resizable-panels) - underlying library

### Secondary (MEDIUM confidence)
- Project `package.json` and `components.json` for dependency and shadcn configuration
- Project `index.css` for existing CSS variable system

### Tertiary (LOW confidence)
- Codex CLI flag support -- based on adapter code written during earlier phase, needs runtime validation

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all libraries already installed, only adding react-resizable-panels via shadcn
- Architecture: HIGH - patterns are straightforward conditional rendering, caching, and component removal
- Pitfalls: MEDIUM - Codex CLI compatibility is the main uncertainty; everything else is well-understood

**Research date:** 2026-03-07
**Valid until:** 2026-04-07 (stable domain, no fast-moving dependencies)
