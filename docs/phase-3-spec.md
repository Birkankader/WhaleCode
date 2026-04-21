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
      ┌──── Planning ────────────┐
      │                          ↓
      │                    AwaitingApproval  ← update/add/remove via IPC
      │                          ↓
      │                       Running
      │                          ↓
      │             ┌── worker fails (non-Spawn) ──┐
      │             ↓                              │
      │       Retrying (Layer 1)                   │
      │             ├── succeeds → Running → Done  │
      │             └── fails                      │
      │                 ↓                          │
      │                 │      ┌─ SpawnFailed ────┘
      │                 ↓      ↓
      │        Planning (re-plan context)  ← Layer 2 reuses the existing status
      │                 ↓
      └─────  master produces replacement subtasks  ─────┘
           (new rows in `subtask_replans`, `SubtasksProposed` re-emitted)
                          ↓
                ... or replan cap hit / master fails / empty plan ...
                          ↓
                AwaitingHumanFix   ← Layer 3 park (worktrees + notes preserved)
                          ↓
         user decision on the resolution channel:
            ├── Manual fix + mark fixed → subtask: Done
            ├── Skip (cascades to dependents) → subtasks: Skipped
            ├── Try replan again (if cap not hit) → Running → Planning → ...
            └── Abort                         → run: Cancelled (full cleanup)
                          ↓
                Running (dispatcher re-evaluates)   or   Cancelled
```

Key architectural deltas vs the earlier draft:
- **Layer 3 does NOT terminate the run.** Lifecycle parks in `AwaitingHumanFix`; worktrees, notes, and already-completed worker output are preserved. Only **Abort** transitions the run to a terminal state (`Cancelled`) with full cleanup. `mark_fixed` / `skip` / `try_replan_again` signal the per-run resolution channel, the dispatcher wakes, and dependents of the fixed-or-skipped subtask become eligible.
- **Layer 2 reuses existing statuses.** `Running → Planning → AwaitingApproval`, same as initial planning. No `Escalating` status.
- **`AwaitingHumanFix` is the one new `RunStatus` Phase 3 adds.** Enum audit below covers its five call sites. Like every other status it serializes as text (no schema migration).
- **No new "re-plan" events.** The `run:subtasks_proposed` event carries replacement subtasks (with an optional `replaces?: SubtaskId[]` field per subtask).
- **Retry count lives in the store** (`subtaskRetryCounts: Map<string, number>`), not in the XState machine. Phase 1's `MAX_RETRIES` / `canRetry` guard is removed in Step 3a.
- **Re-plan count is server-authoritative.** `COUNT(*) FROM subtask_replans` walked back to the chain root — the frontend reads it as a derived field.
- **`SpawnFailed` skips Layer 1** and escalates directly to Layer 2. Retry on a missing binary cannot change the outcome.

The graph store must support:
- Routing `SubtaskState::Retrying` through `START_RETRY` / `RETRY_SUCCESS` / `RETRY_FAIL` events on the node machine (Step 3a)
- Incrementing `subtaskRetryCounts` on `Retrying` transitions
- Routing `run:human_escalation` through an `ESCALATE` event on the node machine (Step 8)
- Appending replacement subtasks via the existing `handleSubtasksProposed` (no new handler)

## Step-by-step tasks

### Prerequisite: Storage migration M002

Phase 3 needs new columns on `subtasks` and a new table for tracking re-plan relationships. Land this migration before any Step 1 persistence code — the edit commands (`update_subtask`, `add_subtask`) and the re-plan logic (Step 4) all depend on it.

**File:** `src-tauri/src/storage/migrations.rs` — append as `M002`, leave `M001` untouched.

```sql
-- Add user-edit tracking to subtasks
ALTER TABLE subtasks ADD COLUMN edited_by_user BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE subtasks ADD COLUMN added_by_user BOOLEAN NOT NULL DEFAULT 0;

-- Normalized replan relationships
CREATE TABLE subtask_replans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_subtask_id TEXT NOT NULL,
  replacement_subtask_id TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (original_subtask_id) REFERENCES subtasks(id) ON DELETE CASCADE,
  FOREIGN KEY (replacement_subtask_id) REFERENCES subtasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_subtask_replans_original ON subtask_replans(original_subtask_id);
CREATE INDEX idx_subtask_replans_replacement ON subtask_replans(replacement_subtask_id);
```

**Why a separate table for re-plans:** a re-plan is an event with a relationship (`original → replacement`) plus a reason and a timestamp — not just a counter on the original row. The normalized shape:
- keeps "how many times has this been re-planned?" as `COUNT(*)` on the join, no inconsistency risk
- enables Phase 6 run-history queries like "show the full replacement chain for subtask X" without adding columns later
- handles the "one original → multiple replacements" case cleanly (when master splits a failed subtask into several)

**What the frontend reads:**
The existing `SubtaskData` shape on the frontend keeps `replanCount: number` and `replanReason?: string` for UI display (Step 4's "replaces #3" badge and "this has been re-planned twice already" text). Both are derived server-side from `subtask_replans` and delivered via `run:subtasks_proposed` — the frontend does not query the table directly.

**Enum variants do NOT need a migration.** `RunStatus` and `SubtaskState` are persisted as text; adding `SubtaskState::Retrying` (Step 3) or any new re-plan-era status just writes the new string value. Any code that switch-matches on these enums is the real migration surface — tracked in the enum audit below.

**Enum audit (prerequisite before Step 3):** every new variant has five call sites. List them explicitly so the work is bounded:

| Call site | `SubtaskState::Retrying` |
|---|---|
| Rust enum | `src-tauri/src/ipc/mod.rs` — add `Retrying` variant |
| zod schema | `src/lib/ipc.ts` — add to `subtaskStateSchema` |
| Status mapper | `src/state/graphStore.ts` — `eventsForSubtaskState` handles the new variant |
| XState bridge | see Step 3 — machine receives `START_RETRY` / `RETRY_SUCCESS` / `RETRY_FAIL` |
| SQLite persistence | implicit (text column); no schema change |

Phase 3 Step 5 adds one `RunStatus` variant on the same schedule — audit before Step 5 Commit 2a:

| Call site | `RunStatus::AwaitingHumanFix` |
|---|---|
| Rust enum | `src-tauri/src/ipc/mod.rs` — add `AwaitingHumanFix` variant (serialized `awaiting-human-fix`) |
| zod schema | `src/lib/ipc.ts` — add to `runStatusSchema` |
| Status mapper | `src/state/graphStore.ts` — top-bar chip label + any `RunStatus`-keyed reducer branches |
| Lifecycle gate | `src-tauri/src/orchestration/lifecycle.rs` — enter on escalation, exit on resolution/abort; edit commands that gate on `AwaitingApproval` stay untouched (escalation is a different park) |
| SQLite persistence | implicit (text column); no schema change |

Run this audit *before* adding each new variant, not after.

### Step 1: Subtask editing — store and XState changes

**Goal:** Edits are only permitted while a subtask is in `proposed` state. Once approved, it's locked.

**Store changes:**
```typescript
// src/state/graphStore.ts (additions)
interface GraphStoreActions {
  // ... existing ...
  updateSubtask: (id: string, patch: SubtaskPatch) => Promise<void>;  // → update_subtask IPC
  addSubtask: (data: SubtaskDraft) => Promise<string>;                // → add_subtask IPC, returns new id
  removeSubtask: (id: string) => Promise<void>;                       // → remove_subtask IPC
}
```

Each action wraps the matching IPC call (see **IPC changes** below). The store does NOT mutate `subtasks` optimistically — the backend re-emits `run:subtasks_proposed` with the updated list, which the existing `handleSubtasksProposed` applies. This keeps Phase 2's event-sourced discipline: the backend is the source of truth, the store is a mirror.

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

`approve_subtasks` **stays exactly as Phase 2 shipped it:**

```rust
#[tauri::command(rename_all = "camelCase")]
pub async fn approve_subtasks(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: RunId,
    subtask_ids: Vec<SubtaskId>,
) -> Result<(), String>;
```

Approval finalizes whatever subtask state is *currently persisted server-side*. It does not carry plan contents — edits commit ahead of time via three new dedicated commands.

**Three new edit commands** (add to `src-tauri/src/ipc/commands.rs`, register in `lib.rs::generate_handler!`):

```rust
#[tauri::command(rename_all = "camelCase")]
pub async fn update_subtask(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: RunId,
    subtask_id: SubtaskId,
    patch: SubtaskPatch,      // { title?, why?, assigned_worker? }
) -> Result<(), String>;

