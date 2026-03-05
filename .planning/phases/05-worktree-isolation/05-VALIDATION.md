---
phase: 05
slug: worktree-isolation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-05
---

# Phase 05 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust: cargo test, Frontend: vitest |
| **Config file** | `src-tauri/Cargo.toml`, `vitest.config.ts` |
| **Quick run command** | `cd src-tauri && cargo check` |
| **Full suite command** | `cd src-tauri && cargo test && cd .. && npm run test -- --run` |
| **Estimated runtime** | ~20 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd src-tauri && cargo check`
- **After every plan wave:** Run `cd src-tauri && cargo test && cd .. && npm run test -- --run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 20 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 05-01-01 | 01 | 1 | PROC-04 | unit | `cd src-tauri && cargo test worktree` | ❌ W0 | ⬜ pending |
| 05-01-02 | 01 | 1 | PROC-04 | unit | `cd src-tauri && cargo test worktree` | ❌ W0 | ⬜ pending |
| 05-02-01 | 02 | 2 | SAFE-03 | unit | `cd src-tauri && cargo test worktree::conflicts` | ❌ W0 | ⬜ pending |
| 05-02-02 | 02 | 2 | SAFE-04 | integration | `cd src-tauri && cargo test worktree` | ❌ W0 | ⬜ pending |
| 05-03-01 | 03 | 3 | SAFE-03 | integration | `npm run test -- --run` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/worktree/tests.rs` — unit tests for worktree CRUD and conflict detection
- [ ] Test fixtures using git2 in-memory or temp dir repositories

*Existing Rust and vitest infrastructure covers framework needs.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Worktree created when task dispatched | PROC-04 | Requires running real task | Dispatch a Claude task, verify worktree appears in filesystem |
| Conflict warning shown in UI | SAFE-03 | Requires visual UI check | Dispatch two tasks on same file, verify warning renders |
| Crash recovery cleans stale worktrees | SAFE-04 | Requires simulating crash | Kill app mid-task, relaunch, verify cleanup runs |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 20s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
