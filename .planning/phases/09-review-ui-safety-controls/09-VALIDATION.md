---
phase: 9
slug: review-ui-safety-controls
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-06
---

# Phase 9 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework (Rust)** | cargo test (built-in) |
| **Framework (Frontend)** | vitest 2.x with jsdom |
| **Config file (Rust)** | Cargo.toml [dev-dependencies] |
| **Config file (Frontend)** | vite.config.ts test section |
| **Quick run command** | `cd src-tauri && cargo test worktree --lib && cd .. && npx vitest run` |
| **Full suite command** | `cd src-tauri && cargo test && cd .. && npx vitest run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd src-tauri && cargo test worktree --lib && cd .. && npx vitest run`
- **After every plan wave:** Run `cd src-tauri && cargo test && cd .. && npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 09-01-01 | 01 | 1 | SAFE-01 | unit (Rust) | `cd src-tauri && cargo test diff::tests` | No — W0 | ⬜ pending |
| 09-01-02 | 01 | 1 | SAFE-02 | unit (Rust) | `cd src-tauri && cargo test diff::tests::selective` | No — W0 | ⬜ pending |
| 09-02-01 | 02 | 2 | SAFE-01 | unit (Frontend) | `npx vitest run src/tests/review.test.tsx` | No — W0 | ⬜ pending |
| 09-02-02 | 02 | 2 | SAFE-02 | unit (Frontend) | `npx vitest run src/tests/review.test.tsx` | No — W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/worktree/diff.rs` — diff generation logic + tests (SAFE-01, SAFE-02)
- [ ] `src/tests/review.test.tsx` — DiffReview component tests (SAFE-01, SAFE-02)
- [ ] Reuse test helpers from `conflict.rs` tests for creating repos with diverged branches

*Existing infrastructure partially covers — need new test files for diff-specific behavior.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Diff viewer renders correctly with syntax coloring | SAFE-01 | Visual rendering quality | Open app, run a tool task, click Review, verify diff is readable with +/- coloring |
| Accept/reject workflow feels intuitive | SAFE-02 | UX subjective | Complete a full accept/reject cycle, verify file selection is clear |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
