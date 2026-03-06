---
phase: 7
slug: task-router-parallel-execution
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-06
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 3.x (frontend), cargo test (backend) |
| **Config file** | vite.config.ts (test section), Cargo.toml |
| **Quick run command** | `cd src-tauri && cargo test router && cd .. && npx vitest run` |
| **Full suite command** | `cd src-tauri && cargo test && cd .. && npx vitest run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd src-tauri && cargo test router && cd .. && npx vitest run`
- **After every plan wave:** Run `cd src-tauri && cargo test && cd .. && npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 07-01-01 | 01 | 1 | ROUT-01 | unit | `cd src-tauri && cargo test router -x` | Wave 0 | pending |
| 07-01-02 | 01 | 1 | ROUT-03 | unit | `cd src-tauri && cargo test router::tests::strength -x` | Wave 0 | pending |
| 07-01-03 | 01 | 1 | ROUT-04 | unit | `cd src-tauri && cargo test router::tests::availability -x` | Wave 0 | pending |
| 07-02-01 | 02 | 2 | PROC-03 | integration | `cd src-tauri && cargo test parallel -x` | Wave 0 | pending |
| 07-02-02 | 02 | 2 | ROUT-02 | unit | `npx vitest run src/tests/taskDispatch.test.ts` | Wave 0 | pending |
| 07-03-01 | 03 | 3 | SAFE-05 | unit | `npx vitest run src/tests/StatusPanel.test.tsx` | Wave 0 | pending |
| 07-03-02 | 03 | 3 | SAFE-06 | unit | `npx vitest run src/tests/StatusPanel.test.tsx` | Wave 0 | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/router/mod.rs` — routing logic with unit tests
- [ ] `src/tests/taskDispatch.test.ts` — frontend dispatch hook tests
- [ ] `src/tests/StatusPanel.test.tsx` — status panel rendering tests

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live status panel updates in real-time | SAFE-05 | Visual real-time rendering | Open app, run 2 tasks, observe panel updates |
| Two tasks don't interfere with worktrees | PROC-03 | Requires actual CLI processes | Run Claude + Gemini simultaneously, verify separate worktrees |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
