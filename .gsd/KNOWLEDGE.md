# Knowledge Base

<!-- Lessons learned, gotchas, and patterns that save future agents from repeating investigation. -->

## K001: Full `cargo test --lib` times out (pre-existing)

Running `cargo test --lib` without filters on the WhaleCode Rust crate takes 120s+ and times out. This is caused by integration tests that spawn external CLI processes. **Always use targeted test commands:**
- `cargo test --lib orchestrator_test` — orchestrator unit tests (~29 tests, <1s)
- `cargo test --lib -- "router::"` — router tests (~50 tests, <1s)

## K002: SubTaskDef serde pattern — `#[serde(default)]` for optional fields

When adding new optional fields to `SubTaskDef` or similar structs deserialized from LLM JSON output, use `#[serde(default)]` with `Option<String>`. This ensures backward compatibility — existing JSON without the new field still deserializes. The LLM may or may not include the field; the all-or-nothing strategy in DAG construction handles both cases.

## K003: Frontend event handlers already declared optional fields before backend populated them

`handleOrchEvent.ts` declared `dag_id`, `plan_id`, `master_agent` as optional fields on event payloads before the backend ever sent them. When wiring new backend events, check the frontend handler first — it may already expect the data shape. The `setActivePlan` call at line 53 existed but never fired because the backend wasn't sending `plan_id`.

## K004: humanizeError pattern ordering matters

Decomposition-specific patterns must be placed at the **top** of the `ERROR_PATTERNS` array in `humanizeError.ts` so they match before generic patterns. E.g., `"not valid JSON"` should match the decomposition-specific pattern before a hypothetical generic JSON pattern. When adding new patterns, consider match priority.

## K005: decomposition_failed has dual semantics

The `decomposition_failed` event is **informational** on the parse-failure-fallback path (emitted, then orchestration continues with single-task mode) but **terminal** on process error, timeout, and auth error paths (emitted, then `return Err`). Frontend handlers should not assume this event always means orchestration has stopped.

## K006: `tauri::State<'_>` cannot be used in spawned Tokio tasks

`tauri::State<'_>` has a non-`'static` lifetime, so it can't cross `tokio::task::JoinSet::spawn` boundaries. When dispatch logic needs to run inside spawned tasks, use the inner `AppState` (`Arc<Mutex<AppStateInner>>`) and `ContextStore` (`Arc<ContextStore>`) directly. The pattern established in S02 is `dispatch_task_inner()` in `router.rs` — it mirrors `dispatch_task` but accepts owned types. Prefer this over modifying `#[tauri::command]` signatures.

## K007: Orchestrator dispatch_id must be unique per phase for the same plan

The orchestrator runs both decompose and review phases for the same `plan.task_id`. Using `plan.task_id` as the dispatch_id for both phases would cause slot conflicts. Convention: decompose uses `plan.task_id`, review uses `"{plan.task_id}-review"`. Any new phase using the same plan must mint its own suffix.

## K008: Worker events within a wave are interleaved — do not assume sequential ordering

After S02's parallel dispatch via JoinSet, `worker_started`, `task_completed`, and `task_failed` events within the same DAG wave arrive in non-deterministic order. Frontend consumers must use `dag_id` to correlate events to the correct task card, never rely on arrival sequence.

## K009: Use `spawn_blocking` for git2 operations in async orchestrator context

git2 crate functions (auto_commit_worktree, generate_worktree_diff) are blocking I/O. Call them via `tokio::task::spawn_blocking` inside the async orchestrator to avoid blocking the Tokio runtime. The pattern: clone paths/strings into owned values, move into the closure, return the result via `.await`.

## K010: Worktree branch name → directory name derivation uses strip-prefix

Both `merge_worktree` cleanup and `remove_single_worktree` derive the worktree directory name from the branch name by stripping the `whalecode/task/` prefix and using the remainder as the directory name under `.whalecode-worktrees/`. When adding new worktree operations, use this same derivation — do not hardcode directory names independently.

## K011: Cargo.toml is in `src-tauri/`, not project root

Rust test commands (`cargo test --lib`) must run from `src-tauri/` or use `--manifest-path src-tauri/Cargo.toml`. The project root is a Tauri+Vite project where `Cargo.toml` lives in the `src-tauri/` subdirectory.

## K012: Tailwind hover classes can't override inline styles — move base property to className

When replacing `onMouseEnter`/`onMouseLeave` style handlers with Tailwind `hover:` classes, if the hover changes a property that's also set in the element's inline `style` (e.g., `background`, `borderColor`), the inline style will always win over the CSS class. Move the base value from inline `style` to a Tailwind class (e.g., `bg-wc-surface`, `border border-wc-border`) so the `hover:` variant can override it.

## K013: M001 produced only planning artifacts — always verify code exists before closing a milestone

M001 was marked "complete" but had zero non-.gsd/ code changes. M002 had to implement everything from scratch. Future milestone closings must run `git diff --stat` excluding `.gsd/` to confirm actual code was written. If no code exists, the milestone did not deliver.

## K014: FIFO task-matching queues fail under parallel dispatch — use ID-keyed maps

The `subTaskQueue.shift()` pattern assumed tasks completed in FIFO order. With JoinSet parallel dispatch, worker completion order is non-deterministic. Always use a keyed map (like `dagToFrontendId`) for matching events to their originating tasks. The FIFO code was surprisingly entangled — removal touched test helpers, event handlers, and the dispatch hook.

## K015: Phase 2.5 must be sequential — git2 operations contend on the same repo

Auto-commit and diff generation across worktrees must run sequentially, not in parallel. Even though worktrees have separate working directories, `git2::Repository::open` against the same underlying `.git` directory creates contention. Use `spawn_blocking` for each git2 operation and process worktrees one at a time.

## K016: Proportional diff truncation for review prompts

When passing worktree diffs to the review agent, split a total budget (~20KB) evenly across worktrees. Each worktree's diff is capped at its share. This prevents one large diff from consuming the entire context window and starving other worktrees of review coverage.

## K017: useShallow scope — multi-property objects only, not setters or derived values

`useShallow` from `zustand/react/shallow` should wrap selectors that return objects with 2+ non-function properties. Do NOT wrap: single-property selectors (already referentially stable), function/setter selectors (stable by identity), or derived/computed selectors (shallow comparison defeats memoization). The grep audit pattern: `grep useTaskStore src/components/ -r | grep -v useShallow | grep -v getState` — remaining lines should all be single-property or setter calls.
