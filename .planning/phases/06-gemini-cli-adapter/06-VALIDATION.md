---
phase: 6
slug: gemini-cli-adapter
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-06
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust: `cargo test`, Frontend: vitest |
| **Config file** | vitest via package.json `"test": "vitest"` |
| **Quick run command** | `cd src-tauri && cargo test adapters::gemini` |
| **Full suite command** | `cd src-tauri && cargo test && cd .. && npm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd src-tauri && cargo test adapters::gemini`
- **After every plan wave:** Run `cd src-tauri && cargo test && cd .. && npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 6-01-01 | 01 | 1 | INTG-02 | unit | `cd src-tauri && cargo test adapters::gemini::tests` | Wave 0 | pending |
| 6-01-02 | 01 | 1 | INTG-03 | unit | `cd src-tauri && cargo test adapters::gemini::tests::test_validate` | Wave 0 | pending |
| 6-01-03 | 01 | 1 | INTG-04 | unit | `cd src-tauri && cargo test adapters::gemini::tests::test_detect_rate_limit` | Wave 0 | pending |
| 6-02-01 | 02 | 1 | PROC-02 | integration | `cd src-tauri && cargo test commands::gemini` | Wave 0 | pending |
| 6-02-02 | 02 | 1 | INTG-02 | unit | `cd src-tauri && cargo test commands::gemini` | Wave 0 | pending |
| 6-03-01 | 03 | 2 | INTG-03 | unit | `npm test -- --run src/tests/gemini.test.ts` | Wave 0 | pending |
| 6-03-02 | 03 | 2 | INTG-02 | unit | `npm test -- --run src/tests/gemini.test.ts` | Wave 0 | pending |

*Status: pending · green · red · flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/adapters/gemini.rs` — Gemini adapter with event parsing, validation, rate limit detection, and unit tests (mirrors claude.rs test structure)
- [ ] `src/tests/gemini.test.ts` — Frontend Gemini event formatting tests (mirrors claude.test.ts)
- [ ] `src/lib/gemini.ts` — Frontend Gemini event types and formatter

*Wave 0 stubs are created as part of Plan 01 (adapter module) and Plan 03 (frontend).*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Gemini CLI spawns in headless mode on real project | PROC-02 | Requires Gemini CLI binary + valid API key | 1. Set Gemini API key in settings 2. Create a task with Gemini adapter 3. Verify streaming output appears in output log |
| Rate limit backoff with user notification | INTG-04 | Requires triggering real API rate limit | 1. Send rapid burst of Gemini tasks 2. Verify notification appears on 429 3. Verify task backs off and retries |
| Adapters interchangeable via Tool trait | INTG-04 | Structural verification | 1. Compare spawn_claude_task and spawn_gemini_task signatures 2. Verify process manager handles both identically 3. Verify no adapter-specific code in process manager |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
