---
id: T02
parent: S01
milestone: M002
provides:
  - decomposition_failed event emitted on all 4 failure paths (process error, timeout, auth, parse failure)
key_files:
  - src-tauri/src/commands/orchestrator.rs
key_decisions:
  - Emit decomposition_failed on process error path too (Ok(Err(e)) arm) — the plan mentioned 3 paths but this 4th path also returns Err during decomposition and deserves the event
patterns_established:
  - decomposition_failed is informational on fallback path (emit then continue) but terminal on Err paths (emit then return)
observability_surfaces:
  - @@orch::decomposition_failed event with { error: string } now fires on process error, timeout, auth error, and parse failure
  - Frontend handleOrchEvent.ts decomposition_failed handler updates masterTask.resultSummary with the error string
duration: 10m
verification_result: passed
completed_at: 2026-03-22
blocker_discovered: false
---

# T02: Emit decomposition_failed event from backend on all failure paths

**Added decomposition_failed event emit on all 4 decomposition failure paths: process error, timeout, auth error, and parse failure fallback**

## What Happened

Added `emit_orch(&on_event, "decomposition_failed", ...)` calls at four failure points in `dispatch_orchestrated_task`:

1. **Process error** (`Ok(Err(e))` from `wait_for_turn_complete`) — emits with `"Master agent process error: {e}"`
2. **Timeout** (`Err(_)` from `timeout()`) — emits with `"Master agent timed out during task decomposition"`, alongside the existing `master_timeout` event
3. **Auth error** (`detect_auth_error` returns `Some`) — emits with the auth error string
4. **Parse failure fallback** (both parse attempts fail) — emits with informational message about falling back to single-task mode, then proceeds with fallback (does not block execution)

The plan specified 3 paths; I added a 4th (process error) because that `return Err` also occurs during decomposition and should surface in the frontend's `resultSummary`.

## Verification

- `rg "emit_orch.*decomposition_failed"` — 4 matches (exceeds slice requirement of ≥2)
- `cargo build` — compiles in 3.28s, 0 errors
- `cargo test --lib orchestrator_test` — 21/21 tests pass
- Confirmed all 3 `return Err` paths in lines 700-960 have `decomposition_failed` emit before them
- Confirmed fallback path emits event but still proceeds to create single-task decomposition

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `cd src-tauri && cargo build` | 0 | ✅ pass | 3.3s |
| 2 | `cd src-tauri && cargo test --lib orchestrator_test` | 0 | ✅ pass (21/21) | 0.01s |
| 3 | `rg "emit_orch.*decomposition_failed" src-tauri/src/commands/orchestrator.rs` | 0 | ✅ pass (4 matches) | <1s |

## Diagnostics

- **Inspect emit sites**: `rg "decomposition_failed" src-tauri/src/commands/orchestrator.rs`
- **Runtime**: When decomposition fails, frontend `handleOrchEvent.ts` `decomposition_failed` case logs the error and sets `masterTask.resultSummary` — this string then flows to `DecompositionErrorCard` (wired in T03)
- **Fallback behavior**: Parse failure emits the event but continues to create a single-task fallback decomposition. The `is_decomposition_fallback` flag auto-approves it.

## Deviations

- Added `decomposition_failed` emit on the process error path (`Ok(Err(e))` arm, line ~797) which wasn't explicitly in the plan but is a legitimate decomposition failure path that returns `Err`.

## Known Issues

None.

## Files Created/Modified

- `src-tauri/src/commands/orchestrator.rs` — Added `decomposition_failed` emit on 4 failure paths: process error (~line 798), timeout (~line 808), auth error (~line 818), parse failure fallback (~line 910)
