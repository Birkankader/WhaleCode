# Known issues

Debt ledger of deferred work. Items are tagged with a target phase and a severity:

- **cosmetic** — visible quirk, does not block user tasks
- **functional** — a real workflow is missing or awkward, users can work around it
- **architectural** — larger scope; affects the shape of later phases

Each entry is one line of what, a link to where it was last discussed, a target phase, and severity. Keep this file short — if an entry grows, move the detail into a phase spec or architecture doc and link to it from here.

## Open items

### UI / UX

- **framer-motion stuck animations in dev mode** — node cards occasionally freeze mid-transition under HMR; clears on refresh. Production builds unaffected. Context: `docs/retrospectives/phase-2.md` bug #3. **Target:** monitor — file upstream issue if it reproduces post-Phase-4. **Severity:** cosmetic (dev-only).
- **Worker card expand affordance (partial).** Phase 3 added per-state height overrides and a cancel button, but there is still no inline expansion to view a worker's full log beyond the tail. Context: commits `c0ea00f`, `1e93761`, `e2c6b5c`. **Target:** Phase 4. **Severity:** functional.
- **Worktree path not inspectable from UI.** Layer-3 "Manual fix" opens the editor inside the worktree, but the path itself is not surfaced anywhere else — e.g., a failed worker has no "reveal in Finder" affordance. Context: `docs/retrospectives/phase-3.md` open debt. **Target:** Phase 4. **Severity:** functional.

### Orchestration

- **Partial run recovery is cleanup-only, not resume.** On crash, the backend marks active runs `Failed` and sweeps worktrees (`src-tauri/src/orchestration/mod.rs::recover_active_runs`). There is no "pick up where you left off." Context: `docs/retrospectives/phase-2.md` bug cluster #5. **Target:** v2.5 (headless server also wants resumable runs). **Severity:** architectural.
- **Merge conflict resolution UX.** Phase 2 surfaces conflicts honestly (`run:merge_conflict` event, worktrees preserved, ErrorBanner shown) but offers no resolution path beyond Discard/Retry. Context: `docs/phase-2-spec.md` Step 6 "Conflict handling." **Target:** Phase 4. **Severity:** functional.
- **Base-branch dirty guard is all-or-nothing.** Apply refuses if the user's base branch has tracked uncommitted changes. There is no "stash and retry" helper; the user has to handle git themselves. Context: commits `a024551`, `785947e`. **Target:** Phase 4 (alongside conflict UX). **Severity:** functional.
- **Interactive agent Q&A not supported.** When a worker agent emits a question instead of producing output (e.g., "Which option should I proceed with?"), there is no channel to surface it and relay the user's answer. Current behavior: worker completes as Done with the question in its log output; user sees the text but cannot respond; the subtask exits without the intended work. Observed during Phase 3 Step 9 verification with ambiguous task input. Requires: UI surface for agent questions, backend channel for user responses, and agent-adapter extensions for response injection mid-execution — changes core agent lifecycle, so scope lands in Phase 4 design discussion. Workaround: frame tasks more specifically so the agent doesn't need to ask. Context: commit `98977c4` surrounding discussion. **Target:** Phase 4. **Severity:** functional.
- **Gemini CLI is too slow to use as master.** Phase 3.5 measurement (gemini-cli `0.38.1` against the public API on 2026-04-21): minimal-prompt planning (`--output-format json --approval-mode plan`, ~30-byte stdin) returned in **226-239 s** (mean ~230 s, n=3) with **TTFB == total** — gemini emits no output until completion, so streaming the stdout doesn't help perceived latency. Larger prompts and worker mode (`--yolo`) show similar steady-state, with a non-zero failure rate (1/4 runs exited with code 1 and zero bytes after ~243 s). Same machine + network, claude `2.1.113` returned the same minimal prompt in **3.83 s TTFB / 4.35 s total** — gemini is **~60×** slower in the steady state. The only fast gemini run we observed was the very first cold invocation (~16 s); subsequent runs degraded as if rate-limited, then plateaued at ~230 s. No 1-line fix in the WhaleCode adapter changes this — the latency lives in gemini-cli's transport / backend. Possible mitigations (none small): (a) try `--output-format stream-json` and parse incremental events for true TTFB, (b) PTY wrapper to see if interactive mode streams differently, (c) downgrade gemini to "experimental" in the master picker until upstream improves. Workaround for users today: pick claude or codex as master; gemini is fine as a worker on small subtasks but not as the planner. Context: `src-tauri/src/agents/gemini.rs::plan` and benchmark notes in this commit's body. **Target:** Phase 4 (decide which mitigation, or downgrade gemini). **Severity:** functional (gemini-as-master is effectively unusable at current latency).

### Architecture / scope

- **Multi-repo workspaces.** v2 is single-repo; mono-repo awareness lands in Phase 4 but true multi-repo remains deferred. Context: `docs/architecture.md` decision 4; `CLAUDE.md` "7 architectural decisions." **Target:** v3. **Severity:** architectural.
- **Cost tracking tables unused.** Schema is in place (`src-tauri/src/storage/`), no readers or writers wired. Context: `docs/phase-2-spec.md` Step 9. **Target:** Phase 6. **Severity:** architectural (no behavioral impact until Phase 6).
- **Safety gate is a stub.** `is_action_safe` returns `true`. Destructive-command gating is Phase 7. Context: `docs/phase-3-spec.md` Step 7. **Target:** Phase 7. **Severity:** architectural.
- **Windows cancel cleanup.** Phase 3.5's cancellation fix uses `setsid` + `killpg` on Unix to kill grandchildren spawned by agent CLIs (MCP servers, tool runners). On Windows the equivalent is a Job Object assigned at spawn time (`kernel32::CreateJobObject` + `AssignProcessToJobObject`), which requires the `windows-rs` crate plus the correct flags for kill-on-close. Not wired yet — Windows cancel will still work for the direct child via `child.kill()` but grandchildren will orphan. Context: `src-tauri/src/agents/process.rs` (`install_new_process_group` / `kill_process_group`). **Target:** v2.5 (before headless mode — a server can't orphan processes). **Severity:** architectural (platform-specific, Unix shipping unaffected).

