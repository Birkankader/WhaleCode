# UX flows

How users experience WhaleCode, step by step. Read this when building flow-level features (onboarding, approval, fail handling).

## The mental model

> WhaleCode is an AI-powered tech lead. Tell it what to build. It manages the team. You approve at critical moments.

If a feature or interaction weakens this metaphor, reshape it. Every flow should reinforce "I'm the lead reviewing my team's work."

## First launch

User opens WhaleCode for the first time.

1. **No splash screen.** Straight to the main canvas.
2. **Empty state is hero-sized:** centered prompt input reading "What should the team build?"
3. **Top bar shows detected master:** e.g., `Master: Claude Code ▾`. The arrow indicates it's clickable to change.
4. **If no agents detected:** inline setup guide appears instead of the input. Shows installation commands for Claude Code, Codex CLI, Gemini CLI with copy-to-clipboard buttons.
5. **Keyboard hints at bottom:** `⌘K Commands · ⌘H History · ⌘T Templates · ⌘,  Settings`
6. **Footer shows:** "3 agents ready · claude-code · gemini-cli · codex-cli · Last run: never"

## Task submission

User has an idea and starts typing.

1. User focuses the input (always focused by default on launch).
2. User types: `Add dark mode toggle to the settings page`
3. User presses Enter.
4. Hero prompt smoothly resizes to a compact top-of-canvas input (collapses from `24px` to `14px` font size).
5. Master node materializes in the center of the canvas with thinking animation.
6. Master begins streaming:
   - "Reading project structure..."
   - "Detected mono-repo (4 packages)..."
   - "Identifying settings page components..."
   - "Planning subtasks..."
7. Typically 5-15 seconds later, subtask nodes begin branching downward in tree layout.

## Subtask approval — the trust moment

This is the most important interaction in the product. Design it with care.

### What the user sees

- Master node shows "Planning complete · 4 subtasks proposed · 8s" in muted text.
- Below master, subtask nodes appear in `proposed` state: dashed amber border, `bg-elevated` fill.
- Each subtask node contains:
  - Status badge top-left: `PROPOSED` (amber, uppercase)
  - Subtask number top-right: `#1`, `#2`, etc.
  - Checkbox top-left inside header (default checked)
  - Title in body (14px, primary text)
  - Package chip in subtitle row (e.g., `packages/shared`)
  - **"Why?" section:** muted background block with left-border in amber, explaining master's reasoning in one sentence
  - Assigned worker chip at bottom: `→ claude-code`, `→ gemini-cli`, etc.

### The approval bar

A sticky bar slides up from the canvas bottom with `300ms ease-out`:

```
┌────────────────────────────────────────────────────────────────────┐
│ ● Master proposes 4 subtasks. Approve to start.                    │
│                        [Reject all] [Approve selected] [Approve all] │
└────────────────────────────────────────────────────────────────────┘
```

- Background: `bg-elevated`
- Top border: `1px solid agent-master` (amber)
- Left: amber dot + plain message
- Right: three buttons (ghost, secondary, primary)

### User interactions

- **Check/uncheck subtasks:** Only checked subtasks will run. Unchecked = skipped.
- **Click "Why?":** Expands to show master's reasoning (2-3 sentences max).
- **Reject all:** All subtasks discarded. Master is asked to re-plan from scratch.
- **Approve selected:** Only checked subtasks run.
- **Approve all:** All checked and unchecked run (equivalent to checking all + approve).

### Auto-approve mode

If user has enabled auto-approve in Settings:
- Skip this entire step.
- Subtasks go directly from `proposed` → `running` state with no approval bar shown.
- Top bar shows subtle "AUTO" indicator in amber.
- Destructive operations still require approval (see safety gates).

## Execution

Subtasks are approved. Workers start.

### What happens

- Approved subtasks transition: `proposed` → `approved` (brief flash) → `running`.
- Unchecked subtasks show: `skipped` state — strikethrough text, `0.5` opacity.
- Workers begin in parallel where possible. Dependencies are respected (subtasks depending on others wait in `waiting` state).
- Each running node shows:
  - Status dot pulsing in agent color
  - Status label: `RUNNING` (agent color)
  - Live log streaming in a small terminal-style block at the bottom of the node
  - Cursor blinks at the end of the latest line

### Log streaming rules

- Most recent 3-5 lines visible in the collapsed node.
- Click node to expand — full log, file edits, git operations.
- Log characters appear at max `5ms` per character (faster for long outputs).
- Lines get color-coded prefixes:
  - `✓` green for completed actions
  - `→` muted for in-progress
  - `⚠` amber for warnings
  - `✗` red for errors

### Shared notes

- Before each worker starts, it reads `.whalecode/notes.md` as part of context.
- When worker completes, it appends a summary to notes.
- User can view notes at any time via `⌘J` (opens a side drawer, read-only).

