# S05: UI Cleanup & Anti-Pattern Removal

**Goal:** Remove dead code, replace DOM manipulation hover patterns with CSS/Tailwind, fix silent error swallowing, and replace user-facing jargon — leaving the UI codebase clean for S06 end-to-end verification.
**Demo:** `npx tsc --noEmit` passes, `npx vitest run` passes (94/94), zero inline-style hover handlers in active components, zero silent `.catch(() => {})` outside intentional fire-and-forget, zero references to deleted components.

## Must-Haves

- 16 unused component files deleted with no broken imports
- 2 silent `.catch(() => {})` calls replaced with `console.warn` or error state
- 4 user-facing jargon strings replaced with plain language
- All `onMouseEnter`/`onMouseLeave` inline style handlers in 8 active files replaced with Tailwind `hover:` classes
- Conditional hover handlers (gated behind `!cancelling`, `!merging`, etc.) use `cn()` with conditional class strings or `pointer-events-none`
- CommandPalette and Sidebar mouse handlers preserved (state logic, not style)

## Verification

- `npx tsc --noEmit` — 0 errors
- `npx vitest run` — 94/94 pass
- `rg "onMouseEnter.*style\.|onMouseLeave.*style\." src/components/ --glob '*.tsx'` — 0 matches
- `rg "\.catch\(\(\)\s*=>\s*\{\s*\}\)" src/ --glob '*.tsx' --glob '*.ts'` — 0 matches (routes/index.tsx fire-and-forget catches already have comments and won't match the empty-body pattern, or if they do, they are intentional)
- `rg -l "import.*(ApiKeySetup|ProjectSetup|StatusBar|DecomposingBanner|KanbanBoard|MultiAgentOutput|PromptPreview|CodeReviewPanel|AgentBadge|Skeleton|TaskTemplates|StatusPanel|DeveloperTerminal|ProcessPanel|UsagePanel|KanbanView)" src/ --glob '*.tsx' --glob '*.ts'` — 0 matches
- `rg "useShallow" src/components/ | wc -l` — 22 (dropped from 30 after deleting 4 components that had useShallow)

## Tasks

- [x] **T01: Delete dead components, fix silent catches, replace jargon** `est:25m`
  - Why: Reduces file count before hover migration (3 dead components have hover handlers), fixes silent error swallowing (R022), and replaces user-facing jargon (R023 support)
  - Files: 16 dead component files (deleted), `src/components/terminal/OutputConsole.tsx`, `src/components/shared/SessionHistory.tsx`, `src/components/layout/SetupPanel.tsx`, `src/components/shared/OnboardingWizard.tsx`, `src/components/layout/QuickTaskPopover.tsx`
  - Do: Delete all 16 unused component files. In OutputConsole.tsx, replace `.catch(() => {})` with `.catch((err) => console.warn('startStream failed:', err))`. In SessionHistory.tsx, replace `.catch(() => {})` with `.catch((err) => console.warn('Failed to load orchestration history:', err))`. Replace jargon: SetupPanel "Merge worktree branches automatically" → "Merge worker changes automatically", OnboardingWizard "Dispatch a quick task" → "Start a quick task", QuickTaskPopover "Task dispatched" → "Task started" (both occurrences: toast and activity log).
  - Verify: `npx tsc --noEmit` passes, `npx vitest run` passes (94/94), `rg -l "ApiKeySetup|KanbanBoard|StatusBar|DecomposingBanner" src/ --glob '*.tsx'` returns 0
  - Done when: 16 files deleted, 0 tsc errors, 94/94 tests pass, 0 silent catches outside routes/index.tsx

- [x] **T02: Replace inline-style hover handlers with Tailwind classes** `est:35m`
  - Why: Eliminates React anti-pattern of direct DOM manipulation via `e.currentTarget.style.*` in mouse handlers (R022). All 8 remaining active files with style-based hover handlers need migration to Tailwind `hover:` classes.
  - Files: `src/components/views/task-detail/TaskActions.tsx`, `src/components/views/CodeReviewView.tsx`, `src/components/views/CodeView.tsx`, `src/components/views/task-detail/TaskHeader.tsx`, `src/components/orchestration/DecompositionErrorCard.tsx`, `src/components/orchestration/StagePipeline.tsx`, `src/components/terminal/TerminalBottomPanel.tsx`, `src/components/layout/SetupPanel.tsx`
  - Do: For each file, remove `onMouseEnter`/`onMouseLeave` handlers that set `style.*` properties. Replace with equivalent Tailwind `hover:` utility classes. For unconditional hovers, add classes directly (e.g., `hover:bg-wc-surface-hover`, `hover:brightness-110`, `hover:border-wc-accent`). For conditional hovers (gated behind `!cancelling`, `!merging`, `!retrying`, `!diffLoading`, `!isHandled`, `!mergeAllInProgress`), import `cn` from `@/lib/utils` and use conditional className: `cn(base, !disabled && 'hover:brightness-110')`. Add `transition-colors` or `transition-all duration-150` where missing for smooth visual transitions. Do NOT touch CommandPalette or Sidebar mouse handlers (state logic, not style). Do NOT migrate non-hover `C.*` inline styles — only hover interactions.
  - Verify: `npx tsc --noEmit` passes, `npx vitest run` passes (94/94), `rg "onMouseEnter.*style\.|onMouseLeave.*style\." src/components/ --glob '*.tsx'` returns 0, `rg "onMouseEnter" src/components/shared/CommandPalette.tsx src/components/layout/Sidebar.tsx` still shows matches (preserved)
  - Done when: 0 inline-style hover handlers in active components, all conditional hovers use `cn()`, tsc clean, tests pass

## Files Likely Touched

- `src/components/layout/setup/ApiKeySetup.tsx` (deleted)
- `src/components/layout/setup/ProjectSetup.tsx` (deleted)
- `src/components/layout/StatusBar.tsx` (deleted)
- `src/components/orchestration/DecomposingBanner.tsx` (deleted)
- `src/components/orchestration/KanbanBoard.tsx` (deleted)
- `src/components/orchestration/MultiAgentOutput.tsx` (deleted)
- `src/components/prompt/PromptPreview.tsx` (deleted)
- `src/components/review/CodeReviewPanel.tsx` (deleted)
- `src/components/shared/AgentBadge.tsx` (deleted)
- `src/components/shared/Skeleton.tsx` (deleted)
- `src/components/shared/TaskTemplates.tsx` (deleted)
- `src/components/status/StatusPanel.tsx` (deleted)
- `src/components/terminal/DeveloperTerminal.tsx` (deleted)
- `src/components/terminal/ProcessPanel.tsx` (deleted)
- `src/components/usage/UsagePanel.tsx` (deleted)
- `src/components/views/KanbanView.tsx` (deleted)
- `src/components/terminal/OutputConsole.tsx` (silent catch fix)
- `src/components/shared/SessionHistory.tsx` (silent catch fix)
- `src/components/layout/SetupPanel.tsx` (jargon + hover)
- `src/components/shared/OnboardingWizard.tsx` (jargon)
- `src/components/layout/QuickTaskPopover.tsx` (jargon)
- `src/components/views/task-detail/TaskActions.tsx` (hover)
- `src/components/views/CodeReviewView.tsx` (hover)
- `src/components/views/CodeView.tsx` (hover)
- `src/components/views/task-detail/TaskHeader.tsx` (hover)
- `src/components/orchestration/DecompositionErrorCard.tsx` (hover)
- `src/components/orchestration/StagePipeline.tsx` (hover)
- `src/components/terminal/TerminalBottomPanel.tsx` (hover)

## Observability / Diagnostics

- **Silent error swallowing:** T01 replaced 2 silent `.catch(() => {})` with `console.warn` logging. Grep for `"startStream failed"` and `"Failed to load orchestration history"` in browser devtools to surface stream/history errors.
- **Hover migration inspection:** `rg "onMouseEnter|onMouseLeave" src/components/ --glob '*.tsx' -l` should only return CommandPalette.tsx and Sidebar.tsx (state-based handlers, not style). Any other match indicates a missed migration.
- **Dead code check:** `rg -l "import.*(ApiKeySetup|ProjectSetup|StatusBar|DecomposingBanner|KanbanBoard|MultiAgentOutput|PromptPreview|CodeReviewPanel|AgentBadge|Skeleton|TaskTemplates|StatusPanel|DeveloperTerminal|ProcessPanel|UsagePanel|KanbanView)" src/ --glob '*.tsx' --glob '*.ts'` — 0 matches confirms no dangling imports.
- **No new runtime signals** — this slice is a cleanup/refactor with no behavior changes outside improved error visibility.
