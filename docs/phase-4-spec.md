# Phase 4: Build trust through visibility

**Goal:** Make the run, after it ends, something the user can inspect — not a screen that vanishes behind a diff viewer. Every worker's output, every file it touched, every crashed subprocess, every worktree path should be reachable from the canvas in one click. The run graph stops being a progress animation and becomes a record.

**Duration estimate:** 2 weeks

**Theme:** *Build trust through visibility.* Phase 3 shipped a retry/replan ladder that works — Phase 4 ships the surfaces that make it *legible*. If a worker crashed, we explain how. If a worker produced 3 files, the user can see them without waiting for Apply. If a worker's log is 800 lines long, the user can expand the card. If Apply merged, the graph stays on screen with a summary instead of collapsing to a toast.

**Success criteria:**

- After Apply, the graph remains visible with a summary overlay (files changed count, branch, commit SHA, per-worker contribution).
- Each done worker exposes per-file diff previews inline — syntax-highlighted, collapse/expand, no modal.
- Agent subprocess crashes (non-zero exit with no output, stdout hang, malformed JSON) produce a distinct `crashed` state, a crash event, an ErrorBanner variant, and route into the existing Layer 1 retry ladder.
- Worker cards expand to show full log output on click, reflow the graph via dagre, and collapse on second click.
- Done / failed / escalated workers expose Reveal in Finder/Explorer, Copy path, and Open terminal affordances on the worktree path — this is the first UI surface of a path that was previously treated as implementation detail.
- Gemini CLI is restricted to worker-only; the master picker does not offer it, and selected-master persistence migrates anyone currently configured to Gemini-as-master.

## Why this matters

Phase 3's retrospective called out three bug classes that all had the same root cause: *the user couldn't see what happened.* The empty LogBlock rendered as a black hole. The running → done height squeeze hid content. The "0 files changed" moment after a successful Apply left the user guessing whether the run actually worked. Phase 3.5 patched the worst of them (height overrides, master heartbeat, per-subtask diff chip), but the gaps that remained — Apply destination unclear, logs truncated at the tail, worktree path never shown, crashes indistinguishable from "worker still running" — are the backlog of *trust-breakers*. Each one makes the user ask "did that work?" instead of "what should I do next?"

Visibility is the cheapest trust-building material we have. No new orchestration, no new state machines, no new migrations (unless Step 5 uncovers one). The phase is mostly UI, one diagnostic spike, and one subtraction (Gemini master).

## What this phase does NOT include

Defer to Phase 5+:

- **Mono-repo awareness in planning** — deferred to Phase 5. Phase 4 ships single-repo visibility only.
- **Merge conflict resolution UX** — Phase 4 continues to expose `run:merge_conflict` honestly via ErrorBanner (Phase 3 surface) with no new resolution affordances. Resolution path lands in Phase 5 alongside the base-branch dirty helper.
- **Base-branch dirty stash helper** — still all-or-nothing. Phase 5.
- **Interactive agent Q&A channel** — still deferred. Workaround remains "frame tasks specifically." Phase 5 at earliest; scope is cross-stack (UI surface + backend channel + agent-adapter extensions).
- **Gemini-as-master latency fix** — Phase 4 subtracts Gemini from the master picker; it does *not* attempt the stream-json / PTY / downgrade paths enumerated in KNOWN_ISSUES. That decision lands in Phase 5 or later after we see whether the worker-only path is sufficient for users.
- **Full IDE-grade diff viewer** — Phase 4 ships B-lite (syntax-highlighted unified diff, inline, collapse/expand). Not in scope: side-by-side view, in-place edit, word-level intra-line diff, inline comments, "stage this hunk" UX.
- **Partial run recovery (resume-on-crash)** — current behavior (mark Failed + sweep worktrees on startup) remains. Resumable runs land with the headless server (v2.5).
- **Cost tracking wiring** — schema exists, no readers/writers. Phase 6.
- **Safety gate real policy** — `is_action_safe` still returns `true`. Phase 7.

## Prerequisites

Phase 3 and Phase 3.5 shipped and stable:

- Retry ladder (Layer 1 worker retry / Layer 2 master replan / Layer 3 human escalation) working end-to-end.
- `AwaitingHumanFix` run status + `human_escalation` subtask state in place.
- Per-subtask `SubtaskDiff` event + "N files" chip + popover on done workers (the Phase 4 diff preview extends this popover rather than replacing it).
- Process-group cancel working on Unix (Windows still Unix-only — tracked in KNOWN_ISSUES, not touched in Phase 4).
- Zoom bounds / Controls / keyboard / scroll-pan behavior settled from Phase 3.5 — Phase 4 does not change pan/zoom defaults.

## Architecture changes

Phase 4 is mostly UI — the biggest architectural change is a new subtask state and one new event for agent crashes, informed by the Step 0 diagnostic. Everything else is additive on existing surfaces.

```
Existing (Phase 3)                       Added (Phase 4)
──────────────────                       ──────────────────
SubtaskState enum                        + Crashed        (only if Step 0 finds
                                                           distinguishable signal)
Events                                   + run:agent_crashed
                                         + run:apply_summary (emitted on Applied)

Run terminal rendering                   + ApplySummaryOverlay (pinned over graph
                                           after Applied; graph stays mounted)

WorkerNode affordances                   + log expand / collapse
                                         + reveal / copy path / open terminal
                                         + crash variant in ErrorBanner

DiffPopover (Phase 3.5)                  + per-file unified diff
                                         + syntax highlighting (Shiki lazy-loaded)
                                         + virtual-scrolled body for large diffs

Master picker                            − Gemini removed; fallback chain stays
                                           (claude → codex → gemini-as-worker-only)
```

