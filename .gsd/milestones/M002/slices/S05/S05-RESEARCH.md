# S05: UI Cleanup & Anti-Pattern Removal — Research

**Date:** 2026-03-23
**Depth:** Light — all four cleanup categories use established patterns already in the codebase.

## Summary

S05 addresses R022 (dead code, DOM manipulation, silent catches, jargon) and supports R023 (user-friendly error text). The codebase has **16 unused components**, **27 inline-style mouse handler pairs** across 11 active files, **2 truly silent `.catch(() => {})`** calls, and a handful of user-facing jargon strings (mostly "worktree" and "dispatched"). All replacements follow patterns already established in the codebase — Tailwind `hover:` classes are already used in `DoneView.tsx`, `humanizeError` is already mature, and the CSS custom properties map 1:1 to Tailwind utility classes via `wc-*` tokens.

The work divides naturally into two independent tasks: (1) delete dead components + fix silent catches, (2) replace DOM manipulation hover handlers with Tailwind/CSS. Ordering matters: **delete dead code first** because 3 of the 16 unused components also contain `onMouseEnter` handlers — removing them first reduces the hover-fix scope from 11 files to 8.

## Recommendation

Two tasks, sequential: T01 deletes dead components and fixes silent catches + jargon. T02 replaces all inline-style mouse handlers with Tailwind hover classes. Both tasks are mechanical and low-risk. Verification is tsc + vitest + grep assertions.

## Implementation Landscape

### Key Files

**Dead components (16 files to delete):**
- `src/components/layout/setup/ApiKeySetup.tsx` — unused, superseded by SetupPanel
- `src/components/layout/setup/ProjectSetup.tsx` — unused, superseded by SetupPanel (also has onMouseEnter)
- `src/components/layout/StatusBar.tsx` — unused (has useShallow)
- `src/components/orchestration/DecomposingBanner.tsx` — unused (has useShallow + onMouseEnter)
- `src/components/orchestration/KanbanBoard.tsx` — unused (has useShallow)
- `src/components/orchestration/MultiAgentOutput.tsx` — unused
- `src/components/prompt/PromptPreview.tsx` — unused (has silent catch)
- `src/components/review/CodeReviewPanel.tsx` — unused
- `src/components/shared/AgentBadge.tsx` — unused
- `src/components/shared/Skeleton.tsx` — unused
- `src/components/shared/TaskTemplates.tsx` — unused
- `src/components/status/StatusPanel.tsx` — unused
- `src/components/terminal/DeveloperTerminal.tsx` — unused
- `src/components/terminal/ProcessPanel.tsx` — unused (has useShallow)
- `src/components/usage/UsagePanel.tsx` — unused
- `src/components/views/KanbanView.tsx` — unused (has useShallow + onMouseEnter)

Of these, 4 have `useShallow` (S03 artifact) — the `grep -r "useShallow" src/components/ | wc -l` count will drop from 30 to 22 after deletion. This is expected and correct.

**Silent catches (2 files):**
- `src/components/terminal/OutputConsole.tsx:94` — `commands.startStream(channel).catch(() => {})` — should log via `console.warn`
- `src/components/shared/SessionHistory.tsx:42` — `.catch(() => {})` on `getOrchestrationHistory` — should set an error state or `console.warn`

Note: `src/routes/index.tsx:40,80` also has `.catch(() => { /* fire-and-forget cleanup */ })` — these are intentional fire-and-forget for background cleanup. The comments explain why. Leave these alone.

**Inline-style mouse handlers (8 active files after dead code removal):**
- `src/components/views/task-detail/TaskActions.tsx` — 12 handlers (6 pairs), some conditional on `!cancelling`/`!merging`/`!retrying`
- `src/components/views/CodeReviewView.tsx` — 6 handlers (3 pairs), some conditional on `!mergeAllInProgress`/`!isHandled`
- `src/components/layout/SetupPanel.tsx` — 6 handlers (3 pairs)
- `src/components/views/CodeView.tsx` — 2 handlers (1 pair), conditional on `!isSelected`
- `src/components/views/task-detail/TaskHeader.tsx` — 2 handlers (1 pair)
- `src/components/terminal/TerminalBottomPanel.tsx` — 2 handlers (1 pair)
- `src/components/orchestration/StagePipeline.tsx` — 2 handlers (1 pair)
- `src/components/orchestration/DecompositionErrorCard.tsx` — 10 handlers (5 pairs)

**NOT to be changed (legitimate state-management handlers):**
- `src/components/shared/CommandPalette.tsx` — `onMouseEnter={() => setSelectedIndex(idx)}` — list selection, not style
- `src/components/layout/Sidebar.tsx` — `onMouseEnter/Leave` with timer for delayed show/hide — state logic, not style

