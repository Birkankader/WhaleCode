# Known issues

Debt ledger of deferred work. Items are tagged with a target phase and a severity:

- **cosmetic** — visible quirk, does not block user tasks
- **functional** — a real workflow is missing or awkward, users can work around it
- **architectural** — larger scope; affects the shape of later phases

Each entry is one line of what, a link to where it was last discussed, a target phase, and severity. Keep this file short — if an entry grows, move the detail into a phase spec or architecture doc and link to it from here.

## Open items

### UI / UX

- **framer-motion stuck animations in dev mode** — node cards occasionally freeze mid-transition under HMR; clears on refresh. Production builds unaffected. Context: `docs/retrospectives/phase-2.md` bug #3. **Target:** monitor — file upstream issue if it reproduces post-Phase-3. **Severity:** cosmetic (dev-only).
- **Worker card expand affordance** — clicking a worker card selects it but there is no inline expansion for logs beyond the small stream. Worth a full UX pass in Phase 3 alongside the inline edit work. Context: commit `c0ea00f`. **Target:** Phase 3. **Severity:** functional.
- **Worktree path not inspectable from UI** — when a worker fails, users have no way to open its worktree from WhaleCode. Flagged in `docs/phase-3-spec.md` "Open questions deferred to Phase 4." **Target:** Phase 3 (alongside Layer-3 "Manual fix") or Phase 4. **Severity:** functional.

### Orchestration

- **Partial run recovery is cleanup-only, not resume.** On crash, the backend marks active runs `Failed` and sweeps worktrees (`src-tauri/src/orchestration/mod.rs::recover_active_runs`). There is no "pick up where you left off." Context: `docs/retrospectives/phase-2.md` bug cluster #5. **Target:** v2.5 (headless server also wants resumable runs). **Severity:** architectural.
- **Merge conflict resolution UX.** Phase 2 surfaces conflicts honestly (`run:merge_conflict` event, worktrees preserved, ErrorBanner shown) but offers no resolution path beyond Discard/Retry. Context: `docs/phase-2-spec.md` Step 6 "Conflict handling." **Target:** Phase 4. **Severity:** functional.
- **Base-branch dirty guard is all-or-nothing.** Apply refuses if the user's base branch has tracked uncommitted changes. There is no "stash and retry" helper; the user has to handle git themselves. Context: commits `a024551`, `785947e`. **Target:** Phase 4 (alongside conflict UX). **Severity:** functional.
- **Interactive agent Q&A not supported.** When a worker agent emits a question instead of producing output (e.g., "Which option should I proceed with?"), there is no channel to surface it and relay the user's answer. Current behavior: worker completes as Done with the question in its log output; user sees the text but cannot respond; the subtask exits without the intended work. Observed during Phase 3 Step 9 verification with ambiguous task input. Requires: UI surface for agent questions, backend channel for user responses, and agent-adapter extensions for response injection mid-execution — changes core agent lifecycle, so scope lands in Phase 4 design discussion. Workaround: frame tasks more specifically so the agent doesn't need to ask. Context: commit `98977c4` surrounding discussion. **Target:** Phase 4. **Severity:** functional.

### Architecture / scope

- **Multi-repo workspaces.** v2 is single-repo; mono-repo awareness lands in Phase 4 but true multi-repo remains deferred. Context: `docs/architecture.md` decision 4; `CLAUDE.md` "7 architectural decisions." **Target:** v3. **Severity:** architectural.
- **Cost tracking tables unused.** Schema is in place (`src-tauri/src/storage/`), no readers or writers wired. Context: `docs/phase-2-spec.md` Step 9. **Target:** Phase 6. **Severity:** architectural (no behavioral impact until Phase 6).
- **Safety gate is a stub.** `is_action_safe` returns `true`. Destructive-command gating is Phase 7. Context: `docs/phase-3-spec.md` Step 7. **Target:** Phase 7. **Severity:** architectural.

### Testing

- **Fake agent fixture too generous.** `ScriptedAgent` commits its own edits in `execute`, which masked the "who commits?" gap that surfaced in Step 11. Context: `docs/retrospectives/phase-2.md` bug #1. **Target:** Phase 3 (before writing retry-ladder tests). **Severity:** functional (test-only, but actively misleading).
- **No stress test for rapid submit-after-terminal.** Three bugs in Phase 2 were specific to "user acts before the event round-trip settles." No integration test covers the rapid Apply → new task → Enter path. Context: commits `28077ed`, `23e1f19`. **Target:** Phase 3 verification checklist. **Severity:** functional.
- **Flaky test: `replan_happy_path_accepts_replacement_and_reaches_done`.** Phase 3 Step 4 integration test failed once then passed on re-run during Step 5 Commit 1 work; Commit 1 added only stub commands and an editor module, so the cause is pre-existing. Likely timing-sensitive around the replan lifecycle (event emission vs. assertion). If fail rate increases, investigate the race between `SubtaskStateChanged` dispatch and the waiter in the test. Context: commit `6bee77c` report. **Target:** Phase 3 verification (Step 9). **Severity:** functional (flaky tests mask real regressions).

## Resolved in Phase 2

- ~~Enter does nothing after Apply succeeds~~ → `28077ed`
- ~~rejectAll leaves graph frozen~~ → `23e1f19`
- ~~Crash recovery is invisible~~ → `8f7f895`
- ~~FinalNode stays idle after DiffReady~~ → `4eaa8ec`
- ~~"0 files changed" after Apply~~ → `8f4fe97`
- ~~React Flow pointer events blocked~~ → `c0ea00f`, `5d337a2`
- ~~Base branch dirty not guarded~~ → `a024551`, `785947e`
