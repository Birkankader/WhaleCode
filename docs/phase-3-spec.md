# Phase 3: Approval flow and progressive retry

**Goal:** Transform the approval step from binary (approve/reject) into a full human-in-the-loop workflow where users can edit subtasks, add new ones, and recover from failures through automatic retry and master re-planning.

**Duration estimate:** 2 weeks

**Success criteria:**
- User can edit any field of a proposed subtask inline (title, why, assigned worker, dependencies)
- User can add subtasks that master didn't propose
- User can remove subtasks from the plan
- Workers that fail trigger a silent retry (Layer 1)
- If retry fails, master re-plans and user approves the new plan (Layer 2)
- If re-plan fails, user sees the raw error with three choices: manual fix, skip, abort (Layer 3)
- Loop protection: master cannot re-plan the same subtask more than twice
- Auto-approve mode bypasses all approval UIs but NEVER bypasses safety gates

## Why this matters

Phase 2 shipped orchestration that works when master is right. Phase 3 ships the reality: master is sometimes wrong, workers sometimes fail, and users need agency over the plan.

The "AI team" metaphor requires this. A tech lead doesn't rubber-stamp their junior's plan — they reshape it. A worker that fails once doesn't get fired — they retry with the error in mind. A re-plan isn't a restart — it's course correction. Phase 3 makes these real.

## What this phase does NOT include

Defer:
- Mono-repo awareness in planning (Phase 4)
- Config files / templates (Phase 5)
- Cost tracking (Phase 6)
- Auto-approve safety gates detailed UX (Phase 7 — but the bypass logic goes in now)

## Prerequisites

Phase 2 must be shipped and stable:
- Real agents executing, streaming, diffing, merging
- Worktree cleanup reliable on every exit path
- IPC event contract working end-to-end
- Error surface honestly reflects failures

## Architecture changes

Phase 2's orchestrator had a linear flow. Phase 3 makes it branching:

```
      ┌──── Planning ────┐
      │                  ↓
      │            AwaitingApproval ──── (edits / adds / removes)
      │                  ↓
      │              Running
      │                  ↓
      │     ┌─── worker fails ───┐
      │     ↓                    │
      │  Retrying (Layer 1)      │
      │     ↓                    │
      │     ├── succeeds → done  │
      │     └── fails twice      │
      │        ↓                 │
      │    Escalating (Layer 2)  │
      │        ↓                 │
      └───  master re-plans  ←───┘
           ↓
      AwaitingApproval (of the re-plan)
           ↓
         Running (new subtasks)
           ↓
      ... or if re-plan also fails ...
           ↓
      HumanEscalation (Layer 3)
           ↓
      user: Manual fix / Skip / Abort
```

The graph store must support:
- Marking a subtask as "edited by user" (signal to master, useful for telemetry)
- Inserting new subtasks dynamically (both user-added and re-planned)
- Tracking re-plan count per subtask for loop protection
- A "why master re-planned this" message attached to re-planned subtasks

## Step-by-step tasks

### Step 1: Subtask editing — store and XState changes

**Goal:** Edits are only permitted while a subtask is in `proposed` state. Once approved, it's locked.

**Store changes:**
```typescript
// src/state/graphStore.ts (additions)
interface GraphStoreActions {
  // ... existing ...
  updateSubtask: (id: string, patch: Partial<SubtaskData>) => void;
  addSubtask: (data: Omit<SubtaskData, 'id'>) => string; // returns new id
  removeSubtask: (id: string) => void;
}
```

**XState guard:**
Add a guard on the `PROPOSE` → `APPROVE` transition that checks for invalid edits. A subtask must have:
- Non-empty title
- A valid assigned worker (one of the available agents)
- Dependencies that reference existing subtask IDs (no orphans)

If validation fails, the action throws and the UI surfaces the error. Prevent approval of invalid plans at the store layer, not just the UI layer.

