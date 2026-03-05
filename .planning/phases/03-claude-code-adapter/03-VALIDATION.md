---
phase: 3
slug: claude-code-adapter
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-05
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (frontend), cargo test (Rust) |
| **Config file** | `vitest.config.ts` (frontend), `Cargo.toml` (Rust) |
| **Quick run command** | `cd src-tauri && cargo test` |
| **Full suite command** | `cd src-tauri && cargo test && cd .. && npm run test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd src-tauri && cargo test`
- **After every plan wave:** Run `cd src-tauri && cargo test && cd .. && npm run test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 3-01-01 | 01 | 1 | PROC-01 | integration | `cd src-tauri && cargo test adapters::claude::tests -x` | No - W0 | pending |
| 3-01-02 | 01 | 1 | INTG-01 | unit | `cd src-tauri && cargo test adapters::claude::tests::parse_ -x` | No - W0 | pending |
| 3-01-03 | 01 | 1 | INTG-01 | unit | `cd src-tauri && cargo test adapters::claude::tests::silent_failure -x` | No - W0 | pending |
| 3-01-04 | 01 | 1 | INTG-01 | unit | `cd src-tauri && cargo test adapters::claude::tests::rate_limit -x` | No - W0 | pending |
| 3-01-05 | 01 | 1 | N/A | unit | `cd src-tauri && cargo test credentials::keychain::tests -x` | No - W0 | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/adapters/claude.rs` — NDJSON parsing unit tests (covers INTG-01)
- [ ] `src-tauri/src/credentials/keychain.rs` — keychain storage tests (covers API key requirement)
- [ ] `src/tests/claude.test.ts` — frontend Claude event parsing tests

*Wave 0 creates test stubs that later tasks fill in.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| API key stored in macOS Keychain | SC-4 | Requires actual Keychain Access app inspection | 1. Set key via UI 2. Open Keychain Access 3. Search "com.whalecode.app" 4. Verify entry exists |
| Rate limit notification shown to user | SC-3 | Requires actual API rate limit trigger | 1. Set low rate limit scenario 2. Submit task 3. Verify notification appears |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
