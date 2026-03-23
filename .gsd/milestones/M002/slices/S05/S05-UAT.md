# S05: UI Cleanup & Anti-Pattern Removal — UAT

## Preconditions

- WhaleCode project builds: `npx tsc --noEmit` exits 0
- Tests pass: `npx vitest run` reports 94/94
- Dev server running or able to start: `npm run tauri dev` (for visual checks)

---

## Test Case 1: Dead Component Files Removed

**Goal:** Confirm no deleted component files exist and no imports reference them.

**Steps:**

1. Run: `ls src/components/layout/setup/ApiKeySetup.tsx src/components/layout/setup/ProjectSetup.tsx src/components/layout/StatusBar.tsx src/components/orchestration/DecomposingBanner.tsx src/components/orchestration/KanbanBoard.tsx src/components/orchestration/MultiAgentOutput.tsx src/components/prompt/PromptPreview.tsx src/components/review/CodeReviewPanel.tsx src/components/shared/AgentBadge.tsx src/components/shared/Skeleton.tsx src/components/shared/TaskTemplates.tsx src/components/status/StatusPanel.tsx src/components/terminal/DeveloperTerminal.tsx src/components/terminal/ProcessPanel.tsx src/components/usage/UsagePanel.tsx src/components/views/KanbanView.tsx 2>&1`
   - **Expected:** Every path returns "No such file or directory"

2. Run: `rg -l "import.*(ApiKeySetup|ProjectSetup|StatusBar|DecomposingBanner|KanbanBoard|MultiAgentOutput|PromptPreview|CodeReviewPanel|AgentBadge|Skeleton|TaskTemplates|StatusPanel|DeveloperTerminal|ProcessPanel|UsagePanel|KanbanView)" src/ --glob '*.tsx' --glob '*.ts'`
   - **Expected:** 0 matches (exit code 1)

---

## Test Case 2: Silent Error Catches Replaced

**Goal:** Confirm no empty `.catch(() => {})` remain and replacements log useful context.

**Steps:**

1. Run: `rg "\.catch\(\(\)\s*=>\s*\{\s*\}\)" src/ --glob '*.tsx' --glob '*.ts'`
   - **Expected:** 0 matches

2. Run: `rg "startStream failed" src/components/terminal/OutputConsole.tsx`
   - **Expected:** 1 match showing `console.warn('startStream failed:', err)`

3. Run: `rg "Failed to load orchestration history" src/components/shared/SessionHistory.tsx`
   - **Expected:** 1 match showing `console.warn('Failed to load orchestration history:', err)`

4. (Visual, optional) Open the app, navigate to a session with terminal output. If `startStream` fails (e.g., invalid channel), check browser devtools console for "startStream failed:" warning with error details.

---

## Test Case 3: User-Facing Jargon Replaced

**Goal:** Confirm technical jargon has been replaced with plain language.

**Steps:**

1. Run: `rg "Merge worker changes automatically" src/components/layout/SetupPanel.tsx`
   - **Expected:** 1 match (was "Merge worktree branches automatically")

2. Run: `rg "Start a quick task" src/components/shared/OnboardingWizard.tsx`
   - **Expected:** 1 match (was "Dispatch a quick task")

3. Run: `rg "Task started" src/components/layout/QuickTaskPopover.tsx`
   - **Expected:** 2 matches — one in toast message, one in activity log (was "Task dispatched")

4. Run: `rg "worktree branches" src/components/layout/SetupPanel.tsx`
   - **Expected:** 0 matches (old jargon removed)

5. Run: `rg "Task dispatched" src/components/layout/QuickTaskPopover.tsx`
   - **Expected:** 0 matches (old jargon removed)

---

## Test Case 4: Inline-Style Hover Handlers Eliminated

**Goal:** Confirm no component uses `onMouseEnter`/`onMouseLeave` to set inline styles.

**Steps:**

1. Run: `rg "onMouseEnter.*style\.|onMouseLeave.*style\." src/components/ --glob '*.tsx'`
   - **Expected:** 0 matches

2. Run: `rg -l "onMouseEnter|onMouseLeave" src/components/ --glob '*.tsx'`
   - **Expected:** Exactly 2 files: `CommandPalette.tsx` and `Sidebar.tsx` (state-based handlers, not style)

3. Spot-check TaskActions.tsx: `rg "hover:" src/components/views/task-detail/TaskActions.tsx`
   - **Expected:** Multiple Tailwind hover: classes present (e.g., `hover:bg-`, `hover:brightness-`, `hover:border-`)

4. Spot-check CodeReviewView.tsx: `rg "cn(" src/components/views/CodeReviewView.tsx | head -5`
   - **Expected:** `cn()` calls with conditional hover classes (conditional on merge/discard state)

---

## Test Case 5: Conditional Hovers Use cn() Correctly

**Goal:** Confirm buttons with state-dependent hover behavior use `cn()` with conditional class strings, not inline style guards.

**Steps:**

1. Run: `rg "cn\(" src/components/views/CodeReviewView.tsx | grep -i "hover"`
   - **Expected:** At least 1 match showing conditional hover class (e.g., `!merging && 'hover:brightness-110'`)

2. Run: `rg "cn\(" src/components/views/task-detail/TaskActions.tsx | grep -i "hover"`
   - **Expected:** At least 1 match showing conditional hover class (e.g., `!cancelling && 'hover:...'`)

3. Run: `rg "pointer-events-none" src/components/views/CodeReviewView.tsx`
   - **Expected:** 0 or more matches — some conditional hovers may use pointer-events-none as an alternative to cn() conditionals

---

## Test Case 6: TypeScript and Test Suite Health

**Goal:** Confirm no regressions from the cleanup.

**Steps:**

1. Run: `npx tsc --noEmit`
   - **Expected:** Exit code 0, no output

2. Run: `npx vitest run`
   - **Expected:** 94/94 tests pass, 8 test files pass

3. Run: `rg "useShallow" src/components/ | wc -l`
   - **Expected:** 22 (dropped from 30 after deleting 4 dead components that had useShallow imports)

---

## Edge Cases

- **CommandPalette mouse handler:** `onMouseEnter={() => setSelectedIndex(idx)}` in CommandPalette.tsx must NOT be removed — it drives keyboard+mouse hybrid navigation
- **Sidebar tooltip handler:** `onMouseEnter`/`onMouseLeave` with timer in Sidebar.tsx must NOT be removed — it controls tooltip show/hide delay
- **routes/index.tsx fire-and-forget catches:** Any `.catch()` in routes/index.tsx for heartbeat/cleanup are intentional fire-and-forget patterns and should not be flagged