**New fields on SubtaskData:**
```typescript
interface SubtaskData {
  // ... existing ...
  editedByUser: boolean;  // true if any field was modified after master proposed it
  addedByUser: boolean;   // true if user added it via "+ Add subtask"
  replanCount: number;    // how many times master has re-planned this (0 initially)
  replanReason?: string;  // master's explanation when re-planning
}
```

**IPC changes:**
Approve command must include the final subtask list (post-edit), not just IDs:
```rust
// src-tauri/src/ipc/mod.rs
async fn approve_subtasks(
    run_id: RunId,
    subtasks: Vec<SubtaskFinalized>,  // the EDITED plan
) -> Result<(), String>
```

The orchestrator applies the user's edited plan, not the original one.

**Tests:**
- Store: adding, updating, removing subtasks mutates state correctly
- XState: invalid edit (empty title) blocks approval
- Integration: edit a subtask, approve, verify orchestrator runs the edited version

### Step 2: Inline edit UI

Editing happens inline in the WorkerNode, not in a separate dialog. This preserves context.

**Editable regions within a proposed WorkerNode:**

**Title:**
- Click the title text → converts to inline `<input>` (same font size and color)
- Escape cancels, Enter saves, blur saves
- Trim whitespace on save; empty title rejected with subtle shake animation

**Why? explanation:**
- Click the "why?" section → converts to inline `<textarea>` (auto-height)
- Same save/cancel behavior
- Optional field; empty is allowed

**Assigned worker:**
- Click the worker chip → dropdown appears below
- Dropdown lists only Available agents (from detection state)
- Keyboard navigable (arrow keys, Enter to select, Escape to close)
- Changing worker does NOT clear the subtask's other fields

**Edited indicator:**
- Small "edited" badge appears in the node's header row after first edit
- Tooltip on hover: "This subtask was modified from master's original plan"
- Removing the badge requires reverting to original (track original values separately if needed for undo)