The only backend work of non-trivial size is Step 5 (crash detection + event), and its shape depends on Step 0's findings. Everything else is frontend.

## Step-by-step tasks

The ordering below front-loads the diagnostic (Step 0) and the smallest foundational change (Step 1), then stacks the three independent UI wins (Steps 2, 3, 4), then uses the Step 0 findings (Step 5), then closes with the largest single piece (Step 6). This mirrors Phase 3's pattern of "prerequisite before dependent steps" and Phase 3.5's pattern of "ship the small observations first, save the long tail for last."

---

### Step 0: Diagnostic — what does "crash" actually mean?

Before we write any crash-surface UI, we need a clear taxonomy. "Crash" in the user's bug report could mean any of: subprocess exit non-zero with stderr, subprocess exit zero with malformed JSON, subprocess hang with no output past timeout, internal panic / unwrap that the orchestrator absorbs, or adapter parse error that turns into a `Failed` transition. Phase 3's ladder treats all of these as `Failed` → Layer 1 retry → Layer 2 replan, and the user sees "subtask failed" — but some of these are *retryable* (transient exit, rate limit) and some are *not* (malformed JSON on every attempt, missing binary). Phase 4's crash UI must distinguish the two, and that distinction starts with the diagnostic.

**Scope (what it does):**

- Inventory every place a worker can exit abnormally across the three adapters (`src-tauri/src/agents/{claude,codex,gemini}.rs`) and the dispatch path (`src-tauri/src/orchestration/dispatcher.rs`, `lifecycle.rs`).
- Categorize each exit shape: (a) subprocess non-zero exit, (b) subprocess zero exit + empty / malformed stdout, (c) subprocess hang past timeout, (d) spawn failure (binary missing / permission denied), (e) internal orchestrator error (absorbed panic, channel closed mid-run).
- Write a failing integration test per category using the existing fake-agent fixture pattern (`src-tauri/src/agents/tests/` — extend with a `crash_fixtures/` subdirectory of shell scripts). Assert the current behavior — what state does the subtask end in, what event gets emitted, what does the user see.
- Produce a short diagnostic report (appended to this spec or written as `docs/phase-4-crash-diagnostic.md`) listing each category, which are already distinguishable in the existing `AgentError` enum, which collapse to a single `Failed` indistinguishable from adapter-level failures, and which mitigations already exist (retry) vs which need Phase 4 work (distinct state + event).

**Scope (what it does NOT):**

- Does not implement the crash state or event — that's Step 5.
- Does not add new retry logic — the existing Layer 1 retry already handles most transient categories. Step 5 may add a `SpawnFailed`-style skip-Layer-1 rule for unrecoverable crashes, but that decision comes out of this diagnostic, not into it.
- Does not touch Windows — process-group kill is Unix-only (KNOWN_ISSUES). Windows crash surface inherits whatever semantics Step 5 builds on Unix; Windows-specific quirks wait for the v2.5 Job Object work.

**Acceptance criteria:**

- Integration test file `src-tauri/src/agents/tests/crash_shapes.rs` (or equivalent location) with at least 5 tests, one per category, each asserting the current (pre-Phase-4) behavior and each passing on `main`.
- A written taxonomy (5 categories minimum) with for each: what causes it, what the user currently sees, whether it's distinguishable from a "normal" worker failure in today's events, and a recommendation — "already distinguishable, UI work only" vs "needs new state + event" vs "needs new state + event + skip-Layer-1 routing."
- The taxonomy drives the Step 5 scope. If the diagnostic finds that all categories are already distinguishable via existing `AgentError` variants, Step 5 shrinks to a UI-only step; if it finds collapse, Step 5 adds the `Crashed` state + `run:agent_crashed` event below.

**Open questions:**

- Does `dispatcher.rs` currently log the adapter error type, or is it flattened to a String by the time it reaches `run:subtask_state_changed` payload? (Affects whether UI can discriminate without new events.)
- Are rate-limit errors (429, "quota exceeded") surfaced as their own `AgentError::RateLimited` today, or collapsed into a generic failure? Phase 3.5's benchmarking for Gemini hinted at rate-limit-after-cold-start — does the adapter catch it?
- Do timeouts exist at all in the dispatch path? If a subprocess hangs with no output, does anything kill it, or does it run until the whole run is cancelled?

**Risk flags:**

- Low-risk overall: this is a read-and-measure spike, no production code change.
- **Risk of scope creep:** if the diagnostic finds 10 distinct failure modes we can't all fix in Phase 4. Mitigation: the spec explicitly caps Step 5 at "distinguishable crash surface" — remaining categories graduate to Phase 5 or to KNOWN_ISSUES with rationale.
- **Risk of diagnostic-first slipping the whole phase:** if Step 0 takes a full week, every other step slides. Mitigation: cap Step 0 at 2 days; if it overruns, ship a partial taxonomy and let Step 5 scope to whatever was classified by the cap.

**Estimated complexity:** small (1.5 days: 0.5 day inventory, 1 day fixtures + tests + write-up).

---

### Step 1: Gemini restricted to worker-only

