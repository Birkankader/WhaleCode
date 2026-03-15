# WhaleCode — 5 Agent Review Notes

## 🔧 CODE REVIEW (7.6/10)

### Critical
- [x] `dangerouslySetInnerHTML` in CodeView.tsx:334 — XSS = RCE in Tauri
- [x] `std::sync::Mutex` poisoning in state.rs:100 — switch to parking_lot::Mutex
- [ ] Dual source of truth: processStore + taskStore still both track status

### Major
- [~] DEFERRED: Split orchestrator.rs — large refactor for v1.1 lines — split into 4-5 modules
- [x] 6 empty `catch {}` blocks swallow errors (useProcess.ts, useTaskDispatch.ts)
- [x] 5 frontend test files (humanizeError added) files — zero store/hook/event tests
- [x] `as any` cast in useOrchestratedDispatch.ts:163
- [x] messengerStore.ts:62-67 — blind `as string`/`as number` casts
- [x] handleOrchEvent.ts OrchEvent typed as `{ type: string; [key: string]: unknown }`
- [x] taskStore updateTask() helper (reduced boilerplate) `new Map()` — O(n) clone per update

### Minor
- [x] 15 eprintln! → log::debug! statements in orchestrator.rs — use tracing::debug!
- [x] useProcess.ts: JSDoc on _updateStatus`/`_removeProcess` underscore convention unclear
- [x] Removed lastOutputPreview (overlap consolidated), lastEventAt overlap
- [x] Inline orchestration log type — extract OrchestrationLogEntry interface
- [x] emit_orch logs send failures .unwrap_or_default() + .ok() — silent failure
- [x] notificationStore: unreadCount recomputed via filter on every markRead
- [x] process/manager.rs: drain threshold optimized.drain() inside mutex lock on hot path

---

## 🎨 UI REVIEW (5.4/10)

### Critical
- [x] 3 parallel color systems: C object, --color-wc-* CSS vars, shadcn oklch
- [~] DEFERRED: Inline→Tailwind migration — gradual, ongoing / ~50% Tailwind — inconsistent
- [x] textMuted (#4b4d66) fails WCAG AA at 2.5:1 contrast

### Major
- [x] AgentBadge duplicated in 7 files (~200 lines)
- [x] StatusPill duplicated in 4 files
- [x] 4 border-radius tokens defined values
- [x] Icons unified to Lucide (Sidebar + ContentHeader): Lucide / HTML entities / Emoji
- [~] DEFERRED: Modal component — gradual extraction component (4 files each build their own)
- [x] 6 font size tokens defined (8px-26px) — no type scale
- [x] Sidebar onMouseEnter/onMouseLeave style manipulation anti-pattern

### Minor
- [~] DEFERRED: shadcn adoption — gradual barely used
- [~] DEFERRED: KanbanBoard not active (replaced by WorkingView) color semantics (slate-100, white/8)
- [x] TerminalBottomPanel has no open/close transition
- [x] Sidebar tooltip appears instantly (needs 100ms delay)
- [x] .dark CSS block is identical to :root (dead code)
- [x] Scrollbar thumb too faint (0.28 opacity)
- [x] UsageView responsive auto-fit grid has no responsive breakpoint
- [x] CommandPalette w-[520px] fixed — could overflow

---

## 🧠 UX REVIEW (7.9/10)

### Critical
- [~] NOTED: Nav paradigms — simplified (removed StatusBar, reduced tabs) (6/10) — 5 overlapping nav paradigms
- [x] ⌘-number shortcut mismatch — CommandPalette vs AppShell
- [x] clearSession() now asks confirmation data without confirmation

### Major
- [x] OnboardingWizard has Check Again button (no "Check Again" button)
- [x] Session name auto-generated (low-value ceremony)
- [x] Dev Mode toggle moved to Settings only in header (expert-only feature)
- [x] Merged: decomposing state inline in pipeline should merge into one
- [ ] Settings in sidebar but also ⌘P — inconsistent (page vs panel?)
- [ ] review/done views not in tab bar — undiscoverable
- [x] Merged StagePipeline+DecomposingBanner (was 4, now 2-3) indicators during orchestration

### Minor
- [x] Disabled buttons have tooltip explanations button has no tooltip
- [x] Quick Task now shows project picker — no indication
- [x] ErrorBoundary has Reload button button
- [x] Errors also written to terminal panel (transient)
- [x] Heartbeat reduced to 5s before stale task detected
- [ ] No focus trap in SetupPanel, OnboardingWizard, TaskApprovalView
- [x] Tabs hidden when idle (only Working visible) (empty, meaningless)
- [ ] Sidebar icons unlabeled (tooltip-only)
- [x] NotificationCenter Clear all has undo toast confirmation
- [x] Auto-approve logs to orchestration log/log entry

---

## 📦 PRODUCT REVIEW (5.5/10)

### Critical
- [~] DEFERRED: Target audience — needs single-agent mode expansion (need 3 CLI tools + API keys)
- [x] No single-agent mode — simple tasks forced through orchestration
- [~] DEFERRED: Onboarding funnel — needs .dmg distribution funnel — no pre-built binaries
- [x] macOS only — Keychain (macOSPrivateApi removed) dependency

### Major
- [~] DEFERRED: CLI format risk — needs adapter versioning — undocumented, can change
- [~] DEFERRED: PR creation — needs GitHub API integration from worktrees
- [~] DEFERRED: Agent comparison — v2 feature (same task, different agents)
- [~] DEFERRED: Budget caps — v2 feature ("stop if spend > $5")
- [~] DEFERRED: Plugin system — v2 feature for new agents (hard-coded to 3)
- [~] DEFERRED: Cross-platform — needs keyring abstraction support
- [x] MIT license — LICENSE added file

### Minor
- [~] DEFERRED: Scheduled tasks — v2 feature tasks
- [~] DEFERRED: Issue tracker — v2 feature integration
- [~] DEFERRED: Daily digest — v2 feature/digest
- [~] DEFERRED: Partial merge — v2 feature merge
- [~] DEFERRED: Export/share — v2 feature of session results
- [~] DEFERRED: Telemetry — post-launch/analytics
- [~] DEFERRED: Cost positioning — marketing task as selling point

---

## 🏪 ASO REVIEW (4.0/10)

### Critical
- [x] macOSPrivateApi: true — automatic App Store rejection
- [x] No LICENSE file (README says MIT)
- [x] No Privacy Policy (Keychain + API keys = required)
- [~] DEFERRED: Icon — needs designer
- [x] Bundle identifier uses dev TLD
- [x] version 0.1.0 (App Store requires ≥1.0.0)

### Major
- [~] DEFERRED: Brand unification — needs designer: icon ≠ sidebar logo ≠ name concept
- [x] Cargo.toml description "A Tauri App" + authors "you"
- [x] No app category in tauri.conf.json
- [x] No minimum macOS version set
- [~] DEFERRED: Screenshots — post-polish or preview video
- [~] DEFERRED: Entitlements — pre-App Store submission file
- [~] DEFERRED: ASO keywords — marketing task anywhere
- [x] CSP disabled (csp: null)

### Minor
- [x] CHANGELOG.md created
- [~] DEFERRED: Promo text — marketing task
- [x] Font consolidated to CSS body + --font-mono ways
- [x] Monospace font stack unified via --font-mono inconsistent
