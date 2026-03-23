# S01 UAT: Decomposition & Error Pipeline

## Preconditions

- WhaleCode built and running locally (`cargo tauri dev` or packaged build)
- At least one CLI agent installed and authenticated (Claude Code, Gemini CLI, or Codex CLI)
- A git repository open in WhaleCode as the active project

---

## Test Case 1: Successful Decomposition with LLM-Provided Task IDs

**Goal:** Verify the master agent decomposes a task and sub-tasks appear with correct IDs and agent assignments.

1. Open WhaleCode and navigate to the orchestration view
2. Enter a multi-step task prompt, e.g.: *"Create a new utility module in src/utils/strings.ts with camelCase and snakeCase converter functions, then add unit tests in src/tests/strings.test.ts, then update the README to document the new utilities"*
3. Select any available agent as the master agent
4. Click "Start Orchestration" (or equivalent launch button)
5. **Expected:** The decomposition phase completes and sub-tasks appear in the task plan UI
6. **Expected:** Each sub-task has an agent assignment displayed (not "unknown" or blank)
7. **Expected:** If the LLM provided task IDs (e.g., `t1`, `t2`, `t3`), the DAG uses those IDs — visible in orchestration logs showing `task_assigned` events with `dag_id` values matching LLM output
8. **Expected:** The `phase_changed` event during decomposing includes `plan_id` and `master_agent` (visible in orchestration logs or dev console)
9. **Expected:** The approval screen appears with all sub-tasks listed

**Pass criteria:** Sub-tasks appear, agent assignments are populated, DAG IDs are present in events.

---

## Test Case 2: Decomposition Parse Failure → Fallback to Single Task

**Goal:** Verify that when the LLM returns unparseable output, the system falls back to a single task and shows a warning.

1. Start an orchestration with a prompt that is likely to produce a non-JSON response from the master agent (e.g., an extremely vague prompt like *"do something"*)
2. Alternatively, temporarily break the master agent's path in settings to force a process error
3. **Expected:** If decomposition JSON parsing fails, a `decomposition_failed` event is emitted (visible in orchestration logs)
4. **Expected:** The system falls back to executing the original prompt as a single task (auto-approved)
5. **Expected:** The DecompositionErrorCard (if displayed) shows a humanized message like "The master agent's response couldn't be parsed as a task plan" — not raw Rust error text
6. **Expected:** Expandable "Orchestration Logs" section in the error card contains the raw error detail for debugging

**Pass criteria:** Fallback executes without crash, error message is user-friendly, raw detail accessible.

---

## Test Case 3: Decomposition Timeout Error

**Goal:** Verify that a timed-out master agent produces an actionable error message.

1. Set the master agent timeout to a very low value (e.g., 5 seconds) in settings, if configurable
2. Start an orchestration with a complex prompt that will take longer than the timeout
3. **Expected:** A `decomposition_failed` event fires with a message about timeout
4. **Expected:** DecompositionErrorCard displays a humanized message like "The master agent didn't respond in time" — not "timeout elapsed"
5. **Expected:** The orchestration terminates cleanly (no zombie master agent process)

**Pass criteria:** Timeout produces user-friendly error, orchestration stops cleanly.

---

## Test Case 4: Decomposition Auth Error

**Goal:** Verify that an authentication failure during decomposition is surfaced clearly.

1. Temporarily invalidate the selected master agent's credentials (e.g., revoke API key or rename the CLI binary)
2. Start an orchestration
3. **Expected:** A `decomposition_failed` event fires with the auth error string
4. **Expected:** The error message in the UI tells the user to check their agent credentials — not a raw process error
5. **Expected:** The orchestration terminates without hanging

**Pass criteria:** Auth error identified and displayed with actionable guidance.

---

## Test Case 5: humanizeError Pattern Coverage

**Goal:** Verify that known error patterns produce friendly messages.

1. Open browser dev console or check orchestration logs
2. Trigger (or simulate via dev tools) the following error strings reaching DecompositionErrorCard:
   - `"Decomposition parse failed after all strategies"` → should display friendly parse failure message
   - `"Fallback: running original prompt as single task"` → should display friendly fallback message  
   - `"Master agent timed out during task decomposition"` → should display friendly timeout message
3. **Expected:** Each produces a distinct, human-readable message (not the raw error string)
4. **Expected:** The raw error string is still visible in the expandable logs section

**Pass criteria:** All 3 decomposition-specific patterns produce humanized output.

---

## Test Case 6: DAG ID Fallback — Mixed/Missing IDs

**Goal:** Verify the all-or-nothing ID strategy when some LLM tasks lack IDs.

1. This is best verified via unit tests (already automated), but can be spot-checked:
2. If possible, craft a prompt that produces tasks where the LLM omits `id` on some tasks
3. **Expected:** ALL tasks fall back to index-based IDs (`t1`, `t2`, `t3`) — no mix of LLM IDs and generated IDs
4. **Expected:** `depends_on` references still resolve correctly within the DAG

**Pass criteria:** No partial-ID DAG; fallback is consistent.

---

## Edge Cases

- **Empty prompt:** Submitting an empty or whitespace-only prompt should not crash the decomposition pipeline
- **Single sub-task result:** If the LLM decomposes into exactly 1 task, it should still work (not treated as a parse failure)
- **Very large decomposition:** If the LLM returns 10+ sub-tasks, they should all appear in the plan with correct IDs
- **Agent not installed:** If the master agent binary is not found, the error should be humanized (not "ENOENT" or "No such file")