The cheapest, foundational change. Phase 3.5 benchmarked Gemini CLI as ~60× slower than Claude as master (226-239s TTFB for minimal planning). No 1-line adapter fix; the latency lives upstream. Rather than leave a footgun in the master picker, Phase 4 removes Gemini from the selection set. This also simplifies the crash diagnostic in Step 0 — one less adapter with the "cold start fast, steady state slow" failure mode to reason about.

**Scope (what it does):**

- `AgentKind` gains a capability metadata (or its callers gain a helper) that marks each agent as `SupportsMaster`, `SupportsWorker`, or both. Gemini is `SupportsWorker` only. Claude and Codex are both.
- `detect_agents` still detects Gemini and returns it as available for worker-only use.
- The master picker UI (TopBar chip dropdown, `AgentSetupState` cards) filters to `SupportsMaster` agents only. Gemini no longer appears as a master option.
- `recommended_master` fallback chain changes from Claude → Codex → Gemini to Claude → Codex. If neither is available, `recommended_master` is `None` (user sees the setup state asking them to install Claude or Codex).
- Settings migration: if `settings.json` has `masterAgent: "gemini"`, rewrite to the first available master-capable agent on load, or to `None` if none available. Surface this once via a toast ("Gemini can no longer be used as master — switched to Claude" or similar).
- KNOWN_ISSUES.md entry updated: the "Gemini CLI is too slow to use as master" entry moves from "open" to a new "Resolved in Phase 4 — restricted to worker-only" section, with a forward-looking note that upstream improvements + revisit are Phase 5+.
- CLAUDE.md architectural decision 1 (the fallback chain line) updated to match.

**Scope (what it does NOT):**

- Does not remove Gemini's adapter code. Gemini-as-worker continues to work exactly as it does today.
- Does not explore stream-json / PTY mitigations. Those remain KNOWN_ISSUES items.
- Does not change the fallback chain's ordering between Claude and Codex.

**Acceptance criteria:**

- TopBar master chip dropdown shows only Claude and Codex (plus "not installed" disabled entries). Gemini does not appear.
- `AgentSetupState` shows Gemini's card labeled as "worker-only" with no "set as master" CTA.
- `recommended_master` returns `None` when only Gemini is installed. EmptyState / AgentSetupState prompts the user to install Claude or Codex.
- Settings migration test: boot with `masterAgent: "gemini"` in settings.json + Claude available → post-boot, `selectedMasterAgent` is Claude and settings.json reflects it; toast shown once.
- Existing Gemini worker integration tests continue to pass — no behavioral regression on the worker path.
- KNOWN_ISSUES.md and CLAUDE.md updates land in the same commit.

**Open questions:**

- Is the migration toast the right surface, or is a one-time dismissable banner on app launch better? (Toast is lighter-weight; banner is harder to miss.)
- Should `AgentKind::Gemini` gain a `Cargo.toml` feature flag in case we want to ship a variant without it entirely? **Recommend no** — adds complexity for a decision we may reverse in Phase 5 when we revisit latency.
- Should the worker picker (per-subtask `assigned_worker` override in the approval flow) also hide Gemini by default, or is that explicit user choice fine? **Recommend keep Gemini visible in worker picker** — there's no safety issue, users can opt into slow worker execution knowingly.

**Risk flags:**

- **Migration edge case:** user has `masterAgent: "gemini"` in settings and neither Claude nor Codex installed. Should show AgentSetupState, not silently break into a null master. Test covers this.
- **Hidden "settings export/import" path:** Phase 3 included YAML config export; check whether exported configs include `masterAgent`. If yes, importing an old config with `gemini` master needs the same migration. Small but real.

**Estimated complexity:** small (1 day: 0.5 day implementation, 0.5 day migration + tests + docs).

---

### Step 2: Apply summary overlay

Today: user clicks Apply, the merge succeeds, the graph freezes for ~200ms, the final node transitions to `done`, and the user sees… the same graph, with no clear signal that anything changed. The "0 files changed" bug in Phase 2 (`8f4fe97`) was the symptom of this — even when Apply worked, the feedback was invisible.

Phase 4 makes Apply feel like a destination: the graph stays mounted (not dismounted), and an overlay pins to the canvas showing files changed count, the commit SHA that landed, the branch it landed on, per-worker contribution (N files from worker X, M files from worker Y), and a Dismiss affordance.

**Scope (what it does):**

- New event `run:apply_summary` emitted from the orchestrator on Applied transition. Payload: `{ runId, commitSha, branch, filesChanged, perWorker: [{ subtaskId, filesChanged }] }`.
- Backend computes the summary from the merge result — this data is all already available in `MergeResult`. The event is effectively a re-projection.
- New component `ApplySummaryOverlay` pinned over the graph (fixed position, lower-right or top-right — visual-design decision in the open questions). Renders the summary, each worker contribution as a clickable row that scrolls/centers the corresponding node, and a Dismiss button.
- On Applied, the graph does not unmount or reset. Nodes stay in their final state; the overlay layers on top.
- Dismiss transitions the run to `Idle` (fresh task input) as today's behavior does on its own.

**Scope (what it does NOT):**

- Does not change the Apply action itself — same IPC, same merge logic.
- Does not include a "view diff again" CTA — Step 6's diff preview is available on each worker node; the overlay just links/scrolls to them.
- Does not add push-to-remote, PR-open, or git-log affordances. Those are Phase 5+ adjacent-features.