#[tauri::command(rename_all = "camelCase")]
pub async fn add_subtask(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: RunId,
    data: SubtaskDraft,       // { title, why, assigned_worker, dependencies }
) -> Result<SubtaskId, String>;

#[tauri::command(rename_all = "camelCase")]
pub async fn remove_subtask(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: RunId,
    subtask_id: SubtaskId,
) -> Result<(), String>;
```

Mirror the Rust shapes in `src/lib/ipc.ts` with zod schemas, matching Phase 2's wire-contract discipline.

**Semantics:**

- **`update_subtask`** — patches `title`, `why`, or `assigned_worker` on a single row. Sets `edited_by_user = 1` (see M002). No-op if the run is not in `AwaitingApproval` — edits are rejected once workers dispatch. Re-emits `run:subtasks_proposed` with the full list on success.
- **`add_subtask`** — inserts a new row in `proposed` state with `added_by_user = 1`, a fresh `ulid` id, and caller-supplied fields. Returns the new id. Re-emits `run:subtasks_proposed`. Caller-supplied dependencies must reference existing subtask ids or the command fails.
- **`remove_subtask`** — deletes the row (CASCADE drops dependencies). Fails if any other subtask depends on it — caller must remove dependents first, or remove them in reverse topological order. Re-emits `run:subtasks_proposed`.

**Why this split** (vs the "approve carries the finalized plan" alternative from the earlier draft):

- Inline edit UX (Step 2) calls `update_subtask` on each blur/Enter, not a batch on approve. Users see backend confirmation per field.
- `add_subtask` / `remove_subtask` are distinct user intents; batching them into `approve_subtasks` muddied the approval surface.
- `approve_subtasks` stays "dispatch the workers" — one responsibility. Matches Phase 2's shipped shape; no re-wiring of existing tests.
- The backend keeps one authoritative copy of the plan. No "which version wins if edits and approve race?" ambiguity.

**Concurrency note:** `update_subtask`, `add_subtask`, `remove_subtask`, and `approve_subtasks` all take the run's `RwLock` in write mode. The orchestrator serializes them, so rapid inline edits followed by an approve click land in order.

**Tests:**
- Rust: `update_subtask` rejects empty title, rejects after approval, sets `edited_by_user`
- Rust: `add_subtask` rejects dangling dependency ids, assigns fresh ulid, sets `added_by_user`
- Rust: `remove_subtask` rejects when dependents exist, CASCADEs correctly when last leaf
- Rust: concurrent `update_subtask` + `approve_subtasks` interleaves — edits land before approval dispatches workers
- Store: each action invokes the matching IPC and applies the re-emitted `run:subtasks_proposed`
- XState: invalid edit (empty title) blocks approval at the store layer
- Integration: edit a subtask, approve, verify orchestrator runs the edited version (worker receives the edited title/why)

### Step 2: Inline edit UI

Editing happens inline in the WorkerNode, not in a separate dialog. This preserves context.

**IPC wiring recap (from Step 1):**
- Every committed edit (blur / Enter on `title` or `why`, selection on `assigned_worker`) calls `updateSubtask(id, patch)` → `update_subtask` IPC.
- Clicking "+ Add subtask" calls `addSubtask(draft)` → `add_subtask` IPC → the returned id is used to pre-focus the new node's title input.
- Remove-button confirmation calls `removeSubtask(id)` → `remove_subtask` IPC.

The UI does NOT mutate the store optimistically. It awaits the IPC promise, and the visual update arrives via the re-emitted `run:subtasks_proposed`. This matches Phase 2's event-sourced pattern — no divergent local state. The "edit saved" visual beat is the node re-rendering from the new props, not a local flash.

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

**Dependencies (read-only display in Phase 3):**
- Dependency *editing* is deferred to Phase 4. Mono-repo awareness makes cross-package dependency editing a natural companion — cycle detection, transitive visualisation, and drag-to-connect are their own coherent design that shouldn't dilute the inline-edit surface landing here.
- In Phase 3, each proposed subtask shows a small `Depends on: #2, #4` line under the "why" text. `#N` is the 1-indexed position in the proposed list (stable within a plan, re-numbered on re-plan).
- Each `#N` is a link. Clicking scrolls the React Flow canvas so the referenced subtask is centred. No hover preview, no drag-to-connect.
- User-added subtasks default to `dependencies: []`. Master's dependency graph stays untouched by user additions — correct, because the user is expressing "this is extra work that stands alone."
- Scope note: this uses the existing `SubtaskData.dependencies` field on the wire; no new IPC, no new store shape. Only `WorkerNode` renders the line and handles the click-to-scroll.

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

**Goal:** When a worker fails, retry once with the error in context. Most transient failures self-resolve. Retry decisions live in the backend; the frontend reflects state.

#### 3a. Machine refactor

Phase 1's `nodeMachine.ts` carried a frontend retry budget (`MAX_RETRIES = 0`, `canRetry` guard, `incrementRetries` action). Phase 3 **removes all three**. The machine becomes a pure reflection of backend state.