**Add subtask:**
- "+ Add subtask" button at the end of the approval bar's left cluster
- Clicking creates a new subtask node in `proposed` state with empty title, empty why, default worker (the master's recommended worker or first Available)
- New node auto-enters edit mode on the title
- Graph re-layouts to include it

**Remove subtask:**
- Small X button in the top-right of each proposed node (visible on hover only)
- Confirmation: "Remove this subtask? This action can be undone before approval." (modal is overkill; use inline confirm inside the node)
- Removed subtask disappears from the graph

**Dependencies (advanced, optional for Phase 3):**
- If user-added or user-edited, user may want to specify dependencies
- Minimum viable UI: a dropdown under the subtask showing other subtask titles with checkboxes
- If this is too much scope for Phase 3, ship without it and note in roadmap that Phase 4's mono-repo work will include dependency editing

**Primitives to add or extend:**
- `InlineTextEdit.tsx` — text input that inherits parent styling, handles save/cancel
- `Dropdown.tsx` — keyboard-navigable, used for worker selection
- `Badge.tsx` — small inline label (used for "edited" indicator)

**Design tokens:**
- Editing state: input border in `status-pending` amber, 2px instead of 1px
- Hover reveal for remove button: opacity 0 → 1, 150ms ease-out
- Validation error shake: 4 oscillations at ±3px, 300ms total

**Tests:**
- Component tests for each inline editor (keyboard interaction, save/cancel)
- Integration test: edit title + change worker + add subtask + remove one + approve → orchestrator runs the modified plan

### Step 3: Worker-level retry (Layer 1)

**Goal:** When a worker fails, retry once with the error in context. Most transient failures self-resolve.

**Orchestrator changes (Rust):**

```rust
async fn execute_subtask_with_retry(
    subtask: &SubtaskRuntime,
    agent: &dyn AgentImpl,
    worktree_path: &Path,
    notes: Arc<SharedNotes>,
) -> Result<ExecutionResult, EscalateToMaster> {
    let first_attempt = agent.execute(subtask, worktree_path, &notes.read().await?, log_tx.clone()).await;

    match first_attempt {
        Ok(result) => Ok(result),
        Err(err) => {
            // Emit retry state
            events.emit(RunEvent::SubtaskStateChanged {
                subtask_id: subtask.id.clone(),
                state: SubtaskState::Retrying,
            });

            // Augment context with error
            let retry_context = format!(
                "Previous attempt failed with: {}\n\nPlease retry with awareness of the above error.",
                err
            );

            let retry_result = agent.execute_with_extra_context(
                subtask,
                worktree_path,
                &notes.read().await?,
                &retry_context,
                log_tx,
            ).await;

            match retry_result {
                Ok(result) => Ok(result),
                Err(_) => Err(EscalateToMaster),
            }
        }
    }
}
```

**Agent trait extension:**
Add `execute_with_extra_context` method or a parameter to existing `execute` that accepts additional system-level context. Existing adapters update their prompts to include the retry context prominently.

**UI: Retrying state:**
Already designed in Phase 1's design system (`status-retry` amber border, retry badge). Phase 1 UI was driven by mock; now it's driven by real events from orchestrator.

**Logs must show the retry:**
- Last line of first attempt's log + a visual separator + first line of retry
- Users can see WHAT failed and how the retry is adjusting

**Tests:**
- Fake adapter that fails once then succeeds: verify retry triggers, final state is `done`
- Fake adapter that fails twice: verify escalation triggers

### Step 4: Master re-planning (Layer 2)

**Goal:** When a subtask fails its retry, master reviews the situation and proposes a new plan.

**Orchestrator flow:**
1. Subtask fails twice (Layer 1 exhausted)
2. Subtask state → `escalating`
3. Master wakes up: collect context (original task, failed subtask, error history, what other workers completed)
4. Call `master.replan(context)` — returns new `Plan` with replacement subtask(s)
5. Insert new subtasks into the run as children of master (siblings to the original subtasks)
6. Mark the original failed subtask with `state: Failed` and `replanCount++`
7. Transition run to `AwaitingApproval` of the re-plan
8. User approves the re-plan → dispatch new subtasks
9. If re-plan subtask also fails twice: repeat, unless loop limit hit

**Loop protection:**
- Max 2 re-plans per original subtask (track via `replanCount`)
- If a subtask has been re-planned twice and the replacement still fails: skip to Layer 3 immediately, no third re-plan

**Master prompt for re-planning:**
A new prompt template: `src-tauri/src/agents/prompts/replan_{agent}.md`

Key elements:
- Original task
- Original subtask that failed (title, why)
- All error messages from attempts
- Logs from the worker (last 50 lines)
- What OTHER subtasks completed (their summaries from shared notes)
- Instructions: "Propose a replacement approach. It might be: splitting the subtask further, using a different approach, or marking it as not-feasible (empty plan)."

**Empty re-plan case:**
- Master may legitimately conclude "this subtask can't be automated, skip it"
- Plan returned with empty subtasks + reasoning
- UI: failed subtask shows master's note: "Master suggests skipping this — it requires manual handling"
- User has the choice: accept the skip, or intervene manually

**UI changes:**
- When re-plan triggers, master node returns to `thinking` state (visually "planning again")
- New subtasks appear as siblings to the original, with a subtle visual cue: small dashed line from the failed node to the replacement, OR a badge on the new subtask "replaces subtask #3"
- Approval bar returns with a different message: "Master proposes 2 replacement subtasks after a failure. Approve to continue."

**Event additions:**
- `run:replan_started { run_id, failed_subtask_id }`
- `run:replan_proposed { run_id, new_subtasks, reasoning }`

**Tests:**
- Fake adapter: master plans A, worker fails twice → master re-plans with A' → A' succeeds
- Loop protection: A fails, re-plan A', A' fails, re-plan A'', A'' fails → escalate to Layer 3 (no A''')

### Step 5: Human escalation (Layer 3)

**Goal:** When automated recovery fails, hand decision authority to the user.

**Triggers:**
- Layer 2 re-plan itself errors (master can't produce a plan)
- Loop limit hit (2 re-plans already tried)
- Master's replan returns empty + user rejects the skip

**UI:**
The failed subtask node enters `human_escalation` state:
- Red border (`status-failed`)
- Auto-expanded node body showing:
  - Short error summary ("Worker failed twice; master couldn't recover")
  - Expandable "Show full error" section with raw logs
- Three inline buttons inside the node body:
  - **Manual fix** — opens an external editor at the most-recently-edited file in the worktree (best-effort; may need tauri-plugin-shell)
  - **Skip subtask** — marks as `skipped`, run continues without it
  - **Abort run** — kills the whole run, cleanup everything

**Manual fix flow:**
- User clicks "Manual fix"
- Worker's worktree path is opened in their configured editor (detected from `$EDITOR` env var or settings)
- User edits files, saves
- Returns to WhaleCode, clicks "I fixed it, continue" (new button that appears after Manual fix was clicked)
- Orchestrator marks the subtask as `done`, proceeds
- Diff from the user's manual edits is captured automatically

**Abort flow:**
- Confirmation required: "Abort the whole run? All work will be discarded."
- If confirmed: cancel all running workers, cleanup worktrees, clear notes, transition to `Idle`

**Events:**
- `run:human_escalation { run_id, subtask_id, error, options: ["manual_fix", "skip", "abort"] }`

**Tests:**
- Fake adapter: master fails to produce replan → UI shows human_escalation
- Manual fix flow: user clicks manual fix → editor opens (verify shell invocation) → clicks continue → subtask marked done
- Skip: run continues without the subtask

### Step 6: Master failure handling

Master itself can fail: API error, malformed output, timeout.

**Critical rule:** Master does NOT self-retry. If master fails during planning or re-planning, go directly to human escalation. A failing planner cannot plan around its own failure.

**UI:**
- If master fails during initial planning: show error banner above the graph, no subtasks created, user can retry submission or abort
- If master fails during re-planning: the specific failed subtask stays in `failed` state, user gets the same Layer 3 options (manual fix / skip / abort), plus "try replan again" as a fourth option (one more attempt allowed)

**Tests:**
- Master timeout on planning: error surfaces, no partial state
- Master fails on replan: Layer 3 offered directly

### Step 7: Auto-approve mode (minimal)

Auto-approve is a Phase 7 topic officially, but Phase 3 introduces the bypass point. Wire the switch now so Phase 7 can focus on safety gate UX.

**Settings addition:**
- Settings panel (Cmd+, opens it — basic panel in Phase 3, full polish in Phase 6)
- Toggle: "Auto-approve subtasks" (off by default)
- First activation shows warning modal per `docs/architecture.md` section 7
- UI indicator when on: amber dot + "Auto" in top bar

**Bypass points:**
- After master's initial plan → auto-approve all → dispatch workers immediately
- After re-plan proposal → auto-approve all → dispatch workers immediately

**Does NOT bypass:**
- Destructive git commands (Phase 7 implements the full list)
- Budget exceeded (Phase 6 wires budget; Phase 3 has no budget yet)
- Human escalation (Layer 3) — always requires user

For Phase 3, safety gates are a hook point only. Stub:
```rust
pub fn is_action_safe(action: &AgentAction) -> bool {
    // Phase 3: always true. Phase 7 fills this in.
    true
}
```

**Tests:**
- Auto-approve on: submit task → master plans → workers dispatch without user interaction
- Auto-approve on, master fails: still shows error (bypass doesn't silence failures)
- Auto-approve on, re-plan fails twice: still escalates to Layer 3

### Step 8: Store integration for Layer 1-3

Update the Zustand store to handle the new event types and state transitions.

New event handlers:
- `run:subtask_retrying` — transition node to retrying state via XState
- `run:replan_started` — master node back to thinking
- `run:replan_proposed` — insert new subtasks, status → awaiting_approval
- `run:human_escalation` — transition node to human_escalation state

Update XState machine if needed to support the Layer 2 path (escalating → back to proposed via re-plan, not just retrying → running).

### Step 9: Polish and verification

- All three layers must be visibly distinct in the UI — user should instantly know "retry happening" vs "master re-planning" vs "I need to decide"
- Transitions between layers should feel earned, not jarring — brief pause between retry failing and re-plan starting
- Error messages surfaced to the user must be actionable, not just dumps. Phase 3 cleans up the error display from Phase 2's "honest dump" to "actionable summary + details on demand"
- Loop protection must be visible: user should be able to see "this subtask has been re-planned twice already" if they look at the failed node
- Performance: re-planning while workers are still running (other subtasks progressing) should not block UI updates

## Acceptance criteria

Phase 3 ships when:

1. User can edit a proposed subtask's title inline, save, approve — orchestrator runs the edited version
2. User can change a proposed subtask's assigned worker via dropdown
3. User can add a new subtask via "+ Add subtask", fill it in, approve — orchestrator runs it
4. User can remove a subtask from the plan before approving
5. A worker fails once → automatic retry happens with error context → succeeds
6. A worker fails twice → master re-plans → user approves → replacement succeeds
7. A re-planned subtask fails twice → loop protection kicks in → user sees Layer 3 options
8. Manual fix flow works: editor opens worktree, user edits, "continue" proceeds
9. Skip subtask: run continues cleanly without it
10. Abort run: all worktrees cleaned up, back to idle
11. Master failure during planning: error shown, no partial state
12. Master failure during re-planning: Layer 3 offered with retry option
13. Auto-approve mode: bypasses both initial and re-plan approvals
14. Auto-approve mode: still honors human escalation (can't be fully automated)

## What you'll create

```
src-tauri/src/
├── agents/
│   └── prompts/replan_{agent}.md
├── orchestration/
│   ├── mod.rs (extended with retry + replan logic)
│   └── escalation.rs (new — Layer 2 & 3 handling)
└── safety/mod.rs (stub for Phase 7)

src/
├── components/
│   ├── primitives/
│   │   ├── InlineTextEdit.tsx
│   │   ├── Dropdown.tsx
│   │   └── Badge.tsx
│   ├── nodes/
│   │   ├── WorkerNode.tsx (extended: inline editing)
│   │   └── EscalationActions.tsx (Layer 3 buttons)
│   └── approval/
│       ├── ApprovalBar.tsx (extended: "+ Add subtask")
│       └── ReplanApprovalBar.tsx (new variant for re-plan approvals)
├── hooks/
│   ├── useInlineEdit.ts
│   └── useExternalEditor.ts (for manual fix)
└── state/
    ├── nodeMachine.ts (extended: escalating → proposed path)
    └── graphStore.ts (extended: add/update/remove + new event handlers)
```

Estimated LOC: ~1500 Rust, ~2000 TypeScript. Frontend-heavy because editing UX is the bulk.

## Common pitfalls

- **Inline edit UX is unforgiving.** If Escape doesn't cancel reliably, or blur saves unexpectedly, users rage-quit. Test keyboard edge cases exhaustively: Tab while editing, clicking outside, rapid enter/escape.
- **Re-plan loop is a footgun.** Without the loop limit, a pathological case could burn an entire budget on re-plans. Enforce the limit at the orchestrator level, not just UI.
- **Edited subtasks must persist through re-planning.** If user edits subtask #3 and it fails, the re-plan should know "user cared about this" in its prompt context.
- **Editor detection varies by OS.** Don't hardcode `code`. Respect `$EDITOR`, then fall back to platform defaults (`open` on macOS, `xdg-open` on Linux, associated app on Windows).
- **Safety gate hooks must be real even if Phase 3's implementation is trivial.** Phase 7 should only need to fill in `is_action_safe` — not refactor the architecture.
- **Don't let auto-approve silently swallow failures.** Auto-approve bypasses approvals, not errors. All three layers still apply.

## Open questions deferred to Phase 4

- Should users be able to manually specify subtask dependencies during editing? (Current plan: minimal support in Phase 3, full support in Phase 4 with mono-repo dependency graphs.)
- Should the "edited" badge persist to telemetry for master fine-tuning? (Phase 5 config system might enable this as opt-in.)
- Should a failed subtask's worktree be inspectable from the UI? (Currently only accessible via manual fix editor launch.)