**Acceptance criteria:**

- Apply a successful run → graph stays visible, overlay appears with commit SHA (short, 7 char), branch name, total files changed, per-worker breakdown.
- Clicking a worker row in the overlay scrolls / centers the graph on that worker node (reuse React Flow's `fitView` or `setCenter`).
- Dismiss hides the overlay and resets the run to Idle for a new task.
- Overlay position / layering does not obstruct the master node in any plan size up to 10 subtasks (visual check).
- Event emission is order-invariant against other Applied-path events: `run:diff_ready` → `run:status_changed { Applied }` → `run:apply_summary`. One orchestration integration test snapshots this ordering.
- Discard path is unchanged — no overlay, graph clears as before.

**Open questions (resolved before implementation):**

- **Overlay position:** bottom-right — matches the approval bar's "task-level sticky surface" pattern users have already learned. Rendered inside `ReactFlowProvider` as a sibling of `GraphCanvasInner`, positioned `absolute bottom-4 right-4 z-20` against the main's relative container.
- **Auto-dismiss vs sticky:** sticky — require explicit Dismiss or new-task submit. Apply is the moment the user wants to inspect; auto-dismiss fights the theme.
- **Commit SHA clickable?** plain text + Copy SHA affordance. Full 40-char SHA written to clipboard; display truncates to 7 chars. GitHub links deferred to a phase that also handles push state.
- **Persist across new task submit?** auto-cleared via `submitTask`'s existing `reset()` call — no new wiring needed.
- **Per-worker click behavior:** React Flow `setCenter(cx, cy, { zoom })` with the *current* viewport zoom read from `getViewport()` — same pattern as `WorkerNode`'s DependsOn pan. Preserves user zoom; `fitView` would be destructive.

**Risk flags (resolved):**

- **Graph mount/unmount race:** `App.tsx` previously routed `status === 'applied'` to EmptyState, which unmounted the graph under the new overlay. Fixed: `applied` now falls through to `GraphCanvas`. Dismiss → `reset()` → store returns to `idle` → App.tsx routes back to EmptyState.
- **Deferred-detach ordering:** backend emits `DiffReady → Completed → StatusChanged(Done) → ApplySummary`. The frontend's pre-Phase-4 pattern detached the subscription on `Completed`, which would drop `ApplySummary` mid-sequence. Fixed: detach is now triggered by `ApplySummary` itself (and still fires on `failed`/`rejected`/`cancelled` as before). Integration tests pin the new invariant.
- **Per-worker attribution edge cases:** same worker writing the same file twice rolls up under that worker's count; two workers writing the same file are each credited for their touch. `per_worker_counts` is the set of files *that worker's diff reported*, not the post-merge union, so attribution matches authorship intent. Confirmed by reading the merge-phase loop.

**Estimated complexity:** small-to-medium (2 days: 0.5 day backend event, 1 day overlay component + layout, 0.5 day integration tests and graph-state interaction).

**Status:** shipped in `feat(phase-4): step 2 — apply summary overlay`.

---

### Step 3: Worker log expand

Today the LogBlock shows the last ~3-5 lines of the worker's output. Phase 3 explicitly called out "no inline expansion to view a worker's full log beyond the tail" as open debt. A worker that ran for 90 seconds and produced 400 lines of output is currently only readable via the external editor (Layer 3 escape hatch) — which is overkill for the "I just want to see what it did" case.

**Scope (what it does):**

- WorkerNode gains an expand / collapse toggle: click the card body (outside interactive elements like the files chip and cancel button) to expand to ~500-600px height, showing the full log in a scrollable container. Click again to collapse back to the state-appropriate height (180-260px).
- Expanded state is per-node, not global — user can expand multiple workers simultaneously.
- Dagre auto-reflow runs on height change. Graph re-layouts so adjacent nodes don't overlap.
- Keyboard affordance: focus a worker node, press Enter or Space to toggle expand.
- Visual state: expanded cards get a subtle "pinned open" indicator (a chevron rotation or similar) so the user can tell at a glance which nodes are expanded when the graph is busy.

**Scope (what it does NOT):**

- Does not add log-level filtering (errors only, info only) — that's Phase 5+ territory.
- Does not add log search (Cmd+F within a node) — same bucket.
- Does not persist expand state across app restarts — purely in-session.
- Does not expand the *master* node. Master log is already shown via the heartbeat + persistent log surface; the expand pattern is worker-specific.

**Acceptance criteria:**

- Click worker card body (away from chips/buttons) → card grows to 500-600px, dagre re-layouts graph, full log visible in scrollable container.
- Second click → card collapses to state-appropriate height.
- Keyboard: Tab to worker, press Enter → expand; press Enter again → collapse.
- Multi-expand: expand two workers, verify graph layout accommodates both.
- Click on files-chip or cancel button does NOT toggle expand (existing handlers still fire, `stopPropagation` where needed).
- Screen reader announces expanded state via `aria-expanded` on the worker card container.
- Existing Phase 3 state transitions (proposed / running / done / failed / escalated) all respect expand — expanding a running worker continues to stream new log lines into the expanded container.

**Open questions (resolved before implementation):**

- **Tap targets:** expand is disabled in `proposed` state (checkbox toggle owns the whole-card click there). Enabled on `running` / `retrying` / `done` / `failed` / `human_escalation` / `cancelled` — the `EXPANDABLE_STATES` set is duplicated in `WorkerNode` (UI gate) and `GraphCanvas` (layout height gate) on purpose, so each reads independently authoritative.
- **Height ceiling:** fixed at 560px. Does NOT scale to viewport. Deliberately avoids the "one expanded worker eats the canvas" failure on tall monitors.
- **Log tail cap:** 2000 lines rendered by default with a "Load 2000 more above" button that bumps the window up to a 10,000-line hard cap. Virtual scroll NOT introduced — scope stays small; Phase 5 can refactor to reuse Step 6's `@tanstack/virtual` for diffs if we bring it in.

**Risk flags (resolved):**

- **Animation approach:** CSS `height 150ms ease-out` on the NodeContainer, NOT framer-motion. Dagre reflow is handled by React Flow's own position animation. Framer-motion is overkill for a linear height change and carries the dev-mode freeze risk flagged in Phase 3.5 KNOWN_ISSUES.
- **Hit-test collision with proposed-state:** `onCardClick` routes to `toggleSubtaskSelection` while `proposed` and `toggleWorkerExpanded` otherwise. Interactive children (chip, dropdown, inputs, remove button) already wear `stopPropagation` so the card-level handler only fires from empty padding / title / log regions.
- **Stuck-open defense:** the ExpandedLogBlock and the NodeContainer's a11y attrs are double-gated on `canExpand`. If a subtask's state transitions out of `EXPANDABLE_STATES` (e.g. to `skipped` / `escalating`) while its id remains in the set, the card reverts to its state-tier height and the tail LogBlock, and re-expands naturally if the state returns to an expandable one.
- **Replan drop:** `handleSubtasksProposed`'s scrub path drops `workerExpanded` entries for ids removed by a replan, alongside the existing `nodeLogs` / `subtaskRetryCounts` / `subtaskDiffs` cleanup.
- **Memory:** the render window caps at 10k lines per card. Store growth is unbounded today (same as pre-Step-3); Phase 5 will cap storage.

**Estimated complexity:** medium (3 days).

**Status:** shipped in `feat(phase-4): step 3 — worker log expand`.

---

### Step 4: Worktree inspection affordances

Today: a failed or escalated worker's worktree path is visible only to the Layer-3 "Manual fix" action, which opens an editor inside it. There's no way to reveal it in Finder/Explorer, copy the path, or open a terminal at it. CLAUDE.md's "never expose worktree paths in UI" rule was written assuming the worktree was purely an implementation detail — Phase 3 broke that by shipping the Layer 3 editor-open affordance, which *does* expose the path (via the IDE). Phase 4 makes the exposure intentional and consistent: done / failed / escalated workers all get the same three affordances.

**Scope (what it does):**

- New component `WorktreeActions` that renders as a popover / menu off a "..." or folder-icon affordance on the worker card footer (only on done / failed / human_escalation / cancelled states — not running, not proposed).
- Three actions:
  - **Reveal in Finder** (macOS) / **Show in Explorer** (Windows) / **Open in Files** (Linux). Reuses `tauri-plugin-opener`.
  - **Copy path** — writes the absolute worktree path to clipboard.
  - **Open terminal at path** — shells out to the OS-default terminal. macOS: `open -a Terminal PATH`. Windows: `start cmd /k cd /d PATH`. Linux: detect first-available of gnome-terminal / konsole / xterm — fall back to Copy path with a toast "no terminal detected" if none.
- The Layer 3 "Manual fix" affordance stays as-is (it opens the editor); the new menu is an expansion of what's already partially exposed.
- The Apply summary overlay (Step 2) does NOT include worktree affordances — worktrees are cleaned up post-Apply, so paths are gone. The affordances only apply pre-Apply or on failure/escalation.
- CLAUDE.md's "never expose worktree paths" rule gets an explicit carve-out updated: "paths are exposed on workers in inspectable states (done / failed / escalated / cancelled) via the WorktreeActions menu only."

**Scope (what it does NOT):**

- Does not expose worktree paths on running workers — the worker's still writing there, and we don't want users poking at it mid-run.
- Does not add in-app file-tree browsing. If the user wants to see files, they Reveal.
- Does not add Linux terminal auto-detection beyond first-match-of-common-list. Unusual setups fall back to Copy path.
- Does not change the worktree creation / cleanup lifecycle.

**Acceptance criteria:**

- Done worker card shows the folder-icon affordance in the footer. Click → menu with three items.
- Reveal in Finder opens the correct worktree in Finder (tested on macOS).
- Copy path writes the absolute path to clipboard, toast confirms "path copied."
- Open terminal launches the OS terminal pointed at the worktree (at least macOS; Linux/Windows tested if possible in CI, otherwise deferred to manual QA).
- Failed worker, human_escalation worker, cancelled worker: all three also expose the menu.
- Running worker, proposed worker: menu is absent — affordance doesn't render.
- Layer 3 "Manual fix" continues to work as today; the new menu is additive.
- CLAUDE.md update lands in the same commit as the code.

**Open questions:**

- **Security:** can a malicious task name lead to a worktree path containing shell metacharacters, which then get passed to `open -a Terminal $path`? Today we generate the worktree directory name from `{run_id}/{subtask_id}` (both ULIDs — safe). But worth auditing whether `shell: false` execution is used consistently. Recommend: use the Tauri shell plugin's structured-argument API (no string concatenation), not raw `Command::new("sh").args(["-c", ...])`.
- **Windows terminal behavior:** `start cmd /k cd /d PATH` opens CMD. PowerShell-first users will prefer `pwsh` / `powershell`. Default to CMD, add a setting later if users push back.
- **Clipboard on Linux without a session manager:** `tauri-plugin-clipboard` handles this, but some headless setups fail silently. Surface an error toast if clipboard write fails.
- **Does "Open terminal" on macOS use Terminal.app or iTerm?** `open -a Terminal` picks Terminal.app. Users with iTerm configured as default terminal will prefer it. Recommend: honor the macOS default via `open`-without-app-flag if the worktree path is passed as a directory — test whether this opens iTerm when set as default.

**Risk flags:**

- **Clobbering Layer 3 mechanism:** the editor-open path uses `tauri-plugin-opener`. Terminal-open reuses it. Verify no state is leaked between them.
- **Cross-platform CI coverage:** macOS + Linux in CI; Windows not. Windows terminal affordance ships untested in CI and relies on manual verification before release. Flag accordingly.

**Estimated complexity:** small-to-medium (2 days: 0.5 day backend shell affordances, 1 day menu UI + keyboard, 0.5 day cross-platform testing + CLAUDE.md update).

---

### Step 5: Agent crash detection and surface

Informed by Step 0's diagnostic (`docs/phase-4-crash-diagnostic.md`). **Decided: event-field branch.** Step 0 found the Rust-side `AgentError` enum already distinguishes every category we care about — the gap is the IPC event contract. `SubtaskStateChanged` carries only a flat `SubtaskState::Failed` plus a diagnostic string, collapsing the backend's five-way classification (`ProcessCrashed` / `TaskFailed` / `ParseFailed` / `Timeout` / `SpawnFailed`) into an opaque "it broke." We thread the needle by extending the existing failure event with a discriminant field — no new `SubtaskState` variant, no SQLite migration, no XState reshuffle.

**Scope (what it does):**

- Add an `ErrorCategory` enum on the wire mirroring the five Step-0 categories, serialized kebab-case:
  - `process-crashed` (Rust: `AgentError::ProcessCrashed`)
  - `task-failed` (Rust: `AgentError::TaskFailed`)
  - `parse-failed` (Rust: `AgentError::ParseFailed`)
  - `timeout` (Rust: `AgentError::Timeout`)
  - `spawn-failed` (Rust: `AgentError::SpawnFailed`)
  - `orchestrator-panic` (Rust: `DispatchOutcome::Failed` wrapping a worker-task panic — Step 0 Category F)
- Extend the existing `subtask_state_changed` event payload with `errorCategory: Option<ErrorCategory>`. Non-Failed transitions send `None`; Failed transitions send `Some(category)` mapped from the `AgentError` / `EscalateToMaster` discriminant at the `TaskFailed`/`DispatchOutcome::Failed` boundary in `orchestration/dispatcher.rs` + `orchestration/lifecycle.rs`.
- Mirror in `src/lib/ipc.ts`: `errorCategorySchema = z.enum([...]).optional()`, add to `subtaskStateChangedSchema`. Zod's `.optional()` keeps pre-Phase-4 payloads compatible (they'd arrive with the field absent).
- ErrorBanner / worker-node caption gain copy variants keyed on `errorCategory` — distinct strings per category (e.g. "Agent crashed (segfault)" vs "Agent refused task" vs "Agent timed out after 10 min"). Unknown / absent category falls through to the current generic "Agent failed" copy so older runs keep rendering.
- Retry routing (Layer 1 / Layer 2) **does not change in this step**. The current `EscalateToMaster::Deterministic` / `Exhausted` split already routes `SpawnFailed` / `ParseFailed` past Layer 1 as documented in Phase 3. Step 5 only reveals the distinction to the UI; if a future phase wants to change routing per category, the discriminant is now on the wire for the decision.

