---
estimated_steps: 4
estimated_files: 8
skills_used: []
---

# T02: Replace inline-style hover handlers with Tailwind classes

**Slice:** S05 — UI Cleanup & Anti-Pattern Removal
**Milestone:** M002

## Description

Replace all `onMouseEnter`/`onMouseLeave` handlers that manipulate `e.currentTarget.style.*` with Tailwind `hover:` utility classes across 8 active component files. Conditional hovers (gated behind loading/progress states) use `cn()` from `@/lib/utils` with conditional class strings. This eliminates the React anti-pattern of direct DOM manipulation for hover effects.

**Important constraints:**
- Do NOT touch `src/components/shared/CommandPalette.tsx` — its `onMouseEnter` sets `selectedIndex` (state logic, not style)
- Do NOT touch `src/components/layout/Sidebar.tsx` — its mouse handlers control delayed show/hide with timers (state logic, not style)
- Do NOT migrate non-hover `C.*` inline styles — only remove hover-specific `onMouseEnter`/`onMouseLeave` handlers
- The `C` object from `src/lib/theme.ts` is deprecated but still used for non-hover inline styles — that's fine, leave those

**Tailwind token reference (defined in `src/index.css` via `@theme inline`):**
- `--color-wc-surface-hover: #191926` → `hover:bg-wc-surface-hover`
- `--color-wc-accent` → `hover:bg-wc-accent`, `hover:border-wc-accent`
- `--color-wc-border-strong` → `hover:border-wc-border-strong`
- `--color-wc-text-secondary` → `hover:text-wc-text-secondary`
- `brightness(1.1)` / `brightness(1.15)` → `hover:brightness-110` (or `hover:brightness-[1.15]` for exact match)
- `rgba(99,102,241,0.15)` → `hover:bg-wc-accent/15`
- `rgba(239,68,68,0.2)` → `hover:bg-red-500/20`

**Pattern for conditional hovers:** Import `cn` from `@/lib/utils`. Use `className={cn(baseClasses, !disabledState && 'hover:brightness-110 transition-all')}` — the hover class is only applied when the condition is met.

## Steps

1. **TaskActions.tsx** (6 handler pairs, 4 conditional): Read the file. For each button element, remove the `onMouseEnter`/`onMouseLeave` props. Add equivalent `hover:` classes to the existing `className` or `style` converted to className. For the 4 conditional handlers (`!cancelling`, `!retrying`, `!diffLoading`, `!merging`), import `cn` and wrap the className with the condition. Add `transition-all duration-150` where missing.

2. **CodeReviewView.tsx** (3 handler pairs, 2 conditional): Remove style-based mouse handlers. Replace with `hover:bg-wc-surface-hover` (conditional on `!isHandled`), `hover:brightness-110` (conditional on `!mergeAllInProgress`), and unconditional `hover:brightness-110`. Import `cn` if not already imported.

3. **Remaining 6 files** (1 handler pair each, mostly unconditional):
   - `CodeView.tsx`: conditional on `!isSelected` — `hover:bg-wc-surface-hover`
   - `TaskHeader.tsx`: unconditional — `hover:border-wc-border-strong`
   - `DecompositionErrorCard.tsx`: multiple pairs — `hover:bg-wc-surface-hover`, `hover:brightness-110`, `hover:bg-wc-accent/15`, `hover:bg-red-500/20`
   - `StagePipeline.tsx`: unconditional — `hover:brightness-110`
   - `TerminalBottomPanel.tsx`: unconditional — `hover:bg-wc-accent`
   - `SetupPanel.tsx`: mixed — `hover:bg-wc-surface-hover`, `hover:brightness-110`

4. Run verification: `npx tsc --noEmit`, `npx vitest run`, and grep assertions for zero remaining style-based hover handlers. Confirm CommandPalette and Sidebar handlers are preserved.

## Must-Haves

- [ ] Zero `onMouseEnter`/`onMouseLeave` handlers that set `style.*` properties in active components
- [ ] Conditional hovers use `cn()` with state-dependent class inclusion
- [ ] `transition-colors` or `transition-all duration-150` present on all hover elements for smooth visual feedback
- [ ] CommandPalette and Sidebar mouse handlers untouched
- [ ] `npx tsc --noEmit` passes with 0 errors
- [ ] `npx vitest run` passes (94/94)

## Verification

- `npx tsc --noEmit` — 0 errors
- `npx vitest run` — 94/94 pass
- `rg "onMouseEnter.*style\.|onMouseLeave.*style\." src/components/ --glob '*.tsx'` — 0 matches
- `rg "onMouseEnter" src/components/shared/CommandPalette.tsx` — still present (preserved)
- `rg "onMouseEnter" src/components/layout/Sidebar.tsx` — still present (preserved)
- `rg "onMouseEnter|onMouseLeave" src/components/ --glob '*.tsx' -l` — only CommandPalette.tsx and Sidebar.tsx remain

## Inputs

- `src/components/views/task-detail/TaskActions.tsx` — file with 6 style-based hover handler pairs
- `src/components/views/CodeReviewView.tsx` — file with 3 style-based hover handler pairs
- `src/components/views/CodeView.tsx` — file with 1 conditional hover handler pair
- `src/components/views/task-detail/TaskHeader.tsx` — file with 1 hover handler pair
- `src/components/orchestration/DecompositionErrorCard.tsx` — file with 5 hover handler pairs
- `src/components/orchestration/StagePipeline.tsx` — file with 1 hover handler pair
- `src/components/terminal/TerminalBottomPanel.tsx` — file with 1 hover handler pair
- `src/components/layout/SetupPanel.tsx` — file with 3 hover handler pairs
- `src/lib/utils.ts` — `cn()` utility for conditional className merging
- `src/lib/theme.ts` — `C` object reference for mapping CSS values to Tailwind tokens

## Expected Output

- `src/components/views/task-detail/TaskActions.tsx` — hover handlers replaced with Tailwind classes
- `src/components/views/CodeReviewView.tsx` — hover handlers replaced with Tailwind classes
- `src/components/views/CodeView.tsx` — hover handler replaced with Tailwind class
- `src/components/views/task-detail/TaskHeader.tsx` — hover handler replaced with Tailwind class
- `src/components/orchestration/DecompositionErrorCard.tsx` — hover handlers replaced with Tailwind classes
- `src/components/orchestration/StagePipeline.tsx` — hover handler replaced with Tailwind class
- `src/components/terminal/TerminalBottomPanel.tsx` — hover handler replaced with Tailwind class
- `src/components/layout/SetupPanel.tsx` — hover handlers replaced with Tailwind classes

## Observability Impact

This task is a pure refactor of hover styling from imperative DOM manipulation to declarative CSS classes. No runtime behavior, state management, or error paths change. The key signals:

- **Inspection:** `rg "onMouseEnter|onMouseLeave" src/components/ --glob '*.tsx' -l` should only return CommandPalette.tsx and Sidebar.tsx (state-based handlers, not style).
- **Failure visibility:** If a hover class doesn't render correctly, it will be visible as a missing hover effect in the UI — no silent failure. Browser DevTools "Computed Styles" tab under `:hover` state shows whether Tailwind hover classes are applied.
- **No new runtime signals** — this is a compile-time/CSS change only.
