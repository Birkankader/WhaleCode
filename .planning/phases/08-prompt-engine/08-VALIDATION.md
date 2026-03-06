---
phase: 8
slug: prompt-engine
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-06
---

# Phase 8 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | cargo test (Rust) + vitest 4.0.18 + jsdom (Frontend) |
| **Config file** | vite.config.ts (test section) / Cargo.toml |
| **Quick run command** | `cd src-tauri && cargo test prompt` |
| **Full suite command** | `cd src-tauri && cargo test && cd .. && npx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd src-tauri && cargo test prompt`
- **After every plan wave:** Run `cd src-tauri && cargo test && cd .. && npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 08-01-01 | 01 | 1 | PMPT-01 | unit | `cd src-tauri && cargo test prompt::tests::optimize_accepts_raw_prompt -x` | ❌ W0 | ⬜ pending |
| 08-01-02 | 01 | 1 | PMPT-02 | unit | `cd src-tauri && cargo test prompt::tests::claude_and_gemini_differ -x` | ❌ W0 | ⬜ pending |
| 08-01-03 | 01 | 1 | PMPT-04 | unit | `cd src-tauri && cargo test prompt::tests::context_included -x` | ❌ W0 | ⬜ pending |
| 08-02-01 | 02 | 1 | PMPT-03 | unit | `npx vitest run src/tests/prompt.test.ts` | ❌ W0 | ⬜ pending |
| 08-02-02 | 02 | 1 | PMPT-02 | integration | `cd src-tauri && cargo test prompt` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/prompt/mod.rs` — PromptEngine with unit tests
- [ ] `src-tauri/src/prompt/templates.rs` — template functions with tests
- [ ] `src-tauri/src/prompt/models.rs` — OptimizedPrompt type (specta-exported)
- [ ] `src-tauri/src/commands/prompt.rs` — optimize_prompt IPC command
- [ ] `src/tests/prompt.test.ts` — frontend preview component tests

*Wave 0 creates test stubs alongside implementation.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Prompt quality improves tool output | PMPT-02 | Empirical — depends on actual tool behavior | Submit same task with/without engine; compare results qualitatively |
| Preview panel UX is intuitive | PMPT-03 | Visual/UX assessment | Open preview, verify side-by-side layout renders correctly |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