**Scope (what it does NOT):**

- Does not add a `SubtaskState::Crashed` variant (the spec's original "full branch"). Step 0 confirmed state is not the right carrier — the distinction is per-instance, not per-lifecycle. No SQLite schema change, no node machine reshuffle.
- Does not add a new `run:agent_crashed` event. One failure event with a discriminant is cheaper than two events the frontend has to correlate.
- Does not add timeout enforcement where none exists. `run_streaming` already enforces a wall-clock timeout (Step 0 Category D); this step just names it distinctly on the wire.
- Does not add telemetry / metrics for crash frequency. Phase 6 cost-tracking work can extend the same tables.
- Does not differentiate Unix vs Windows. Same category mapping on both; Windows Job Object work (KNOWN_ISSUES, v2.5) improves signal fidelity without changing the surface.

**Acceptance criteria:**

- Each of the six `ErrorCategory` values round-trips cleanly from backend classification to UI copy — verified by one integration test per category driving the fake-agent fixture to the failure state and asserting both the event payload and the rendered copy.
- Legacy payloads without `errorCategory` render with the generic "Agent failed" fallback (`.optional()` Zod path). Verified by a parser test with the field omitted.
- `classify_nonzero`'s heuristic is surfaced: a worker CLI exit with stderr matching `/cannot|refuse|unable|failed to/i` on a non-zero exit is reported as `task-failed`, not `process-crashed`. Documented in KNOWN_ISSUES.md alongside Phase 4 Step 1's rate-limit entry.
- Snapshot test covering the new copy variants for every category (includes accessibility labels).

**Open questions:**

- **Category F (orchestrator panic) source:** dispatcher wraps `JoinError` with a prefix `"worker task panicked: "`. Do we surface that string as detail, or do we synthesize fresh copy? **Recommend:** use the dispatcher string as-is — it's already shipped in the `DispatchOutcome::Failed` error field today, so the "detail" pipe is unchanged; only the category tag is new. UI copy: "Orchestrator worker panicked — please report this."
- **Banner persistence:** should the crash category persist in the node caption after a successful retry, or vanish? **Recommend:** vanish. A successful Layer-1 retry clears the category on the next `state_changed` event (it transitions `Retrying → Running`, and a subsequent `Running → Done` sends no `errorCategory`). The run-level ErrorBanner still cleared when the run reaches a terminal state.

**Risk flags:**

- **Wire drift between Rust `AgentError` and TS `errorCategory`:** easy to add a Rust variant and forget the Zod mirror. Mitigation: a single authoritative mapping function (`AgentError → ErrorCategory`) in `src-tauri/src/ipc/mod.rs` with an exhaustive match on `AgentError`, plus a unit test that iterates every `AgentError` variant and asserts a non-panicking mapping.
- **Snapshot bloat:** adding copy for six categories × three surfaces (banner, node caption, accessibility label) is 18 strings — manageable, but lives in the component module rather than an i18n bundle (Phase 6 candidate).
- **Error event emitted after terminal state:** already guarded by lifecycle state machine; the new field doesn't change dispatch, only the payload. Integration tests should still include a "dispatch rejected after terminal" assertion to guard against regressions.

**Estimated complexity:** small-to-medium. Event shape extension + six copy variants + per-category tests ≈ **1.5 days** (half the original "full-branch" estimate, and a hair over the "UI-only" estimate because the backend still needs the mapping function + serde plumbing).

---

### Step 6: Diff content preview (B-lite)

The biggest single piece, and the most visible payoff for the "trust through visibility" theme. The "N files" chip + popover from Phase 3.5 currently shows file *names* only. Phase 4 extends the popover to include per-file unified diff content, syntax-highlighted, collapse/expand per file, inline (not modal), in the existing popover surface.

**Scope (what it does):**

- The per-subtask diff event (`run:subtask_diff`) already includes `FileDiff` records. Today those records may or may not include full content — audit and extend. The backend must include unified-diff text per file (not just filename + stat). If content is already there, no backend change; if not, extend `FileDiff` with a `unifiedDiff: string` field.
- Syntax highlighting via **Shiki** (chosen over lowlight + diff2html for its first-class TypeScript + React integration and the active maintenance). Shiki is lazy-loaded — the DiffPopover imports it dynamically so the main bundle doesn't inflate.
- Each file in the popover renders as a collapsed header (filename + `+N / −M` stat) by default. Click the header to expand, showing the unified diff with syntax highlighting.
- Large-diff handling: for files with > 500 changed lines, render with virtual scrolling (react-virtuoso or @tanstack/virtual). Alternatively, show the first 500 lines and a "Load more" affordance. Decide based on benchmark; virtual scroll is cleaner but pulls in a dependency.
- The Step 2 Apply summary overlay's per-worker rows link into this popover on the corresponding worker node.

**Scope (what it does NOT):**

- Not side-by-side diff. Unified diff only.
- Not inline edit or "stage this hunk." Read-only preview.
- Not word-level intra-line diff highlighting. Line-level changes only.
- Not inline commenting. Phase 5+ if ever.
- Not a replacement for the `git diff` CLI output if users prefer it — the Reveal-in-terminal affordance from Step 4 gets them there.

**Acceptance criteria:**

- Done worker's chip popover: each file collapsed by default with `+N / −M` stat line. Click filename row → expands to show unified diff with syntax highlighting.
- Shiki loaded lazily — main bundle size does not increase measurably (< 5KB over Phase 3.5 baseline). Shiki itself loads on first popover open.
- Files with 10k+ changed lines render without blocking the main thread for > 100ms. Verified with a synthetic fixture in a benchmark test.
- Languages covered for syntax highlighting: TypeScript, JavaScript, JSX/TSX, Rust, CSS, HTML, JSON, Markdown, shell, Python. Anything else falls back to a plain-text theme.
- Deleted / added file handling: deleted files render as "-" lines only; added files as "+" lines only; renames show as a single file with the rename header.
- ErrorBanner / popover aria-roles from Phase 3.5 remain correct (popover still uses `role="dialog"` + `aria-labelledby`).

**Open questions:**

- **Shiki vs lowlight + diff2html:** Shiki uses VS Code themes (token-level accuracy), lowlight + diff2html is smaller but less fidelity. Recommend Shiki — the extra ~200KB (lazy-loaded) is worth the fidelity, and users will compare the inline diff to their editor; matching VS Code is the implicit baseline.
- **Theme matching:** WhaleCode is dark-only with a specific palette. Shiki's default `dark-plus` matches VS Code's default dark theme. Recommend: use `dark-plus` for now; custom theme matching the WhaleCode palette is a Phase 5 polish if users notice.
- **Virtual scrolling dependency:** add @tanstack/virtual (already commonly paired with React Flow-adjacent codebases) vs "load more" button with no new dep. Recommend virtual scroll — "load more" is janky on a 10k-line file; the dependency is small and the UX is right.
- **When a file is expanded in one subtask's popover, does opening another subtask's popover reset it?** Recommend: popovers are independent; collapse/expand state lives per popover instance and resets on close.

**Risk flags:**

- **Bundle bloat via non-lazy imports:** Shiki has submodules for grammars. Easy to accidentally `import { getHighlighter } from 'shiki'` at the top of DiffPopover and pull the whole thing into the main chunk. Guard with a dynamic import and verify via `pnpm build --analyze` or similar.
- **Performance on pathological diffs:** a 50k-line diff will jank even with virtual scrolling if the Shiki tokenization is run up-front. Tokenize lazily per visible chunk, not eagerly on open.
- **Shiki version pin + upstream breakage:** Shiki has had breaking-major releases. Pin to a known-good minor; add a smoke test that loads a highlighter and tokenizes a TS snippet.
- **Render inside popover sizing:** Phase 3.5's popover is sized for file-name rows. 10k-line expanded content needs a scroll container with a max-height matching ~60vh and overflow-y scroll. Don't let the popover auto-expand to document-height.

**Estimated complexity:** large (4-5 days: 1 day backend audit + FileDiff extension if needed, 1.5 days Shiki integration + lazy load, 1 day virtual scrolling + performance benchmarks, 1 day collapse/expand + aria + tests, 0.5 day polish).

---

### Step 7: Verification

Matches the Phase 3 verification step pattern: run a real task end-to-end on each shipped step, record the full interaction, check each acceptance criterion by hand or by integration test.

**Scope:**

- Manual verification pass on a reference repo. Run a 6-subtask plan with at least one simulated worker crash (Step 0 fake-agent fixture invoked intentionally), approve, observe Apply, expand logs, reveal worktrees, inspect diffs. Every acceptance criterion in Steps 1-6 gets a pass/fail mark.
- Integration-test coverage:
  - Apply summary event ordering (Step 2)
  - Crash event ordering + Layer 1/2 routing (Step 5 full-branch)
  - Per-file diff content in `run:subtask_diff` payload (Step 6)
- Visual regression pass (informed by Phase 3 Lesson #4 and Phase 3.5 Lesson #1): record the running → done transition for each worker state, the expand/collapse of a worker log, the popover open/close with and without Shiki loaded. Save artifacts in `docs/retrospectives/phase-4-visuals/` or equivalent.
- Goal-backward verification: does the shipped phase deliver on "build trust through visibility"? Success criteria for the phase restated at the top of VERIFICATION.md with a pass/fail mark per criterion, not just per step.
- KNOWN_ISSUES.md updated with what shipped, what deferred, severity per remaining item.
- CLAUDE.md status updated (last shipped + target for next phase).

**Acceptance criteria:**

- All step-level acceptance criteria from Steps 1-6 pass (11-15 criteria depending on Step 5 branch).
- Frontend tests green (target: +40 over Phase 3.5's 522).
- Rust tests green (target: +10 over Phase 3.5's 295).
- `tsc --noEmit`, `eslint`, `cargo clippy -- -D warnings` clean.
- CI green on every PR.
- VERIFICATION.md written with one paragraph per scope item + scoreboard.

**Open questions:**

- Is there a benchmark we should establish for "large diff" performance (10k lines, < 100ms first paint) and keep as a regression guard? Recommend yes — add to `docs/` as a Phase 4 artifact.
- Should the retrospective template evolve from Phase 3.5's format, or stay consistent? Recommend consistent.

**Risk flags:**

- **Visual regression coverage is still manual.** Phase 3.5 Lesson #1 called for a programmatic visual regression tool; Phase 4 won't introduce one (cost > benefit for this phase). Note in retro that it remains debt.
- **Manual verification time compounds across 6 steps.** Budget 1 full day for the verification pass alone.

**Estimated complexity:** medium (1.5 days: 1 day manual verification + integration test writing, 0.5 day retrospective + KNOWN_ISSUES + CLAUDE.md updates).

---

## Estimated total complexity

| Step | Complexity | Days |
|---|---|---|
| 0 — Crash diagnostic | small | 1.5 |
| 1 — Gemini worker-only | small | 1 |
| 2 — Apply summary overlay | small-medium | 2 |
| 3 — Worker log expand | medium | 3 |
| 4 — Worktree affordances | small-medium | 2 |
| 5 — Crash surface | medium (full) / small (UI-only) | 3 / 1 |
| 6 — Diff content preview | large | 4-5 |
| 7 — Verification | medium | 1.5 |
| **Total (full Step 5)** | | **~18 days** |
| **Total (UI-only Step 5)** | | **~16 days** |

Comfortably fits the 2-week duration estimate if Step 0 finds the UI-only branch for Step 5; requires either light trimming or a small carry into a Phase 4.5 patch batch for the full branch. The 2-week target was set assuming UI-only Step 5 — if Step 0 surfaces the full-branch need, the planner should rebudget.

## Post-phase deliverables

- `docs/phase-4-spec.md` (this file) closed with a "Shipped" note.
- `docs/retrospectives/phase-4.md` matching Phase 3's retrospective format.
- `docs/phase-4-crash-diagnostic.md` (from Step 0) — may be inlined into the retro if short.
- `docs/KNOWN_ISSUES.md` updated.
- `CLAUDE.md` updated.
- Phase 5 spec kickoff brief (one-paragraph scope plus success-criteria sketch) — Phase 5's likely scope: mono-repo awareness, merge conflict resolution UX, base-branch dirty helper, interactive Q&A channel.
