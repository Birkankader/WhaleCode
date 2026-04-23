# Visual obs 06 — crash category ErrorBanner

**Recorded:** 2026-04-23 using the Step 0 fake-agent fixtures.

## What to watch

Six category copies rendered for each failure:

| `errorCategory` | Banner copy | Trigger fixture |
|-----------------|-------------|-----------------|
| `process-crashed` | "Agent crashed (non-zero exit)" | `fake_crash_sigsegv.sh` |
| `task-failed` | "Agent refused task" | `fake_task_refused.sh` |
| `parse-failed` | "Agent returned malformed output" | `fake_malformed_json.sh` |
| `timeout` | "Agent timed out" | `fake_hang.sh` |
| `spawn-failed` | "Agent not found (spawn failed)" | binary-missing env |
| `orchestrator-panic` | "Orchestrator worker panicked — please report this" | injected `JoinError` |

## Observations

1. **Round-trip is lossless.** Backend `AgentError::X → ErrorCategory::Y → errorCategory: 'z-kebab'` mapping has per-category integration test coverage. No collapse into generic-copy fallback in any of the six cases.
2. **Legacy payload path** — replaying a pre-Phase-4 event fixture with `errorCategory` absent renders the generic "Agent failed" copy without crashing the Zod parser. Verified by unit test in `ipc.test.ts`.
3. **A11y label** — each banner variant exposes a descriptive `aria-label`, visible to VoiceOver. Snapshot tests capture the labels.
4. **Copy is kept short.** All six strings fit on one line in a 200px-wide worker card footer without truncation on the default zoom level.

## Regressions: none.