## Fail handling — the progressive recovery

When something goes wrong, the user should feel confident the system is trying to fix it before asking for help.

### Layer 1: Worker retry

Worker fails on first attempt.

- Node border changes from agent color to `status-retry` (amber).
- Status label: `RETRYING` with `1s` pulse.
- Log shows:
  - `⚠ Type error on first try`
  - `→ Retrying with error context...`
- Worker retries once. Error message is included in context.

If retry succeeds: node transitions back to `running` briefly, then `done`. No further action.

If retry also fails: escalate to Layer 2.

### Layer 2: Master re-plan

Worker retry has failed. Master takes over.

- Failed subtask node transitions to `re-planning` state:
  - Solid border in `status-retry` amber
  - Label: `ESCALATING`
  - Subtask title gets strikethrough
- Master node wakes back up. Thinking animation returns.
- Master reviews: original task + failed subtask + error history + what completed workers finished.
- Master generates new subtask(s) branching from itself (not from the failed one).
- New subtasks appear in `proposed` state → approval bar slides back up.

If user approves re-plan: new subtasks enter execution.
If this re-plan also fails: escalate to Layer 3.

**Loop protection:** Master can re-plan the same logical subtask maximum 2 times. After that, forced escalation to Layer 3.

### Layer 3: Human escalation

Both retry and re-plan have failed. User must decide.

- Failed node border solid `status-failed` (red).
- Status label: `FAILED`.
- Node auto-expands to show error summary.
- Inline action buttons in the node body:
  - `[Manual fix]` — opens external editor at the relevant file
  - `[Skip subtask]` — marks as skipped, run continues without it
  - `[Abort run]` — kills the whole run, cleans up worktrees
- Full raw error log available via "Show full error" disclosure.

User cannot ignore — must pick one of the three.

### Master failure (special case)

If master itself fails (rare), skip Layer 1 and 2 entirely. Go directly to Layer 3. Master does not retry itself — a failing planner cannot plan around its own failure.

## Completion and merge

All subtasks are done (or skipped by user choice).

1. Final node (previously dashed/gray) becomes active.
2. Final node shows "Preparing merge..." briefly.
3. Final node expands to show aggregate diff preview:
   - File-by-file changes
   - Additions (green), deletions (red), modifications (amber)
   - Grouped by package (in mono-repo)
4. Two primary actions below the diff:
   - `[Apply to branch]` — primary amber button
   - `[Discard all]` — ghost button, muted

### Conflicts

If workers' changes conflict (e.g., two workers edited the same function):

- Master first attempts automatic resolution.
- If auto-resolve fails: inline conflict UI in the final node.
- User sees git-diff-style conflict markers inline. Can resolve manually or abort.

### Successful apply

User clicks "Apply to branch":
- Worktrees are merged into main branch.
- Worktrees are cleaned up (invisible to user).
- Success check animation appears on final node.
- Run summary bar slides up: `Done in 2m 14s · 45k tokens · ~$0.32 · 4 subtasks`.
- Graph transitions to muted state (opacity `0.5`, no animations).
- Input auto-focuses, ready for the next task.

## Edge cases

### Budget exceeded

- During a run, if total cost approaches configured budget cap:
  - At 80%: subtle warning in footer (text turns amber).
  - At 100%: master pauses execution. All running workers are signaled to finish their current action and halt.
  - Modal-like inline message near approval bar: "Budget cap reached. Continue with $X more?"
  - User chooses: `[Continue]` (ignore budget) or `[Stop here]` (freeze run at current state).

### Destructive operation in auto-approve

- Auto-approve is on. Worker wants to run `git push --force`.
- Safety gate catches this. Blocks the action.
- Approval bar slides up (even in auto mode):
  - `● Worker wants to run destructive command: git push --force`
  - `[Reject] [Allow once]`
- Auto-approve only resumes after this prompt is resolved.

### Agent API key missing

- Worker tries to start but required API key is missing from env.
- Node shows `FAILED` state immediately with inline:
  - Error: "Gemini API key not configured"
  - Action: `[Configure agent]` — opens settings to the right section.

### Network offline

- Agent API call fails with network error.
- Treated as Layer 1 retry candidate.
- If offline persists, node fails and user sees "Check network connection" message.

## Never do this

- **Don't use modal dialogs for approval.** The sticky bottom bar is the standard.
- **Don't auto-dismiss errors.** User should actively acknowledge every failure.
- **Don't hide failure details.** Summary visible, raw log one click away.
- **Don't animate confetti or celebrate success loudly.** Understated success feels more trustworthy than loud.
- **Don't interrupt the flow with onboarding tooltips.** First-run guidance is inline in the empty state only.
- **Don't reset the graph mid-run even if user submits a new task.** Warn first: "A run is in progress. Wait for completion or abort current run?"