### Testing

- **No stress test for rapid submit-after-terminal.** Three bugs in Phase 2 were specific to "user acts before the event round-trip settles." No integration test covers the rapid Apply → new task → Enter path. Context: commits `28077ed`, `23e1f19`. **Target:** Phase 4 verification checklist. **Severity:** functional.
- **Flaky tests in the replan lifecycle family.** `replan_happy_path_accepts_replacement_and_reaches_done` failed once during Phase 3 Step 4, passed on re-run; did not recur in Step 9. During Phase 3.5 Item 5 gate runs, `replan_lineage_cap_escalates_after_chained_replans` (sibling test in the same module) also failed once under the full-suite run and passed in isolation — same flake shape. Both are timing-sensitive around the replan lifecycle (event emission vs. assertion). If the fail rate climbs, investigate the race between `SubtaskStateChanged` dispatch and the waiter in these tests. Context: commit `6bee77c` report; `docs/retrospectives/phase-3.md` bug #6. **Target:** monitor — fix only on recurrence. **Severity:** functional (flaky tests mask real regressions).
- **No debug-only failure injection.** Phase 3 criteria 7, 15 (and arguably 14) could not be exercised end-to-end by hand because the app has no "force this subtask to fail" or "force ceiling exceeded" affordance — they were instead integration-verified via backend tests. A small debug surface (`force_fail_next`, `force_ceiling_exceeded`) behind a dev-only flag would let later phases ship full manual verification. Context: `docs/retrospectives/phase-3.md` lessons #6. **Target:** Phase 4 (estimate: 1 day, pays back within the phase). **Severity:** functional (test-only, but increasingly costly as the lifecycle grows).
- **No visual regression pass for worker state transitions.** Three of Phase 3's six closeout bugs (title squeeze, running/done height, empty LogBlock black hole) were only caught by a human watching the card transition. Unit tests covered the logic but not the pixels. Context: `docs/retrospectives/phase-3.md` lessons #4. **Target:** Phase 4 (playbook-level: a Step-9 pass that runs a real task and records the running→done transition for every worker state). **Severity:** functional (process, not code).

## Resolved in Phase 3.5

- ~~Cancel leaves grandchildren orphaned (MCP servers keep stdout open)~~ → `998be29` (Unix process-group kill + bounded pipe drain + dispatcher drain deadline). Windows equivalent tracked as an open item above.
- ~~Master is silent during planning — UI looks frozen on slow providers~~ → `acedc10` (10s `MasterLog` heartbeat with elapsed seconds; fast Claude plans skip the first tick and emit nothing)
- ~~Zoom range too tight; no Controls; no keyboard affordance~~ → `d600789` (minZoom 0.4, maxZoom 2.5, `+`/`-`/`0` keys, built-in Controls component)
- ~~Scroll-to-zoom broke drag-pan on dense plans~~ → `46fa740` (reverted to RF defaults: scroll pans, Cmd/Ctrl+scroll zooms, pinch zooms; kept commit 4's zoom bounds + keyboard + Controls)
- ~~Unticked proposed workers look identical to ticked ones~~ → `6bd3657` (50% opacity + neutral-gray border on node + in-edges)
- ~~No per-subtask diff visibility before aggregate DiffReady~~ → `acedc10` (per-subtask `run:subtask_diff` event fired before DiffReady; "N files" chip + popover on done workers)
- ~~TopBar doesn't show current branch~~ → `e3d367d` (branch rendered after middle-dot separator; re-polled on window focus; detached-HEAD falls back to short SHA)
- ~~CI Frontend job fails before build — npm config against a pnpm repo~~ → `5723c15` (pnpm/action-setup v4 + `pnpm install --frozen-lockfile`)

## Resolved in Phase 3

- ~~Fake agent fixture too generous~~ → Phase 3 test fixtures kept deliberately weaker than real agents; no retry/replan bugs were masked (see `docs/retrospectives/phase-3.md` "What went well")
- ~~Worker card title/why collapse under proposed state~~ → `98977c4`, `77867e6`
- ~~Worker card height insufficient in running/done~~ → `1e93761`
- ~~Empty LogBlock renders as a black hole~~ → `e2c6b5c`
- ~~Cancel leaves store non-terminal~~ → `7a513e4`, `01f701f`, `0ddd8cd`, `f7fc2eb`

## Resolved in Phase 2

- ~~Enter does nothing after Apply succeeds~~ → `28077ed`
- ~~rejectAll leaves graph frozen~~ → `23e1f19`
- ~~Crash recovery is invisible~~ → `8f7f895`
- ~~FinalNode stays idle after DiffReady~~ → `4eaa8ec`
- ~~"0 files changed" after Apply~~ → `8f4fe97`
- ~~React Flow pointer events blocked~~ → `c0ea00f`, `5d337a2`
- ~~Base branch dirty not guarded~~ → `a024551`, `785947e`
