# Phase 7 Step 0 — Adapter follow-up diagnostic

## Why this diagnostic exists

Phase 7 Step 5 introduces follow-up runs: after a parent run reaches Applied or Rejected, the user can submit an incremental prompt that builds on the parent's branch state. The follow-up runs as a new top-level Run record with `parent_run_id` foreign key (Q3 in the spec), preserving audit trail while threading lineage.

The open question this diagnostic answers: **does the master agent benefit from the parent run's full conversation context being injected into the follow-up's prompt, or is a fresh prompt referencing the parent's commit SHA + branch sufficient?** The cost-quality tradeoff matters because:

- **Resending full context** (Option A) inflates every follow-up's prompt size by the parent's transcript. Token cost scales with parent-run depth. Gemini's `PROMPT_CHAR_BUDGET` (~60 KB) makes this actively dangerous on long parents.
- **Fresh prompt with commit-SHA reference** (Option B) costs nothing extra. The agent inspects the worktree state (already at the parent's commit) to discover what's been done. Discovery cost: 1-3 extra tool-use events at the start of the follow-up.

This diagnostic answers the question by exercising six fixtures (3 adapters × with-prefix + fresh-prompt) and asserting the discovery-cost delta is real and bounded.

## Findings

### Per-adapter format matrix

| Adapter | CLI invocation shape | Stateless? | Native session token? | Effect of parent-context prefix |
|---|---|---|---|---|
| **Claude** (`--print --output-format stream-json --verbose`) | Stateless single-shot. Each invocation is a fresh request. | Yes | No (CLI does not surface `--session-id` to the orchestrator path) | With prefix: 1 extra `Bash $"git log"` discovery event + 1 extra `thinking` block. Without prefix: agent reads the source directly, infers from worktree state. Both shapes converge on the same Edit + Bash test events. |
| **Codex** (`exec --json --full-auto`) | Stateless single-shot. JSONL events. | Yes | No | With prefix: 1 extra `function_call name="shell"` (`git log`) at the start. Without prefix: skips `git log`, goes straight to `read` + `apply_patch`. Both shapes produce the same `apply_patch` covering the same files. |
| **Gemini** (`--output-format text --yolo`) | Stateless single-shot. Plain prose. | Yes | No | With prefix: 2-3 extra prose lines of git-log discovery framing ("Looking at recent commits…", `Running: git log…`, "Found existing… shipped by parent run"). Without prefix: agent goes straight to read + edit prose. Heuristic regex matcher catches the verb-prefix lines either way. **Special concern:** Gemini's `PROMPT_CHAR_BUDGET` ~60 KB; full-transcript-as-prefix risks 413s on long parents. |

All three adapters are stateless single-shot in our worker invocation surface. None carry session state across invocations. None expose a `--session-id` or `--continue` flag we currently use. This means **prior conversation context can only enter the follow-up via the prompt body** — there is no native mechanism for "carry-on-conversation."

### Cost delta — by line count

The `followup_with_prefix_consistently_costs_more_per_adapter` cross-adapter test asserts the with-prefix shape is strictly more verbose than the fresh shape per adapter (positive delta in stdout line count). Observed deltas on the fixture pairs:

| Adapter | with-prefix lines | fresh lines | Delta |
|---|---|---|---|
| Claude | 9 | 6 | +3 (1 `Bash`, 1 `thinking`, 1 `system` framing) |
| Codex | 6 | 5 | +1 (extra `shell` function_call) |
| Gemini | 9 | 5 | +4 (3 discovery prose lines + framing) |

Deltas are bounded — small constant overhead, not scaling with parent-run depth. The discovery cost the agent pays without prefix is bounded by **the agent's own decision to verify**, not by the parent transcript size. This is the leverage Phase 7 Step 5 should rely on.

### Stream protocols + ordering invariants

- **Claude follow-up.** NDJSON envelope unchanged from Phase 6 Step 2. `tool_use` + `thinking` + `result` event types parse identically. No new event shapes to handle in the parser; the production parser tee absorbs follow-up runs without modification.
- **Codex follow-up.** JSONL envelope unchanged from Phase 6 Step 2. `function_call` + `task_started` + `task_completed` events parse identically. `apply_patch` multi-file expansion behavior (one chip per file) is unchanged.
- **Gemini follow-up.** Text mode prose unchanged. Heuristic regex matcher's verb-prefix patterns continue to apply. The "Looking at recent commits" framing line in the with-prefix shape does NOT match a verb prefix and silently drops — accepted per Phase 6 Step 0 fidelity-gap recommendation.

No adapter-side parser changes needed for follow-up runs. The Phase 6 Step 2 parser is sufficient.

## Recommendation: Option B — fresh prompt with parent commit-SHA reference

Phase 7 Step 5 should ship the **fresh-prompt** shape: a new prompt that references the parent's commit SHA + branch via the existing `extra_context` channel, NOT a full-transcript-as-prefix injection.

Rationale:

1. **All three adapters work cleanly with the fresh shape.** The fixture pairs show convergent edit + test behavior between the two shapes. The agent does the same useful work; the difference is purely in upfront discovery overhead.
2. **Cost is bounded and predictable.** The fresh-prompt shape's discovery overhead is 1-4 extra events per adapter, regardless of parent-run depth. Full-transcript injection scales O(parent depth) and risks Gemini 413s.
3. **Worktree state is already authoritative.** The follow-up run starts in a worktree that already has the parent's commit applied. The agent can `git log` / `Read` / `Grep` to discover what's there. Pre-injecting the transcript duplicates information the worktree already encodes.
4. **Simpler dispatch surface.** `extra_context = "Follow-up to parent run on branch <branch> (commit <sha>). Parent task: <one-line summary>. New ask: <user prompt>."` fits cleanly into the existing `build_execute_prompt(subtask, worktree, notes, extra_context)` signature shared by all three adapters. No adapter-trait changes needed.

Implementation in Phase 7 Step 5:

- New `start_followup_run(parent_run_id, prompt)` IPC reads parent's `final_branch` + `commit_sha` + a derived 1-line summary (last subtask's title or run title).
- Builds an `extra_context` string of the form: `"Follow-up to parent run on branch <branch> (commit <sha>). Parent shipped: <summary>. Continue with: <prompt>."`
- Submits via existing `submit_run` pipeline with `extra_context` populated. No new master-prompt template; reuses `build_plan_prompt` with the prefix appended via the existing `# Retry context` block (which Phase 5 Step 4 + Phase 6 Step 4 also use).
- Worker prompts inherit the parent-context prefix the same way (via `build_execute_prompt`'s `extra_context` parameter).

This keeps the diff surface small: one new IPC + one new event + one schema column (`parent_run_id`). No adapter changes; no prompt-template changes; no token-budget concerns.

## Risks + open questions

- **Gemini truncation.** Even the fresh-prompt shape's `extra_context` string can grow if the parent's run summary is verbose. Apply Gemini's existing `trim_tree_to_budget` to the follow-up `extra_context` on the Gemini path. Phase 7 Step 5 acceptance criterion.
- **Follow-up of a follow-up.** The diagnostic does not exercise A → B → C lineage. The recommendation generalizes naively: each follow-up references its immediate parent's commit; the chain is implicit in the worktree's git history. Phase 7 Step 5 ships without a chain-depth cap (per spec). Phase 8 may add one if abuse appears.
- **Multi-subtask parent.** The diagnostic uses single-subtask parents. The recommendation derives from "what does the agent need to continue the work?" — a multi-subtask parent's `final_branch` + `commit_sha` still encodes the merged result. Step 5 implementation should reference the merged commit, not per-subtask commits.
- **Concurrent follow-ups from same parent.** Spec defers this to Step 8 if ambiguous. The recommendation here is independent of concurrency policy: each follow-up is a new Run, each gets its own `extra_context` prefix.

## Diagnostic outputs

- 6 fixtures under `src-tauri/src/agents/tests/followup_fixtures/`:
  - `claude_followup.sh`, `claude_followup_fresh.sh`
  - `codex_followup.sh`, `codex_followup_fresh.sh`
  - `gemini_followup.sh`, `gemini_followup_fresh.sh`
- 7 baseline tests in `src-tauri/src/agents/tests/followup_shapes.rs` covering per-adapter with-prefix and fresh shapes plus a cross-adapter cost-delta assertion. All pass on diagnostic-commit gates.
- This document. Read by Phase 7 Step 5 implementation; the recommendation drives the IPC + dispatch path design.
