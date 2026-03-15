# WhaleCode — 5 Agent Review Notes

## 🔧 CODE REVIEW (7.6/10)

### Critical
- [x] `dangerouslySetInnerHTML` in CodeView.tsx:334 — XSS = RCE in Tauri
- [x] `std::sync::Mutex` poisoning in state.rs:100 — switch to parking_lot::Mutex
- [ ] Dual source of truth: processStore + taskStore still both track status

### Major
- [ ] commands/orchestrator.rs is 2126 lines — split into 4-5 modules
- [x] 6 empty `catch {}` blocks swallow errors (useProcess.ts, useTaskDispatch.ts)
- [x] 5 frontend test files (humanizeError added) files — zero store/hook/event tests
- [x] `as any` cast in useOrchestratedDispatch.ts:163
- [x] messengerStore.ts:62-67 — blind `as string`/`as number` casts
- [x] handleOrchEvent.ts OrchEvent typed as `{ type: string; [key: string]: unknown }`
- [x] taskStore updateTask() helper (reduced boilerplate) `new Map()` — O(n) clone per update

### Minor
- [x] 15 eprintln! → log::debug! statements in orchestrator.rs — use tracing::debug!
- [x] useProcess.ts: JSDoc on _updateStatus`/`_removeProcess` underscore convention unclear
- [ ] taskStore: lastOutputLine, lastOutputPreview, lastEventAt overlap
- [x] Inline orchestration log type — extract OrchestrationLogEntry interface
- [x] emit_orch logs send failures .unwrap_or_default() + .ok() — silent failure
- [x] notificationStore: unreadCount recomputed via filter on every markRead
- [x] process/manager.rs: drain threshold optimized.drain() inside mutex lock on hot path

---

## 🎨 UI REVIEW (5.4/10)

### Critical
- [x] 3 parallel color systems: C object, --color-wc-* CSS vars, shadcn oklch
- [ ] CSS strategy ~50% inline / ~50% Tailwind — inconsistent
- [x] textMuted (#4b4d66) fails WCAG AA at 2.5:1 contrast

### Major
- [x] AgentBadge duplicated in 7 files (~200 lines)
- [x] StatusPill duplicated in 4 files
- [ ] 12 different border-radius values
- [x] Icons unified to Lucide (Sidebar + ContentHeader): Lucide / HTML entities / Emoji
- [ ] No Modal/Overlay shared component (4 files each build their own)
- [ ] 12 arbitrary font sizes (8px-26px) — no type scale
- [x] Sidebar onMouseEnter/onMouseLeave style manipulation anti-pattern

### Minor
- [ ] shadcn Button component barely used
- [ ] KanbanBoard uses different color semantics (slate-100, white/8)
- [x] TerminalBottomPanel has no open/close transition
- [x] Sidebar tooltip appears instantly (needs 100ms delay)
- [x] .dark CSS block is identical to :root (dead code)
- [x] Scrollbar thumb too faint (0.28 opacity)
- [x] UsageView responsive auto-fit grid has no responsive breakpoint
- [x] CommandPalette w-[520px] fixed — could overflow

---

## 🧠 UX REVIEW (7.9/10)

### Critical
- [ ] Navigation mental model (6/10) — 5 overlapping nav paradigms
- [x] ⌘-number shortcut mismatch — CommandPalette vs AppShell
- [x] clearSession() now asks confirmation data without confirmation

### Major
- [x] OnboardingWizard has Check Again button (no "Check Again" button)
- [x] Session name auto-generated (low-value ceremony)
- [x] Dev Mode toggle moved to Settings only in header (expert-only feature)
- [ ] StagePipeline + DecomposingBanner should merge into one
- [ ] Settings in sidebar but also ⌘P — inconsistent (page vs panel?)
- [ ] review/done views not in tab bar — undiscoverable
- [ ] 4 simultaneous status indicators during orchestration

### Minor
- [ ] SetupPanel canContinue disabled button has no tooltip
- [x] Quick Task now shows project picker — no indication
- [x] ErrorBoundary has Reload button button
- [ ] Orchestration error only shown as toast (transient)
- [x] Heartbeat reduced to 5s before stale task detected
- [ ] No focus trap in SetupPanel, OnboardingWizard, TaskApprovalView
- [ ] Tabs shown before any orchestration (empty, meaningless)
- [ ] Sidebar icons unlabeled (tooltip-only)
- [x] NotificationCenter Clear all has undo toast confirmation
- [x] Auto-approve logs to orchestration log/log entry

---

## 📦 PRODUCT REVIEW (5.5/10)

### Critical
- [ ] Target audience too narrow (need 3 CLI tools + API keys)
- [x] No single-agent mode — simple tasks forced through orchestration
- [ ] 10-step onboarding-to-value funnel — no pre-built binaries
- [x] macOS only — Keychain (macOSPrivateApi removed) dependency

### Major
- [ ] CLI output format dependency — undocumented, can change
- [ ] No auto-create PRs from worktrees
- [ ] No agent output comparison (same task, different agents)
- [ ] No budget caps ("stop if spend > $5")
- [ ] No plugin system for new agents (hard-coded to 3)
- [ ] No Windows/Linux support
- [x] MIT license — LICENSE added file

### Minor
- [ ] No scheduled/recurring tasks
- [ ] No issue tracker integration
- [ ] No daily summary/digest
- [ ] No partial worktree merge
- [ ] No export/share of session results
- [ ] No telemetry/analytics
- [ ] Cost tracking not positioned as selling point

---

## 🏪 ASO REVIEW (4.0/10)

### Critical
- [x] macOSPrivateApi: true — automatic App Store rejection
- [x] No LICENSE file (README says MIT)
- [x] No Privacy Policy (Keychain + API keys = required)
- [ ] No 1024x1024 icon
- [x] Bundle identifier uses dev TLD
- [x] version 0.1.0 (App Store requires ≥1.0.0)

### Major
- [ ] Brand identity crisis: icon ≠ sidebar logo ≠ name concept
- [x] Cargo.toml description "A Tauri App" + authors "you"
- [x] No app category in tauri.conf.json
- [x] No minimum macOS version set
- [ ] No screenshots or preview video
- [ ] No entitlements file
- [ ] Zero ASO keywords anywhere
- [x] CSP disabled (csp: null)

### Minor
- [x] CHANGELOG.md created
- [ ] No promotional text
- [x] Font consolidated to CSS body + --font-mono ways
- [x] Monospace font stack unified via --font-mono inconsistent
