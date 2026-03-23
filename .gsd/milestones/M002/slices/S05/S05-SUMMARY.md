# S05: UI Cleanup & Anti-Pattern Removal

---
id: S05
milestone: M002
outcome: success
tasks_completed: 2/2
duration: ~12m
requirements_validated: [R022]
requirements_supported: [R023]
---

## What This Slice Delivered

Removed 16 dead component files, eliminated all direct DOM manipulation hover patterns, fixed silent error swallowing, and replaced user-facing jargon — leaving the UI codebase clean for S06 end-to-end verification.

### T01: Dead code removal, silent catches, jargon

- **16 unused component files deleted** — confirmed zero external imports before deletion, zero dangling imports after
- **2 silent `.catch(() => {})` replaced** with `console.warn` in OutputConsole.tsx (`startStream failed`) and SessionHistory.tsx (`Failed to load orchestration history`)
- **4 jargon strings replaced** with plain language: "Merge worktree branches" → "Merge worker changes", "Dispatch a quick task" → "Start a quick task", "Task dispatched" → "Task started"

### T02: Inline-style hover handler migration

- **8 component files migrated** from `onMouseEnter`/`onMouseLeave` style manipulation to Tailwind `hover:` classes
- **Conditional hovers** (gated behind `!cancelling`, `!merging`, etc.) use `cn()` with state-dependent class strings
- **Base style properties moved** from inline `style` to Tailwind classes where hover needed to override them (K012 pattern)
- **CommandPalette and Sidebar** mouse handlers preserved — these are state logic, not style

## What S06 Should Know

- The UI codebase is clean: 0 dead component imports, 0 inline-style hover handlers, 0 silent catches, 22 useShallow selectors
- Only CommandPalette.tsx and Sidebar.tsx retain `onMouseEnter`/`onMouseLeave` — both are state-based (index selection, tooltip timer), not style manipulation
- `console.warn` logging surfaces stream init and history-load failures that were previously invisible — check browser devtools during E2E runs
- No behavioral changes in this slice — all changes are structural/cosmetic refactors

## Verification Results

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ 0 errors |
| `npx vitest run` | ✅ 94/94 pass |
| Inline-style hover grep | ✅ 0 matches |
| Silent catch grep | ✅ 0 matches |
| Dead import grep | ✅ 0 matches |
| useShallow count | ✅ 22 (expected) |
| CommandPalette/Sidebar handlers preserved | ✅ confirmed |

## Patterns Established

- **K012:** When replacing hover handlers with Tailwind, move base property values from inline `style` to Tailwind classes so `hover:` variants can override them — inline styles always win over CSS classes.

## Files Changed

**Deleted (16):** ApiKeySetup, ProjectSetup, StatusBar, DecomposingBanner, KanbanBoard, MultiAgentOutput, PromptPreview, CodeReviewPanel, AgentBadge, Skeleton, TaskTemplates, StatusPanel, DeveloperTerminal, ProcessPanel, UsagePanel, KanbanView

**Modified (13):** OutputConsole.tsx (catch fix), SessionHistory.tsx (catch fix), SetupPanel.tsx (jargon + hover), OnboardingWizard.tsx (jargon), QuickTaskPopover.tsx (jargon), TaskActions.tsx (hover), CodeReviewView.tsx (hover), CodeView.tsx (hover), TaskHeader.tsx (hover), DecompositionErrorCard.tsx (hover), StagePipeline.tsx (hover), TerminalBottomPanel.tsx (hover)

## Observability

- `console.warn('startStream failed:', err)` in OutputConsole — grep for "startStream failed" in browser devtools
- `console.warn('Failed to load orchestration history:', err)` in SessionHistory — grep for "Failed to load orchestration history"
- `rg "onMouseEnter|onMouseLeave" src/components/ --glob '*.tsx' -l` — only CommandPalette.tsx and Sidebar.tsx should match
