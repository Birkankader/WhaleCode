---
phase: 1
slug: foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-05
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (frontend) + cargo test (Rust backend) |
| **Config file** | vitest.config.ts (Wave 0 creates) + src-tauri/Cargo.toml |
| **Quick run command** | `cd src-tauri && cargo check && cd .. && npx vitest run --reporter=verbose` |
| **Full suite command** | `cd src-tauri && cargo test && cd .. && npx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd src-tauri && cargo check`
- **After every plan wave:** Run full suite command
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | FOUN-01 | build | `cd src-tauri && cargo build 2>&1 \| tail -1` | ❌ W0 | ⬜ pending |
| 01-01-02 | 01 | 1 | FOUN-02 | unit | `cd src-tauri && cargo test test_appstate` | ❌ W0 | ⬜ pending |
| 01-02-01 | 02 | 1 | FOUN-03 | build | `npx vite build 2>&1 \| tail -1` | ❌ W0 | ⬜ pending |
| 01-02-02 | 02 | 1 | FOUN-03 | e2e | `npx vitest run --reporter=verbose` | ❌ W0 | ⬜ pending |
| 01-03-01 | 03 | 2 | FOUN-02 | integration | `cd src-tauri && cargo test test_channel_streaming` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/tests/` — Rust test module for AppState and Channel tests
- [ ] `src/__tests__/` — Vitest test directory for React component tests
- [ ] `vitest` + `@testing-library/react` — install as dev dependencies
- [ ] `cargo test` — verify Rust test harness works with Tauri setup

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| App launches as native macOS window | FOUN-01 | Requires GUI rendering, cannot headless test | Run `cargo tauri dev`, verify window appears with title "WhaleCode" |
| Streaming output renders in xterm.js | FOUN-02 | Requires visual confirmation of terminal rendering | Trigger test event from Rust, verify it appears in frontend terminal |
| Window respects minimum size 800x600 | FOUN-01 | Window constraints need visual verification | Try resizing window below 800x600, verify it stops |

*If none: "All phase behaviors have automated verification."*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