**Hover replacement patterns (all proven in codebase):**
| Inline style | Tailwind replacement |
|---|---|
| `style.background = C.surfaceHover` / `= 'transparent'` | `hover:bg-wc-surface-hover` |
| `style.background = C.accent` / `= 'transparent'` | `hover:bg-wc-accent` |
| `style.filter = 'brightness(1.1)'` / `= 'brightness(1)'` | `hover:brightness-110` |
| `style.filter = 'brightness(1.15)'` / `= 'brightness(1)'` | `hover:brightness-110` (close enough, or `hover:brightness-[1.15]` for exact) |
| `style.borderColor = C.accent` | `hover:border-wc-accent` |
| `style.color = C.textSecondary` / `= C.textMuted` | `hover:text-wc-text-secondary` |
| Conditional (`if (!cancelling)`) | Use `disabled:pointer-events-none` or conditional className: `${!cancelling && 'hover:brightness-110'}` |
| `style.background = 'rgba(99,102,241,0.15)'` | `hover:bg-wc-accent/15` (Tailwind v4 opacity modifier) |
| `style.background = 'rgba(239,68,68,0.2)'` | `hover:bg-red-500/20` |

**Jargon replacements (minor, in active components):**
- `SetupPanel.tsx:514` — "Merge worktree branches automatically" → "Merge worker changes automatically"
- `QuickTaskPopover.tsx:65` — `toast.success('Task dispatched')` → "Task started"
- `TaskTemplates.tsx` is dead code (will be deleted)
- `OnboardingWizard.tsx:220` — "Dispatch a quick task" → "Start a quick task"

**`src/lib/humanizeError.ts`** — Already comprehensive (21 patterns). No new patterns needed for S05. The existing coverage satisfies R023 for all known error paths.

### Build Order

1. **T01: Dead code removal + silent catches + jargon** — Delete 16 unused component files. Fix 2 silent catches. Replace ~4 jargon strings. This is the foundation because it reduces the file count for T02 and removes overlap.
2. **T02: Hover handler migration** — Replace all `onMouseEnter`/`onMouseLeave` inline style handlers in the 8 remaining active files with Tailwind `hover:` classes. Add `transition-colors` / `transition-all` where missing for smooth transitions.

### Verification Approach

| Check | Command | Confirms |
|---|---|---|
| TypeScript compiles | `npx tsc --noEmit` | No broken imports from deleted files |
| Tests pass | `npx vitest run` | No behavioral regression (94/94 baseline) |
| No dead imports | `rg -r "import.*from.*(StatusBar\|KanbanBoard\|...)" src/` | Deleted components not referenced |
| No silent catches | `rg "\.catch\(\(\)\s*=>\s*\{\s*\}\)" src/ -g '*.tsx' -g '*.ts'` | Only intentional fire-and-forget remain (routes/index.tsx) |
| No inline style hovers | `rg "onMouseEnter.*style\.\|onMouseLeave.*style\." src/components/ -g '*.tsx'` | 0 matches |
| useShallow still correct | `rg "useShallow" src/components/ \| wc -l` | 22 (was 30, minus 8 from 4 deleted components) |
| Legitimate handlers preserved | `rg "onMouseEnter" src/components/shared/CommandPalette.tsx src/components/layout/Sidebar.tsx` | Still present |

## Constraints

- Tailwind v4.2.1 — uses `@theme inline` syntax, not `tailwind.config.js`. All `wc-*` tokens defined in `src/index.css`.
- `C` object in `src/lib/theme.ts` is marked `@deprecated` — new code should use Tailwind classes directly. Some elements still use `C.*` for non-hover inline styles (e.g., dynamic `background` in `style={{...}}`). T02 only replaces hover interactions; it does NOT migrate all `C.*` usage to Tailwind (that's a separate effort beyond R022 scope).
- Conditional hover handlers (e.g., `if (!cancelling) e.currentTarget.style.filter = ...`) need to become conditional classNames or use `disabled:pointer-events-none`. The pattern `className={cn(base, !disabled && 'hover:brightness-110')}` is clean.

## Common Pitfalls

- **Deleting a component that's actually lazy-loaded or re-exported** — Verified: all 16 candidates only appear in their own files. No dynamic imports, no barrel re-exports, no lazy() references.
- **useShallow grep count mismatch after deletion** — 4 dead components have useShallow. Post-deletion count drops from 30 to 22. Update any verification scripts/docs that assert specific counts.
- **Conditional hover handlers can't be pure CSS** — Elements where hover is disabled during loading states (e.g., `if (!cancelling)`) need a different approach than bare `hover:` classes. Use conditional className with `cn()` utility or `pointer-events-none` when disabled.