**Remove from `src/state/nodeMachine.ts`:**
- `MAX_RETRIES` constant
- `canRetry` guard
- `incrementRetries` action
- The `running --FAIL→` transition's conditional branch on `canRetry` (collapse to single `running → failed` edge via `FAIL`)

**Add to `src/state/nodeMachine.ts`:**
- `START_RETRY` event: `running → retrying` (fired when backend emits `SubtaskState::Retrying`)
- `RETRY_SUCCESS` event: `retrying → running` (backend transitions `Retrying → Running` → a new attempt is live)
- `RETRY_FAIL` event: `retrying → failed` (backend transitions `Retrying → Failed` → Layer 1 exhausted)

**`FAIL` stays as the direct-failure event** for the deterministic case (e.g., `SpawnFailed`, see 3d) where the backend never enters `Retrying` in the first place: `running → failed` directly.

**Retry counter moves to `graphStore`:**

```typescript
// src/state/graphStore.ts (additions)
type GraphState = {
  // ... existing ...
  subtaskRetryCounts: Map<string, number>;
};
```

Incremented in `handleSubtaskStateChanged` when the incoming state is `Retrying`. Read by `WorkerNode` for the "Retry 1" badge display. Reset by `reset()` (and not persisted — the backend's `subtasks.state` column is the persistent source; on crash recovery, any `Retrying` row is swept to `Failed` by the existing recovery path).

**Store bridge (`eventsForSubtaskState` in `graphStore.ts`):**

| Backend `SubtaskState` | Current machine state | Events sent |
|---|---|---|
| `Retrying` | `running` | `START_RETRY` |
| `Running` | `retrying` | `RETRY_SUCCESS` |
| `Failed` | `retrying` | `RETRY_FAIL` |
| `Failed` | `running` | `FAIL` (existing, unchanged) |

No other cross-bridge paths change. Phase 2's `proposed → approved → waiting → running → done` mapping stays intact.

#### 3b. Backend changes (Rust)

Add `SubtaskState::Retrying` to `src-tauri/src/orchestration/run.rs` and `src-tauri/src/ipc/mod.rs` (the enum-audit table in the prerequisite section lists every call site).

**Orchestrator flow** (in `src-tauri/src/orchestration/dispatcher.rs`):

```rust
async fn execute_subtask_with_retry(
    subtask: &SubtaskRuntime,
    agent: &dyn AgentImpl,
    worktree_path: &Path,
    notes: &SharedNotes,
    log_tx: mpsc::Sender<String>,
    events: &dyn EventSink,
    cancel: CancellationToken,
) -> Result<ExecutionResult, EscalateToMaster> {
    // Attempt 1
    let first = agent
        .execute(subtask, worktree_path, &notes.read().await?, /* extra_context: */ None, log_tx.clone(), cancel.clone())
        .await;

    let err = match first {
        Ok(result) => return Ok(result),
        Err(AgentError::Cancelled) => return Err(EscalateToMaster::cancelled()),
        Err(AgentError::SpawnFailed { .. }) => return Err(EscalateToMaster::deterministic(err)), // 3d — skip Layer 1
        Err(e) => e,
    };

    // Transition to Retrying (persisted + emitted). Frontend's nodeMachine
    // receives START_RETRY via eventsForSubtaskState bridge and flips
    // the node visual to retrying; subtaskRetryCounts[subtask.id] increments.
    storage.update_subtask_state(subtask.id, SubtaskState::Retrying).await?;
    events.emit(RunEvent::SubtaskStateChanged { subtask_id: subtask.id.clone(), state: SubtaskState::Retrying });

    // Attempt 2
    let retry_context = format!(
        "Previous attempt failed with: {err}\n\nPlease retry with awareness of the above error."
    );
    let retry = agent
        .execute(subtask, worktree_path, &notes.read().await?, Some(&retry_context), log_tx, cancel)
        .await;

    match retry {
        Ok(result) => {
            // Transition Retrying → Running. Frontend flips retrying → running
            // via RETRY_SUCCESS. The worker will complete shortly, flipping to Done.
            storage.update_subtask_state(subtask.id, SubtaskState::Running).await?;
            events.emit(RunEvent::SubtaskStateChanged { subtask_id: subtask.id.clone(), state: SubtaskState::Running });
            Ok(result)
        }
        Err(e) => {
            // Transition Retrying → Failed. Layer 1 exhausted; caller
            // handles Layer 2 escalation. Frontend flips retrying → failed
            // via RETRY_FAIL.
            storage.update_subtask_state(subtask.id, SubtaskState::Failed).await?;
            events.emit(RunEvent::SubtaskStateChanged { subtask_id: subtask.id.clone(), state: SubtaskState::Failed });
            Err(EscalateToMaster::exhausted(e))
        }
    }
}
```

#### 3c. Agent trait extension

Extend the existing `AgentImpl::execute` signature with an optional `extra_context` parameter:

```rust
// src-tauri/src/agents/mod.rs
async fn execute(
    &self,
    subtask: &Subtask,
    worktree_path: &Path,
    shared_notes: &str,
    extra_context: Option<&str>,   // NEW — retry prompt augmentation
    log_tx: mpsc::Sender<String>,
    cancel: CancellationToken,
) -> Result<ExecutionResult, AgentError>;
```

Adapters render `extra_context` into the prompt when `Some`, otherwise proceed as today. One signature, one code path per adapter — no `execute_with_extra_context` sibling method.

Test fixture: `ScriptedAgent` grows a "fail-on-attempt-N" mode. See **Testing** below.

#### 3d. Uniform retry policy, with a SpawnFailed exception

Layer 1 retry fires **uniformly** for these `AgentError` variants:

- `ProcessCrashed`
- `TaskFailed`
- `ParseFailed`
- `Timeout`

One variant is exempt:

- **`SpawnFailed`** — the binary is missing, permissions are wrong, or the OS rejected `execve`. This state is deterministic: a retry cannot change the outcome and only wastes tokens + time. On `SpawnFailed`, the subtask skips Layer 1 entirely and escalates directly to Layer 2 (master re-plan).

`Cancelled` short-circuits before Layer 1 — cancellation comes from outside the worker, not from a worker failure, and retrying violates the user's intent.

**The taxonomy is retained** for UI display and logging — even though the retry policy is flat, the user-facing error surface distinguishes the variants. See the Layer 3 display mapping in Step 5.

#### 3e. UI: retrying state

`status-retry` amber border and retry badge (already in Phase 1's design system). Phase 1 was driven by mock state; Phase 3 drives it from real `SubtaskStateChanged` events through the `START_RETRY` bridge.

**Retry counter badge:** `WorkerNode` reads `graphStore.subtaskRetryCounts[id]` and renders "Retry N" in the header row when `N > 0`. For Phase 3 this only reaches `N = 1` (single retry per worker attempt); Phase 4+ can extend without breaking the badge.

**Logs must show the retry:**
- Last line of the first attempt's log + a visual separator (a thin `border-b` row with text "retrying after failure")
- First line of the retry attempt
- Users see WHAT failed AND how the retry is adjusting

#### 3f. Tests

- Machine: `START_RETRY` from `running` lands in `retrying`; `RETRY_SUCCESS` returns to `running`; `RETRY_FAIL` terminates in `failed`.
- Machine: `FAIL` from `running` terminates directly in `failed` (no retry state visited — deterministic failure path).
- Store bridge: `eventsForSubtaskState(Retrying, running)` returns `['START_RETRY']`; `subtaskRetryCounts` increments exactly once per `Retrying` event.
- Rust: fake adapter fails once (`Timeout`) then succeeds → `SubtaskStateChanged(Retrying)` then `SubtaskStateChanged(Running)` then `SubtaskStateChanged(Done)` in order.
- Rust: fake adapter fails twice (`Timeout` + `Timeout`) → `Retrying` then `Failed`; dispatcher returns `EscalateToMaster::exhausted`.
- Rust: fake adapter returns `SpawnFailed` on attempt 1 → NO `Retrying` emitted; dispatcher returns `EscalateToMaster::deterministic`.
- Rust: fake adapter returns `Cancelled` → NO `Retrying`, NO Layer 2 — the run's cancel path handles it.
- Test fixture: extend `ScriptedAgent` with `.fail_attempts(vec![AgentError::Timeout])` builder so tests can script per-attempt outcomes without reinventing the fake each time.

### Step 4: Master re-planning (Layer 2)

**Goal:** When Layer 1 is exhausted (worker failed its retry, or `SpawnFailed` short-circuited it), master reviews the situation and proposes replacement subtasks. **Layer 2 reuses the existing proposal flow — no new machine states and no new events.**

#### 4a. Reuse SubtasksProposed, don't invent new events

Layer 2 does not need `run:replan_started` or `run:replan_proposed`. The existing `run:subtasks_proposed` event already carries everything a replacement plan needs: the list of new subtasks, their dependencies, their assigned workers. The frontend's `handleSubtasksProposed` handler already knows how to append new nodes and transition the run back to `AwaitingApproval`.

What the backend does:
1. Status transitions `Running → Planning` (re-using the existing status, which drives master node to `thinking` visually).
2. Master produces replacement subtasks.
3. Status transitions `Planning → AwaitingApproval` (re-using the existing approval gate).
4. `run:subtasks_proposed` emitted with the new subtasks.
5. User clicks Approve → same `approve_subtasks` IPC — same dispatch path.

No new event types. No new machine states. The only *new* frontend behavior is rendering a "replaces #3" badge on the replacement subtasks, driven by the normalized `subtask_replans` table (M002).

#### 4b. Orchestrator flow

1. Layer 1 returns `EscalateToMaster` (exhausted or deterministic).
2. Original subtask's state is `Failed` (emitted from Step 3 path).
3. Run status transitions `Running → Planning` (persisted + emitted).
4. Master is called (see Step 6 for failure-handling — master can itself fail here).
5. Context gathered: original task, failed subtask id, error history, logs tail, summaries from other completed subtasks.
6. `master.replan(context)` returns a new `Plan` with replacement subtask(s). Prompt template: `src-tauri/src/agents/prompts/replan_{agent}.md`.
7. For each replacement subtask:
   - Insert into `subtasks` table with fresh ulid id, dependencies pointing at existing subtask ids where appropriate.
   - Insert a row into `subtask_replans` (M002): `(original_subtask_id, replacement_subtask_id, reason, created_at)`.
8. Status transitions `Planning → AwaitingApproval`.
9. `run:subtasks_proposed` emitted with the combined current list (the failed subtask stays in the list, marked `Failed`, so the frontend can render the "replaces #3" edge).
10. User approves (same flow as initial approval) → dispatcher resumes with the new subtasks.

If the replacement subtask itself fails twice, this same flow runs again — bounded by loop protection (4c).

**Concurrency:** Layer 2 runs while other subtasks may still be progressing (a parallel subtask's worker isn't affected by one peer entering Layer 2). The dispatcher's existing `tokio::select!` loop handles this — re-planning is just a pause between dispatcher cycles.

#### 4c. Loop protection

- Max 2 re-plans per original subtask. `COUNT(*) FROM subtask_replans WHERE original_subtask_id = :id` gives the authoritative count.
- On Layer 1 exhaustion, the orchestrator checks this count:
  - `0 or 1` → proceed with Layer 2 (master re-plan).
  - `2` → skip Layer 2 and escalate directly to Layer 3 (Step 5).
- The "original" anchor is the *root* of the re-plan chain. If subtask A was re-planned as A', and A' fails, the count attributed to A goes up by 1 (A' counts against A). This is handled by walking the `subtask_replans` table backwards from the failing replacement to its root.

#### 4d. Master prompt for re-planning

New prompt template per adapter: `src-tauri/src/agents/prompts/replan_{agent}.md`.

Key elements:
- Original task description
- Original subtask that failed (title, why)
- All error messages from attempts (Layer 1 attempt 1 + attempt 2)
- Worker logs tail (last 50 lines)
- What OTHER subtasks completed (their summaries from shared notes)
- Flags: `edited_by_user` and `added_by_user` from M002 — tells master "user cared about this" so the re-plan preserves intent.
- Instructions: "Propose a replacement approach. It might be: splitting the subtask further, using a different approach, or marking it as not-feasible (empty plan)."

#### 4e. Empty re-plan case

Master may legitimately conclude "this subtask can't be automated, skip it" and return a `Plan` with `subtasks: []` plus a reasoning string.

- UI: failed subtask shows master's note in the expanded body: "Master suggests skipping this — it requires manual handling."
- Inline buttons on the failed node: "Skip this subtask" and "Override — I'll fix it manually" (routes to Layer 3 Manual Fix).
- This IS a terminal outcome for that subtask from Layer 2's perspective. Empty re-plans do NOT consume a replan slot (nothing was persisted in `subtask_replans`), so the count stays unchanged.

#### 4f. UI changes

- When Layer 2 triggers, master node returns to `thinking` state via the existing `STATUS_CHANGED(Planning)` path. Visually: "planning again."
- Replacement subtasks appear as additional nodes via `SubtasksProposed`, with the existing layout algorithm.
- Visual cue: small "replaces #3" badge on the replacement node's header, with a dashed edge from the failed node to the replacement. The edge + badge data comes from the frontend joining `subtasks` with the `subtask_replans`-derived shape on the backend (exposed via an additional field in the `SubtasksProposed` payload: each subtask optionally carries `replaces?: SubtaskId[]`).
- Approval bar message: "Master proposes N replacement subtasks after a failure. Approve to continue." Single `ApprovalBar` component with a `variant: 'initial' | 'replan'` prop handles the copy swap (see file list below — no separate `ReplanApprovalBar` component).

#### 4g. Tests

- Fake adapter: master plans A, worker fails twice on A → master re-plans with A' → A' succeeds. Verify: `subtask_replans` has one row; `run:subtasks_proposed` fires once for re-plan; run reaches `Done`.
- Loop protection: A fails, re-plan A', A' fails, re-plan A'', A'' fails → escalate to Layer 3 (no A'''). Verify: `subtask_replans` has two rows; `human_escalation` state emitted for A''.
- Empty re-plan: master returns empty plan → UI shows skip/override options; no `subtask_replans` row inserted.
- Parallel progression: 2 subtasks in flight, one enters Layer 2 → the other continues to `Done` without pause.
- Persistence: kill app mid-re-plan (between `Planning` and `AwaitingApproval`) → recovery marks run `Failed`, `subtask_replans` rows left intact for audit. (Phase 2 recovery is cleanup-only; full resume is v2.5.)

### Step 5: Human escalation (Layer 3)

**Goal:** When automated recovery fails, hand decision authority to the user — without terminating the run.

**Trigger:** When a subtask enters Layer 3 (Layer 2 cap hit, Layer 2 master failure, or Layer 2 empty plan), the run does **NOT** transition to `Failed`. Lifecycle parks in the new `AwaitingHumanFix` status, worktrees and notes are preserved in place, and the per-run resolution channel waits for the user's decision: `manual_fix` / `mark_fixed` / `skip` / `try_replan_again` / `abort`. Only `abort` transitions the run to a terminal state (`Cancelled`) with full cleanup.

**Lifecycle invariants for Layer 3:**

- **Worktrees are NOT cleaned** while the run sits in `AwaitingHumanFix`. Cleanup happens only on successful apply, discard, or abort — the user needs the worktree available to fix the code by hand.
- **Shared notes are NOT cleared** during the park. The master's context, worker logs, and prior decisions stay readable.
- **Already-completed worker output is NOT rolled back.** Fixed-or-skipped subtasks re-enter the dispatcher pool on resume; dependents of a fixed subtask unblock naturally because the runtime's `SubtaskState::Done` makes their dependency gate pass.
- **Run status enters `AwaitingHumanFix`** on escalation and exits to `Running` when the user resolves with `mark_fixed`, `skip`, or `try_replan_again`, or to `Cancelled` on `abort`.
- **The dispatcher parks on a `tokio::select!` that includes the resolution channel receiver** alongside the existing worker-completion and cancellation branches. Receiving a `Layer3Decision` variant unblocks forward progress; no spin-loop on subtask state change is needed.
- **Cancellation still works.** The existing `CancellationToken` branch in the lifecycle select races the resolution channel; whichever fires first wins, and the other drops. See Commit 2a tests for the deadlock coverage.

**Not resumable across restarts.** A run sitting in `AwaitingHumanFix` waiting on a user decision is still treated as "active" by the Phase 2 crash-recovery path. If the app is killed or OS-restarted while the user is deliberating, boot-time recovery marks the run `Failed` and sweeps its worktrees — same behaviour as any other active-at-crash run, using the new `AwaitingHumanFix` status in `list_active_runs`'s "not terminal" set. Fully resumable Layer 3 is v2.5 territory (see `docs/KNOWN_ISSUES.md` "Partial run recovery is cleanup-only, not resume").

**Implementation split (Step 5 Commit 2a → 2b).** The lifecycle infrastructure and the IPC command implementations land in separate commits so review stays bounded:

- **Commit 2a — lifecycle infrastructure (~400-500 LOC).** `RunStatus::AwaitingHumanFix` variant + full enum audit. `Run` gains a `resolution_rx` / `escalated_subtask_ids` pair. `Orchestrator` stores a resolution-channel sender map keyed by run id (mirrors `apply_senders`). Lifecycle's Escalated branch transitions to `AwaitingHumanFix` instead of calling `finalize_failed`, then parks on a select across the resolution channel, the worker-completion receiver, and the cancellation token. `Layer3Decision` enum carries the outcome (`Fixed(SubtaskId)`, `Skipped(Vec<SubtaskId>)`, `ReplanRequested(SubtaskId)`, `Aborted`). The 4 IPC commands (`manual_fix_subtask`, `mark_subtask_fixed`, `skip_subtask`, `try_replan_again`) continue to return `InvalidEdit("not yet implemented")`; Commit 2a's gates pass without exposing new capability to the frontend. Tests: park → resolve → resume for each variant; cancel during escalation; crash-recovery sweeps `AwaitingHumanFix` runs.
- **Commit 2b — IPC command implementations (~500-700 LOC).** Drives the resolution channel: `manual_fix_subtask` calls `editor::open_in_editor` against the subtask's worktree; `mark_subtask_fixed` auto-commits any dirty diff and sends `Fixed`; `skip_subtask` walks the forward-dependency graph (`compute_skip_cascade`), marks all transitively-blocked subtasks `Skipped`, and sends `Skipped`; `try_replan_again` validates the cap via the same lineage query used for auto-trigger and sends `ReplanRequested`. `SubtaskData` gains `replan_count: u8` populated from the lineage SQL on every `SubtasksProposed` emission. Tests: each command's happy path, wrong-state rejection, diamond dependency cascade, replan cap guard, unblock-dependents-on-fix.

**UI:**
The failed subtask node enters `human_escalation` state:
- Red border (`status-failed`)
- Auto-expanded node body showing:
  - Short error summary (see display mapping below)
  - Expandable "Show full error" section with raw logs
  - Worktree path rendered as selectable text (read-only row) — useful even when an editor is detected, for users who want to drop into their own tool
- Inline buttons inside the node body (layout depends on editor detection — see Manual fix flow below):
  - **Manual fix** — opens an external editor at the worktree path (only when an editor is detected)
  - **Copy path** — puts the worktree path on the clipboard + toast
  - **Skip subtask** — marks as `skipped`, run continues without it
  - **Abort run** — kills the whole run, cleanup everything
  - **I fixed it, continue** — always present, unconditional. Marks the subtask `done` based on user assertion
  - **Try replan again** — conditionally present (see Step 6); only when the chain's re-plan cap is not exhausted

**AgentError display mapping:**

The uniform Layer 1 retry (Step 3) keeps the taxonomy intact for exactly this surface. Each variant renders a human-readable summary; the raw body goes into the "Show full error" expander.

| `AgentError` variant | UI message |
|---|---|
| `ProcessCrashed { exit_code, signal }` | `Worker crashed (exit {n}, signal {s})` |
| `TaskFailed { reason }` | `Agent declined: {reason}` |
| `ParseFailed { raw_output }` | `Agent returned malformed output` + expandable raw |
| `Timeout { after_secs }` | `Worker timed out after {n}s` |
| `SpawnFailed { cause }` | `Could not start {agent}: {cause}` |

`Cancelled` never reaches Layer 3 — cancellation bypasses the escalation ladder entirely.

The `SpawnFailed` case has its own button layout (see Manual fix flow below); it's a copy-and-routing change, not a new code path.

**Manual fix flow:**

Editor detection follows the fallback chain (authoritative, matches the Common-pitfalls note below):

1. `settings.editor` — user-configured binary path or command (e.g. `"code"`, `"/usr/local/bin/zed"`)
2. `$EDITOR` env var — from the spawn environment
3. Platform default — `open -a` on macOS, `xdg-open` on Linux, `Start-Process` on Windows
4. No editor detected — fall through to clipboard-only path

**With an editor detected** (steps 1–3 resolve to something):

- Primary button: **Manual fix** — spawns the editor with the worktree path as the argument (opens the folder, not a specific file — the user knows what to change).
- Secondary button: **Copy path** — useful for users who prefer a different tool than the detected default.
- Worktree path displayed as selectable text below the buttons (read-only, monospaced, ~1-line truncation with hover-to-reveal-full).
- Always-visible: **I fixed it, continue** — clicking marks the subtask `done` and the dispatcher resumes. The diff from the user's manual edits is captured automatically (existing post-subtask diff capture path).

**Without an editor detected** (chain falls through):

- Primary button: **Copy worktree path** — on click, clipboard is populated + toast: *"Path copied. Open in your editor, make changes, then click 'I fixed it'."*
- Always-visible: **I fixed it, continue** — same behaviour as above.
- Worktree path displayed as selectable text below the buttons.

Trusting the user is cleaner than state-machining the editor lifecycle. The "I fixed it, continue" button is unconditional precisely because there is no reliable cross-platform signal for "editor has closed" — and even if there were, a user could save-and-switch-tasks without closing. The dispatcher's diff capture after the user clicks is the source of truth for what changed.

**For `SpawnFailed` specifically,** the Manual-fix button is less useful (the binary isn't there to fix in the worktree). The primary button becomes **Check agent install → Settings → Agents** (a button that opens the settings panel's Agents section with the failing agent highlighted). The other buttons stay the same. This is copy + one routing call — not a separate code path in the dispatcher.

**Abort flow:**
- Confirmation required: "Abort the whole run? All work will be discarded."
- If confirmed: fire the run's `CancellationToken`, cancel all running workers, cleanup worktrees, clear notes, run transitions to `Cancelled` (same terminal state as any user-cancelled run — not `Idle`, which is the pre-run shell state).

**Events and commands:**
- `run:human_escalation { run_id, subtask_id, error, options }` — emitted once per escalation entry; the run status flips to `AwaitingHumanFix` in the same tick. `options` is a subset of `["manual_fix", "skip", "abort", "try_replan_again"]`. `try_replan_again` is included only when `COUNT(*) FROM subtask_replans` walked to the chain root is less than the cap (2) — see Step 4c and Step 6. `manual_fix` is included unconditionally; on `SpawnFailed` the frontend renders the "Check agent install" variant of the button but the wire option stays the same.
- The four escalation IPC commands (`manual_fix_subtask`, `mark_subtask_fixed`, `skip_subtask`, `try_replan_again`) send `Layer3Decision` variants on the per-run resolution channel (see Commit 2a). The lifecycle task receives the decision, updates subtask state, emits `SubtaskStateChanged` for each affected subtask, and resumes dispatch. `abort` uses the existing `cancel_run` IPC path — no new command.

**Tests (Commit 2a + 2b combined):**
- Fake adapter: master fails to produce replan → run enters `AwaitingHumanFix` → frontend shows escalation UI.
- Manual fix happy path: `manual_fix_subtask` returns `EditorResult::Configured`; `mark_subtask_fixed` auto-commits and transitions the subtask to `Done`; dispatcher wakes, dependents become eligible.
- Mark-fixed with empty diff: user asserts "nothing to change" — subtask still transitions to `Done`, no commit created.
- Skip with cascade: run with `A → B → C` where A escalates; `skip_subtask(A)` marks A, B, C all `Skipped` and emits three `SubtaskStateChanged` events.
- Skip with diamond: `A → B, A → C, B → D, C → D` where A escalates; skipping A cascades to B, C, D.
- Try replan again, cap not hit: replan runs, plan surfaces via `SubtasksProposed`, approval flow resumes.
- Try replan again, cap hit: backend returns `InvalidEdit("replan cap exhausted")` even if frontend sends it.
- Cancel-during-escalation: `cancel_run` while parked in `AwaitingHumanFix` transitions to `Cancelled`, drops the resolution channel cleanly, no deadlock.
- Crash recovery: app restart with a run in `AwaitingHumanFix` → run is swept to `Failed`, worktrees cleaned, `RecoveryEntry` emitted.

### Step 6: Master failure handling

Master itself can fail: API error, malformed output, timeout.

**Critical rule:** Master does NOT self-retry. If master fails during planning or re-planning, go directly to human escalation. A failing planner cannot plan around its own failure.

**UI:**
- If master fails during initial planning: show error banner above the graph, no subtasks created, user can retry submission or abort.
- If master fails during re-planning: the specific failed subtask stays in `failed` state and escalates to Layer 3. The user sees the usual manual / skip / abort options, plus — **only when the chain's re-plan cap is not yet exhausted** — a fourth option, "try replan again."

**"Try replan again" mechanics:**

"Try replan again" is not a special retry. It consumes a normal re-plan slot:

1. Visible only when `COUNT(*) FROM subtask_replans` walked back to the chain root is less than the cap (2). Once the cap is hit, the button disappears; the user falls back to manual / skip / abort.
2. Clicking it runs the Step-4b orchestrator flow a second time from the top: `Running → Planning → master.replan() → ...`.
3. A `subtask_replans` row is inserted regardless of whether this attempt succeeds or fails. Master-side failure does not get a free slot — if the planner is flaky, the cap naturally gates the loop.
4. If the attempt succeeds: replacement subtasks appear via `run:subtasks_proposed`, the approval flow resumes as normal (Step 4).
5. If the attempt fails: the subtask re-enters Layer 3. "Try replan again" is then either disabled (if the cap is now hit) or still available (if one slot remains).

No "one extra attempt" semantics. The cap is the cap. This keeps loop protection (Step 4c) authoritative — there is no way to exceed `2 re-plans per chain root` from any code path.

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

#### 7b. Auto-approve subtask ceiling

Auto-approve removes every manual gate, which means a pathological task (master splits, re-plans, splits again) could execute dozens of subtasks without a human checkpoint. A cost ceiling is the right answer long-term (Phase 6 wires tokens), but Phase 3 cannot ship auto-approve without *some* upper bound.

**Decision:** subtask-count ceiling, enforced only when auto-approve is on.

**Settings:**

```
settings.maxSubtasksPerAutoApprovedRun: number   // default 20, minimum 1
```

Persisted via the existing settings JSON file (`app_config_dir/settings.json`). Surfaced in the settings panel next to the auto-approve toggle.

**Orchestrator counter:**

- Maintained per run. Resets to 0 on run start, never on re-plan.
- Increments on *every* `subtasks.id` inserted within the run, regardless of final state: the initial plan, user additions via `add_subtask`, Layer 2 replacement subtasks, and replacements-of-replacements all count.
- Skipped subtasks count. They consumed planning capacity even if they didn't execute. User removals via `remove_subtask` do *not* decrement — the counter measures "how many subtasks has this run asked us to consider", not "how many are currently live."
- Derived on demand as `SELECT COUNT(*) FROM subtasks WHERE run_id = ?`; the orchestrator holds a cached copy and re-reads on transition boundaries.

**Enforcement points:**

Only checked at approval-bypass moments, never mid-worker. Workers already in flight are not interrupted by the ceiling.

1. **Initial approval** — if `COUNT(subtasks) > ceiling` (edge case: user added subtasks manually before hitting approve), the auto-approve bypass is suspended and the approval bar returns with the ceiling-reached message. Extremely unlikely at this point since users rarely add 20+ subtasks before approving.
2. **Re-plan approval** — at the end of Step-4b, just before re-emitting `run:subtasks_proposed`: if appending the proposed replacements would push the running total past the ceiling, the orchestrator lets the re-plan proceed to `AwaitingApproval` but emits `run:auto_approve_suspended` and does NOT auto-approve. The approval bar appears with the special copy; the user decides.

**Event:**

```
run:auto_approve_suspended { runId, reason: "subtask_limit", limit, current }
```

`limit` and `current` let the UI render "You've reached 22/20 — approve manually or edit the plan."

**What the user sees:**

- Approval bar copy becomes: *"Auto-approve paused — subtask limit reached (22/20). Review and approve manually, or adjust the limit in Settings."*
- A link in the bar: "Open settings" → deep-links to the auto-approve section.
- Approving manually re-enables auto-approve for the *rest* of the run (subsequent re-plans under the ceiling still bypass). This is deliberate: the user has given an informed go-ahead.

**Why subtask count, not wall clock or cost:**

- Deterministic and user-predictable ("this task should be 5–10 subtasks, 20 is a safe margin").
- Cost ceilings belong in Phase 6 where tokens are tracked; a wall-clock proxy would be a worse version of the same idea.
- One counter, one check per re-plan transition — implementation cost is a day at most.

**Consent-dialog copy (Step 7):**

Include a line in the first-activation consent dialog: *"Auto-approve will execute up to {limit} subtasks without asking. You can change this in Settings."* `{limit}` reads from the same settings field, so updating the setting updates the consent copy without a code change.

**Tests:**

- Auto-approve on, initial plan has 25 subtasks (ceiling 20): approval bar surfaces with ceiling message, no dispatch fires.
- Auto-approve on, initial plan 8 subtasks, master re-plans twice producing 15 more: second re-plan triggers the ceiling (total 23 > 20), user sees suspension message.
- Auto-approve on, user remove-subtasks 5 subtasks: counter is unchanged (still 8 for the initial plan). Confirms removal doesn't decrement.
- Skipped subtasks count: auto-approve on, plan of 15 subtasks, 6 get skipped; re-plan adds 4; total is 19 — under ceiling, auto-approve still bypasses.

### Step 8: Store integration for Layer 1-3

Update the Zustand store to handle the new state transitions. **Most of Layer 1–2 rides the existing event vocabulary** — Phase 3 adds only one new event.

**Reused events (no new frontend wiring needed):**
- `run:status_changed` — `Running → Planning` drives master back to thinking; `Planning → AwaitingApproval` gates the re-plan approval.
- `run:subtasks_proposed` — carries Layer 2's replacement subtasks (optionally with `replaces?: SubtaskId[]` for the "replaces #3" badge).
- `run:subtask_state_changed` — carries `Retrying`, mapped through `eventsForSubtaskState` to `START_RETRY` / `RETRY_SUCCESS` / `RETRY_FAIL` (Step 3a).

**Two new events:**
- `run:human_escalation { run_id, subtask_id, error, options }` — transitions the node's machine to `human_escalation` (Step 5). This is the only Layer-3 event.
- `run:auto_approve_suspended { run_id, reason, limit, current }` — emitted when the auto-approve ceiling (Step 7b) suspends bypass. Store flips a `autoApproveSuspended: { reason, limit, current } | null` flag that the approval bar reads; cleared on manual approval or run end.

**Store additions:**
- `subtaskRetryCounts: Map<string, number>` — incremented in `handleSubtaskStateChanged` when state is `Retrying`.
- `handleHumanEscalation` — sends the node actor the `ESCALATE` event and stores the error for display.

**XState machine additions** (`src/state/nodeMachine.ts`):
- `running → retrying → running | failed` paths via `START_RETRY` / `RETRY_SUCCESS` / `RETRY_FAIL` (Step 3a).
- `failed → human_escalation` via `ESCALATE`.
- `human_escalation → skipped | done | failed` via `SKIP` / `MANUAL_FIX_DONE` / `ABORT`.
- Remove the removed pieces from 3a: `MAX_RETRIES`, `canRetry`, `incrementRetries`.

No `escalating → proposed` path is needed — Layer 2 reuses `SubtasksProposed` to add replacement subtasks directly, which spawn fresh actors. The failed original stays in `failed`.

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
15. Auto-approve mode: subtask-count ceiling suspends bypass when exceeded, user sees `run:auto_approve_suspended` surfacing in the approval bar (Step 7b)

## Verification tally (2026-04-21)

Manual verification was done against `pnpm tauri dev` on the `fatura-budget` repo with real Claude agents. Fifteen criteria split across three verification modes:

| # | Criterion | Status | Notes |
|---|---|---|---|
| 1 | Edit proposed title inline and approve | PASS (after fix) | Fixed in `98977c4` (shrink-0 title/why) + `1e93761` (140→180 height for running/done) + `e2c6b5c` (LogBlock placeholder) |
| 2 | Change proposed subtask's assigned worker via dropdown | PASS (after fix) | Same fix chain as #1 — title/why rendered correctly in proposed state after the shrink-0 pass |
| 3 | Add a new subtask from approval bar | PASS | Auto-focus on the new input verified in `77867e6` |
| 4 | Remove a subtask before approving | PASS | X button in proposed worker card |
| 5 | Layer 1: worker fails once → automatic retry → succeeds | PASS | Retry badge + new LogBlock visible |
| 6 | Layer 2: worker fails twice → master re-plans → approve → replacement succeeds | PASS | `2fe299c` replan surface + ApprovalBar variant `'replan'` |
| 7 | Re-plan exhaustion → Layer 3 offered | Integration-verified | Covered by `orchestration::tests::worker_failure_parks_on_escalation_then_aborts`; production manual verification requires failure injection |
| 8 | Manual fix flow opens editor and continues | Integration-verified | Covered by Layer-3 IPC tests in `6bee77c`; user-side verification bounded by editor-detection fallbacks |
| 9 | Skip subtask | PASS | Skip cascades through dependents (`e9972b8`) |
| 10 | Abort run | PASS | Cancel button in TopBar (`f7fc2eb`) + actor sweep (`01f701f`) + EmptyState return (`0ddd8cd`) |
| 11 | Master failure during planning | Integration-verified | Orchestrator emits `run:planning_failed` with structured error; covered in `orchestration::tests::master_plan_error_clears_run` |
| 12 | Master failure during re-planning | Integration-verified | Layer 3 offered with retry option, covered in dispatcher re-plan tests |
| 13 | Auto-approve bypasses initial + replan approvals | PASS | Verified via settings toggle; Auto badge visible |
| 14 | Auto-approve still honors human escalation | Integration-verified | Covered by auto-approve + escalation integration tests in `f49ef39` |
| 15 | Auto-approve ceiling suspends bypass + surfaces `run:auto_approve_suspended` | Integration-verified | Subtask-count ceiling path covered by backend tests; production manual verification requires a planned-count >ceiling scenario that was out of scope for Phase 3 |

**Legend:**
- **PASS** — exercised end-to-end in `pnpm tauri dev` against a real repo.
- **PASS (after fix)** — exercised after the fix commit listed in the notes.
- **Integration-verified** — covered by automated tests (frontend unit or Rust integration) but the production manual path requires a failure-injection mechanism not in Phase 3's scope. Acceptable for shipping; Phase 4's verification matrix will revisit if these regress.

Additional bugs surfaced during the verification pass and fixed in the closeout window (all in the commit log between `78a6331` and `e2c6b5c`): worker card title/why squeezed under flex (shrink-0 pass), running/done cards overflowing the 140px default (per-state height override), empty LogBlock rendering as an opaque black rectangle (transparent bg + waiting placeholder), cancel run leaving store non-terminal (actor sweep + terminal-state guard alignment), title/why blank after edit save (re-focus on added subtask).

## What you'll create

```
src-tauri/src/
├── agents/
│   ├── mod.rs (execute signature gains extra_context: Option<&str>)
│   └── prompts/replan_{agent}.md
├── orchestration/
│   ├── dispatcher.rs (execute_subtask_with_retry + SpawnFailed short-circuit)
│   ├── escalation.rs (new — Layer 2 re-plan + Layer 3 human escalation)
│   └── run.rs (SubtaskState::Retrying added)
├── storage/
│   └── migrations.rs (M002: edited_by_user, added_by_user, subtask_replans)
├── ipc/
│   ├── commands.rs (update_subtask, add_subtask, remove_subtask; approve_subtasks unchanged)
│   └── mod.rs (SubtaskPatch, SubtaskDraft, human_escalation event, auto_approve_suspended event)
├── settings.rs (adds maxSubtasksPerAutoApprovedRun field; see Step 7b)
└── safety/mod.rs (stub for Phase 7)

src/
├── components/
│   ├── primitives/
│   │   ├── InlineTextEdit.tsx
│   │   ├── Dropdown.tsx
│   │   └── Badge.tsx
│   ├── nodes/
│   │   ├── WorkerNode.tsx (extended: inline editing + retry badge + "replaces #N" badge)
│   │   └── EscalationActions.tsx (Layer 3 buttons)
│   └── approval/
│       └── ApprovalBar.tsx (extended: variant: 'initial' | 'replan', "+ Add subtask" in initial)
├── hooks/
│   ├── useInlineEdit.ts
│   └── useExternalEditor.ts (for manual fix)
└── state/
    ├── nodeMachine.ts (retry refactor: remove MAX_RETRIES/canRetry; add START_RETRY/RETRY_SUCCESS/RETRY_FAIL; add ESCALATE)
    └── graphStore.ts (add/update/remove actions → IPC; subtaskRetryCounts; human_escalation handler; autoApproveSuspended flag)
```

Estimated LOC: ~1500 Rust, ~2000 TypeScript. Frontend-heavy because editing UX is the bulk.

## Common pitfalls

- **Inline edit UX is unforgiving.** If Escape doesn't cancel reliably, or blur saves unexpectedly, users rage-quit. Test keyboard edge cases exhaustively: Tab while editing, clicking outside, rapid enter/escape.
- **Re-plan loop is a footgun.** Without the loop limit, a pathological case could burn an entire budget on re-plans. Enforce the limit at the orchestrator level, not just UI — the authoritative count is `COUNT(*) FROM subtask_replans` walked back to the chain root.
- **Edited subtasks must persist through re-planning.** The `edited_by_user` flag (M002) lives in `subtasks`; the re-plan prompt reads it so master knows "user cared about this."
- **Retry counter belongs in the store, not the machine.** Phase 1's `MAX_RETRIES` / `canRetry` guard is removed in 3a. Don't port it back in — the machine is a reflection of backend state, retry accounting lives in `graphStore.subtaskRetryCounts`.
- **SpawnFailed is the retry exception, not the rule.** The orchestrator's retry function must short-circuit `SpawnFailed` before emitting `Retrying`. Uniform retry for everything else.
- **Layer 2 reuses events, doesn't invent them.** Don't add `run:replan_started` / `run:replan_proposed` — the status transition back to `Planning` plus a fresh `SubtasksProposed` is sufficient. New events here would duplicate Phase 2's wiring.
- **Editor detection varies by OS.** Don't hardcode `code`. Fallback chain: `settings.editor` → `$EDITOR` env var → platform default (`open -a` on macOS, `xdg-open` on Linux, `Start-Process` on Windows) → "copy path to clipboard" as last resort.
- **Safety gate hooks must be real even if Phase 3's implementation is trivial.** Phase 7 should only need to fill in `is_action_safe` — not refactor the architecture.
- **Don't let auto-approve silently swallow failures.** Auto-approve bypasses approvals, not errors. All three layers still apply.
- **React Flow intercepts pointer events on custom nodes.** Before inline-edit work lands, verify input focus and keyboard events reach nested `<input>` / `<textarea>` elements against a `pnpm tauri build` binary — Phase 2 Step 11 surfaced dev-vs-prod divergence in this exact surface area.

## Open questions deferred to Phase 4

- Should users be able to manually specify subtask dependencies during editing? (Current plan: minimal support in Phase 3, full support in Phase 4 with mono-repo dependency graphs.)
- Should the "edited" badge persist to telemetry for master fine-tuning? (Phase 5 config system might enable this as opt-in.)
- Should a failed subtask's worktree be inspectable from the UI? (Currently only accessible via manual fix editor launch.)
