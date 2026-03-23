---
id: T01
parent: S05
milestone: M002
provides:
  - 16 dead component files removed from codebase
  - Silent error swallowing replaced with console.warn logging
  - User-facing jargon replaced with plain language
key_files:
  - src/components/terminal/OutputConsole.tsx
  - src/components/shared/SessionHistory.tsx
  - src/components/layout/SetupPanel.tsx
  - src/components/shared/OnboardingWizard.tsx
  - src/components/layout/QuickTaskPopover.tsx
key_decisions:
  - none
patterns_established:
  - none
observability_surfaces:
  - console.warn('startStream failed:', err) in OutputConsole — surfaces stream initialization failures previously swallowed
  - console.warn('Failed to load orchestration history:', err) in SessionHistory — surfaces history-load failures previously swallowed
duration: 4m
verification_result: passed
completed_at: 2026-03-23
blocker_discovered: false
---

# T01: Delete dead components, fix silent catches, replace jargon

**Deleted 16 unused component files, replaced 2 silent .catch(() => {}) with console.warn logging, and replaced 4 user-facing jargon strings with plain language**

## What Happened

Deleted all 16 dead component files that had zero external imports — confirmed via `rg` before deletion. Fixed 2 silent `.catch(() => {})` calls in OutputConsole.tsx and SessionHistory.tsx with descriptive `console.warn` messages. Replaced 4 jargon strings: "Merge worktree branches automatically" → "Merge worker changes automatically", "Dispatch a quick task to any agent" → "Start a quick task with any agent", "Task dispatched" → "Task started", "New task dispatched:" → "Task started:".

The planner's exact strings for OnboardingWizard and QuickTaskPopover were slightly off (e.g., "Dispatch a quick task" vs actual "Dispatch a quick task to any agent"), but the intent was clear and I matched the real content.

## Verification

- `npx tsc --noEmit` — 0 errors
- `npx vitest run` — 94/94 pass
- Dead import check: `rg -l "import.*(ApiKeySetup|ProjectSetup|...)" src/` — 0 matches
- Silent catch check: `rg "\.catch\(\(\)\s*=>\s*\{\s*\}\)" src/` — 0 matches
- `rg "useShallow" src/components/ | wc -l` — 22 (expected 22)
- Inline-style hover handlers still present in active components (10 matches) — that's T02 scope

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx tsc --noEmit` | 0 | ✅ pass | 12.6s |
| 2 | `npx vitest run` | 0 | ✅ pass | 12.6s |
| 3 | `rg -l "import.*(ApiKeySetup\|...)" src/ --glob '*.tsx' --glob '*.ts'` | 1 | ✅ pass (0 matches) | <1s |
| 4 | `rg "\.catch\(\(\)\s*=>\s*\{\s*\}\)" src/ --glob '*.tsx' --glob '*.ts'` | 1 | ✅ pass (0 matches) | <1s |
| 5 | `rg "useShallow" src/components/ \| wc -l` | 0 | ✅ pass (22) | <1s |

## Diagnostics

- `console.warn('startStream failed:', ...)` in OutputConsole — grep for "startStream failed" in browser devtools to see stream init errors
- `console.warn('Failed to load orchestration history:', ...)` in SessionHistory — grep for "Failed to load orchestration history" in browser devtools

## Deviations

- OnboardingWizard jargon string was "Dispatch a quick task to any agent" not "Dispatch a quick task" — replaced with "Start a quick task with any agent" to preserve the "with any agent" qualifier.

## Known Issues

None.

## Files Created/Modified

- `src/components/layout/setup/ApiKeySetup.tsx` — deleted (dead component)
- `src/components/layout/setup/ProjectSetup.tsx` — deleted (dead component)
- `src/components/layout/StatusBar.tsx` — deleted (dead component)
- `src/components/orchestration/DecomposingBanner.tsx` — deleted (dead component)
- `src/components/orchestration/KanbanBoard.tsx` — deleted (dead component)
- `src/components/orchestration/MultiAgentOutput.tsx` — deleted (dead component)
- `src/components/prompt/PromptPreview.tsx` — deleted (dead component)
- `src/components/review/CodeReviewPanel.tsx` — deleted (dead component)
- `src/components/shared/AgentBadge.tsx` — deleted (dead component)
- `src/components/shared/Skeleton.tsx` — deleted (dead component)
- `src/components/shared/TaskTemplates.tsx` — deleted (dead component)
- `src/components/status/StatusPanel.tsx` — deleted (dead component)
- `src/components/terminal/DeveloperTerminal.tsx` — deleted (dead component)
- `src/components/terminal/ProcessPanel.tsx` — deleted (dead component)
- `src/components/usage/UsagePanel.tsx` — deleted (dead component)
- `src/components/views/KanbanView.tsx` — deleted (dead component)
- `src/components/terminal/OutputConsole.tsx` — silent catch replaced with console.warn
- `src/components/shared/SessionHistory.tsx` — silent catch replaced with console.warn
- `src/components/layout/SetupPanel.tsx` — jargon replaced
- `src/components/shared/OnboardingWizard.tsx` — jargon replaced
- `src/components/layout/QuickTaskPopover.tsx` — jargon replaced (2 strings)
