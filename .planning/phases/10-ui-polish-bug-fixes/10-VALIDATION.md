---
phase: 10
slug: ui-polish-bug-fixes
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-07
---

# Phase 10 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.0.18 (frontend), cargo test (Rust backend) |
| **Config file** | vite.config.ts (test section), Cargo.toml |
| **Quick run command** | `cd src-tauri && cargo test --lib 2>&1 | tail -5` |
| **Full suite command** | `cd src-tauri && cargo test 2>&1` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd src-tauri && cargo test --lib 2>&1 | tail -5`
- **After every plan wave:** Run `cd src-tauri && cargo test 2>&1`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 10-01-01 | 01 | 1 | POLISH-05 | unit | `npx vitest run src/tests/AppShell.test.tsx` | Exists | ⬜ pending |
| 10-01-02 | 01 | 1 | POLISH-02 | manual-only | Visual: empty diff shows no action bar | N/A | ⬜ pending |
| 10-02-01 | 02 | 1 | POLISH-01 | manual-only | Visual: resize handle visible and functional | N/A | ⬜ pending |
| 10-03-01 | 03 | 1 | POLISH-03 | unit | `cd src-tauri && cargo test cached_prompt` | Wave 0 | ⬜ pending |
| 10-04-01 | 04 | 1 | POLISH-04 | unit | `cd src-tauri && cargo test -- codex` | Exists (27 tests) | ⬜ pending |
| 10-05-01 | 05 | 2 | POLISH-06 | manual-only | Visual: consistent button/card styling | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/state.rs` — add CachedPromptContext struct and tests for cache validity
- [ ] Manual test checklist for visual requirements (POLISH-01, 02, 06)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Worktree panel is resizable | POLISH-01 | Visual/interaction behavior | Drag resize handle, verify panel shrinks/grows. Collapse panel, verify it hides. |
| Review buttons hidden when no changes | POLISH-02 | Visual conditional rendering | Open DiffReview with no changes, verify no merge/discard buttons. Open with changes, verify buttons appear. |
| UI uses shadcn components | POLISH-06 | Visual consistency | Compare before/after screenshots of Sidebar, ProcessPanel, WorktreeStatus. Verify consistent styling. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
