---
phase: 04
slug: context-store
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-05
---

# Phase 04 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust: cargo test, Frontend: vitest |
| **Config file** | `src-tauri/Cargo.toml`, `vitest.config.ts` |
| **Quick run command** | `cd src-tauri && cargo check` |
| **Full suite command** | `cd src-tauri && cargo test && cd .. && npm run test -- --run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd src-tauri && cargo check`
- **After every plan wave:** Run `cd src-tauri && cargo test && cd .. && npm run test -- --run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | CTXT-01 | unit | `cd src-tauri && cargo test context` | ❌ W0 | ⬜ pending |
| 04-01-02 | 01 | 1 | CTXT-02 | unit | `cd src-tauri && cargo test context` | ❌ W0 | ⬜ pending |
| 04-02-01 | 02 | 2 | CTXT-03 | unit | `cd src-tauri && cargo test context` | ❌ W0 | ⬜ pending |
| 04-02-02 | 02 | 2 | CTXT-04 | integration | `cd src-tauri && cargo test context` | ❌ W0 | ⬜ pending |
| 04-03-01 | 03 | 3 | CTXT-05 | integration | `npm run test -- --run` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/context/tests.rs` — unit tests for context store CRUD
- [ ] SQLite test fixtures with in-memory database for isolation

*Existing Rust and vitest infrastructure covers framework needs.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Context persists across app restarts | CTXT-02 | Requires app lifecycle testing | Set context, quit app, relaunch, verify context readable |
| Context auto-injected before tool start | CTXT-04 | Requires running real Claude Code task | Start a task after previous task recorded context, verify preamble prepended |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
