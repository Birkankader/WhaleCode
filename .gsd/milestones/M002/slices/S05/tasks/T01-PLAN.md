---
estimated_steps: 4
estimated_files: 21
skills_used: []
---

# T01: Delete dead components, fix silent catches, replace jargon

**Slice:** S05 — UI Cleanup & Anti-Pattern Removal
**Milestone:** M002

## Description

Delete 16 unused component files that have zero external imports. Fix 2 silent `.catch(() => {})` calls that swallow errors without feedback. Replace 4 user-facing jargon strings with plain language. This task runs first because 3 of the dead components contain `onMouseEnter` handlers — removing them reduces T02's scope.

## Steps

1. Delete all 16 unused component files:
   - `src/components/layout/setup/ApiKeySetup.tsx`
   - `src/components/layout/setup/ProjectSetup.tsx`
   - `src/components/layout/StatusBar.tsx`
   - `src/components/orchestration/DecomposingBanner.tsx`
   - `src/components/orchestration/KanbanBoard.tsx`
   - `src/components/orchestration/MultiAgentOutput.tsx`
   - `src/components/prompt/PromptPreview.tsx`
   - `src/components/review/CodeReviewPanel.tsx`
   - `src/components/shared/AgentBadge.tsx`
   - `src/components/shared/Skeleton.tsx`
   - `src/components/shared/TaskTemplates.tsx`
   - `src/components/status/StatusPanel.tsx`
   - `src/components/terminal/DeveloperTerminal.tsx`
   - `src/components/terminal/ProcessPanel.tsx`
   - `src/components/usage/UsagePanel.tsx`
   - `src/components/views/KanbanView.tsx`

2. Fix silent catches:
   - `src/components/terminal/OutputConsole.tsx` (~line 94): Replace `.catch(() => {})` with `.catch((err) => console.warn('startStream failed:', err))`
   - `src/components/shared/SessionHistory.tsx` (~line 42): Replace `.catch(() => {})` with `.catch((err) => console.warn('Failed to load orchestration history:', err))`

3. Replace user-facing jargon:
   - `src/components/layout/SetupPanel.tsx` (~line 514): "Merge worktree branches automatically" → "Merge worker changes automatically"
   - `src/components/shared/OnboardingWizard.tsx` (~line 220): "Dispatch a quick task" → "Start a quick task"
   - `src/components/layout/QuickTaskPopover.tsx` (~line 65): `toast.success('Task dispatched'` → `toast.success('Task started'`
   - `src/components/layout/QuickTaskPopover.tsx` (~line 69): `New task dispatched:` → `Task started:`

4. Run verification: `npx tsc --noEmit` and `npx vitest run`. Confirm 0 broken imports and 94/94 tests.

## Must-Haves

- [ ] All 16 dead component files deleted
- [ ] No remaining imports of deleted components anywhere in `src/`
- [ ] 2 silent `.catch(() => {})` replaced with `console.warn` logging
- [ ] 4 jargon strings replaced with user-friendly language
- [ ] `npx tsc --noEmit` passes with 0 errors
- [ ] `npx vitest run` passes (94/94)

## Verification

- `npx tsc --noEmit` — 0 errors
- `npx vitest run` — 94/94 pass
- `rg -l "ApiKeySetup|ProjectSetup|StatusBar|DecomposingBanner|KanbanBoard|MultiAgentOutput|PromptPreview|CodeReviewPanel|AgentBadge|Skeleton|TaskTemplates|StatusPanel|DeveloperTerminal|ProcessPanel|UsagePanel|KanbanView" src/ --glob '*.tsx' --glob '*.ts'` — 0 matches
- `rg "\.catch\(\(\)\s*=>\s*\{\s*\}\)" src/ --glob '*.tsx' --glob '*.ts'` — only intentional fire-and-forget in `src/routes/index.tsx` (if any)
- `rg "useShallow" src/components/ | wc -l` — 22 (was 30, minus 8 from 4 deleted components with useShallow import+usage pairs)

## Inputs

- `src/components/layout/setup/ApiKeySetup.tsx` — dead component to delete
- `src/components/layout/setup/ProjectSetup.tsx` — dead component to delete
- `src/components/layout/StatusBar.tsx` — dead component to delete
- `src/components/orchestration/DecomposingBanner.tsx` — dead component to delete
- `src/components/orchestration/KanbanBoard.tsx` — dead component to delete
- `src/components/orchestration/MultiAgentOutput.tsx` — dead component to delete
- `src/components/prompt/PromptPreview.tsx` — dead component to delete
- `src/components/review/CodeReviewPanel.tsx` — dead component to delete
- `src/components/shared/AgentBadge.tsx` — dead component to delete
- `src/components/shared/Skeleton.tsx` — dead component to delete
- `src/components/shared/TaskTemplates.tsx` — dead component to delete
- `src/components/status/StatusPanel.tsx` — dead component to delete
- `src/components/terminal/DeveloperTerminal.tsx` — dead component to delete
- `src/components/terminal/ProcessPanel.tsx` — dead component to delete
- `src/components/usage/UsagePanel.tsx` — dead component to delete
- `src/components/views/KanbanView.tsx` — dead component to delete
- `src/components/terminal/OutputConsole.tsx` — silent catch to fix
- `src/components/shared/SessionHistory.tsx` — silent catch to fix
- `src/components/layout/SetupPanel.tsx` — jargon to replace
- `src/components/shared/OnboardingWizard.tsx` — jargon to replace
- `src/components/layout/QuickTaskPopover.tsx` — jargon to replace

## Expected Output

- `src/components/terminal/OutputConsole.tsx` — silent catch replaced with console.warn
- `src/components/shared/SessionHistory.tsx` — silent catch replaced with console.warn
- `src/components/layout/SetupPanel.tsx` — jargon replaced
- `src/components/shared/OnboardingWizard.tsx` — jargon replaced
- `src/components/layout/QuickTaskPopover.tsx` — jargon replaced
