# Pitfalls Research

**Domain:** AI coding tool orchestration desktop app (Tauri + multi-CLI process management)
**Researched:** 2026-03-05
**Confidence:** HIGH (validated across official docs, GitHub issues, and community sources)

---

## Critical Pitfalls

### Pitfall 1: Parallel Agents Silently Overwriting Each Other's Files

**What goes wrong:**
Two AI tools (Claude Code + Gemini CLI) both receive tasks that touch overlapping files. Neither tool knows the other exists. Tool A writes `auth.ts`, Tool B reads the stale version then overwrites it. The later write silently wins. No error. No conflict. Just lost work.

**Why it happens:**
Each CLI tool assumes it has exclusive access to the working directory. The orchestrator dispatches tasks concurrently without modeling file-level dependencies between tasks. Conflict is only discovered at review time — or never, if the overwritten code still compiles.

**How to avoid:**
Use git worktrees to give each tool agent an isolated working directory on a separate branch. Never let two tools operate on the same working tree simultaneously. Before dispatching parallel tasks, analyze which files each task is likely to touch (based on the task description) and block truly overlapping tasks from running in parallel. Integrate a tool like `clash` or build equivalent pre-dispatch conflict detection.

**Warning signs:**
- Two tasks assigned at the same time that both mention the same module, service, or file by name
- Post-task diffs show one agent's changes replaced another's without a merge event
- "Agent A fixed the bug, but it's missing again" complaints from the developer

**Phase to address:**
Parallel execution / conflict detection phase — must be solved before parallel dispatch is ever enabled. Do not ship parallel execution without worktree isolation.

---

### Pitfall 2: Orphaned CLI Processes After App Shutdown

**What goes wrong:**
The user closes WhaleCode. The Tauri window closes. But Claude Code, Gemini CLI, or Codex CLI processes are still running in the background — consuming CPU, making API calls, and writing to files. On restart, the app spawns new processes on top of old ones, compounding the problem.

**Why it happens:**
Tauri's `on_window_event` handlers are unreliable for cleanup — window close events don't always fire, and if sidecars spawn their own child processes, Tauri's `kill()` only kills the direct child. Spawned children become orphans. This is a documented ongoing issue in Tauri's GitHub (see: `kill process on exit` discussion #3273, sidecar lifecycle issue #3062).

**How to avoid:**
Track every spawned PID in Rust state (Arc<Mutex<Vec<Child>>>). Use `RunEvent::ExitRequested` and `RunEvent::Exit` hooks (not window events) for cleanup — these fire more reliably. Use `group_spawn()` where available to kill the entire process group. After shutdown, actively verify processes are gone using `pkill` by process name as a fallback. On startup, check for and kill any leftover processes from a previous session before spawning new ones.

**Warning signs:**
- `Activity Monitor` shows `claude`, `gemini`, or `codex` processes running after the app is closed
- API usage bills spiking unexpectedly without active app sessions
- macOS asking "Application X is not responding" on second launch

**Phase to address:**
Process management foundation phase — implement and test cleanup before building any higher-level orchestration on top of it.

---

### Pitfall 3: Brittle Output Parsing from CLI Tools Not Designed for Machine Consumption

**What goes wrong:**
The orchestrator wraps Gemini CLI or Codex CLI by reading stdout and parsing the response. This works in development. It breaks in production when: the terminal width changes and text wraps differently, a new CLI version changes the output format, progress spinners or ANSI color codes bleed into the parsed content, or an error message appears on stdout instead of stderr.

**Why it happens:**
CLI tools designed for human terminals make no guarantees about stdout format stability. Developers parse what they see, ship it, and discover breakage when the tool updates or runs in a slightly different environment. This is the #1 fragility point when wrapping tools that weren't designed to be orchestrated.

**How to avoid:**
Always use structured output flags where available (`--output-format json` for Claude Code, `--format json` for Gemini CLI). Set `NO_COLOR=1` and `TERM=dumb` in the spawned process environment to suppress ANSI codes. Capture stdout and stderr separately — never mix them. Build a versioned adapter layer per tool: if the tool's output format changes, only the adapter needs updating. Write output parsing tests against recorded real output samples (snapshot tests), so regressions are caught immediately.

**Warning signs:**
- Parsing works in development but fails in CI or on a fresh machine
- The app breaks after a `claude` or `gemini` package update
- Log lines like "failed to parse tool response" appear intermittently

**Phase to address:**
CLI adapter / integration phase — each tool needs a dedicated adapter with format tests before it's wired into the orchestration engine.

---

### Pitfall 4: Context Drift Between Tools (Each Tool Acts on Stale Project State)

**What goes wrong:**
Tool A refactors a module, changing function signatures. Tool B, dispatched shortly after, was primed with the pre-refactor context. It generates code calling the old signatures. The build breaks. Neither tool is wrong given what it knew — the shared context was out of sync.

**Why it happens:**
Context is expensive to re-generate and slow to transmit. Orchestrators are tempted to snapshot context at task dispatch time and not update it until a task completes. With parallel execution, a context snapshot is stale by the time the second task starts. The problem gets worse as the project grows and more files are modified per task.

**How to avoid:**
Treat the shared context layer as a write-ahead log, not a snapshot. Each tool's task completion must update the context store before the next batch of tasks is dispatched. For parallel tasks, only allow truly independent tasks (different modules, different files) to run concurrently — tasks with any shared dependency must be serialized. Design the context store around file-change events (watch the git diff), not periodic snapshots.

**Warning signs:**
- Tool B calls functions that Tool A just renamed
- "import not found" or "function does not exist" errors in generated code that reference recently changed symbols
- Developer reports "the tools don't seem to know what each other did"

**Phase to address:**
Shared context / project memory phase — must be implemented before parallel execution is enabled.

---

### Pitfall 5: Claude Code Non-Interactive Mode Silent Failures

**What goes wrong:**
WhaleCode dispatches a task to Claude Code using `-p` (headless mode). Claude Code exits with code 0. The response is empty, truncated, or contains a generic "I couldn't complete that task" message. WhaleCode reports success to the user. The task was never done.

**Why it happens:**
Claude Code in `-p` mode has a documented rate of ~8% silent failures where exit code 0 is returned but the response is empty or irrelevant. This happens when: the prompt is ambiguous, the context is insufficient, permissions are too restrictive (`--allowedTools` missing a required tool), or the default 120-second timeout is exceeded for complex tasks. The app has no way to distinguish "successfully did nothing" from "failed silently."

**How to avoid:**
Never trust exit code 0 alone. Parse the output and validate it contains substantive content. Check `result` length, look for error phrases ("I couldn't", "I don't have permission", "I was unable to"). Use `--output-format json` to get structured metadata including session ID and token usage — zero tokens used means nothing happened. Increase timeouts for complex tasks. Log every headless invocation with full stderr for post-hoc debugging.

**Warning signs:**
- Tasks marked complete but files unchanged
- Response output shorter than 50 characters for a complex task
- Session token count in JSON output is near zero

**Phase to address:**
Claude Code adapter phase — implement response validation before any orchestration logic depends on headless output.

---

### Pitfall 6: Tauri IPC Becoming a Bottleneck for Streaming Process Output

**What goes wrong:**
Each AI tool produces streaming output — partial responses appearing over time. The Rust backend forwards each line to the frontend via Tauri's event system. With multiple tools running in parallel, the IPC channel floods. The UI freezes or lags. Sending even 3MB of data over Tauri's IPC has documented latency of ~200ms.

**Why it happens:**
Tauri's IPC serializes all payloads through a JSON-RPC mechanism. Large or high-frequency payloads cause serialization overhead that compounds under concurrency. Developers assume "it's just events" and don't batch or throttle — then discover the UI locking up with 3 tools streaming simultaneously.

**How to avoid:**
Throttle event emission from the Rust side: buffer streaming output in 100-500ms windows, then emit in batches. Never forward every stdout line individually — aggregate and debounce. Use Tauri v2's Raw Request IPC for large payloads instead of the event system. Keep the event system for state changes (tool started, tool completed, error), not for raw output streaming.

**Warning signs:**
- UI becomes unresponsive when 2+ tools are running
- Frontend event handler receiving thousands of events per second
- Memory growing continuously while tools run

**Phase to address:**
Tauri UI / process output display phase — design the output streaming architecture before building the monitoring UI.

---

### Pitfall 7: Rate Limit Collisions When Multiple Tools Share API Quotas

**What goes wrong:**
Claude Code and the orchestrator both call the Anthropic API. Two parallel Claude Code instances hit the same rate limit simultaneously. Both back off and retry at the same interval. They collide again. The thundering herd repeats. Tasks stall or fail after exhausting retries.

**Why it happens:**
Each tool process manages its own rate limit backoff independently, without awareness of other running instances. The orchestrator dispatches tasks without checking available quota. Burst patterns from parallel starts amplify the collision — all tools start at the same moment, all hit rate limits at the same moment.

**How to avoid:**
Implement centralized quota tracking in the Rust backend: count API calls across all spawned processes (using a shared counter in Arc<Mutex<>>). Before dispatching a task, check whether there's headroom in the current rate limit window. Stagger parallel task starts by 1-3 seconds to break synchronization. Add jitter to retry delays (`base_delay + rand(0, base_delay)`) to prevent thundering herd on retry. For Claude Code specifically: it manages its own API calls internally, so limit the number of simultaneous Claude Code instances to 2 maximum in v1.

**Warning signs:**
- Multiple tasks failing with "rate limit exceeded" at the same timestamp
- Tasks taking 10x longer than expected due to repeated backoff cycles
- API usage dashboards showing burst patterns followed by silence

**Phase to address:**
Task dispatcher / queue management phase — rate limit awareness must be part of the task scheduling design, not added as an afterthought.

---

### Pitfall 8: Treating Task Distribution as Routing, Not Coordination

**What goes wrong:**
The task distributor sends Task A to Claude Code and Task B to Gemini CLI because those tools are best suited for each. But Task B depends on the output of Task A. Gemini starts immediately, asks about code that Claude Code is currently generating, produces output based on the pre-Task-A state, and the final result is inconsistent.

**Why it happens:**
Routing ("which tool is best?") and scheduling ("what order?") are conflated. The distributor answers the routing question but ignores the dependency question. The result looks like a working system that produces bad outputs in non-obvious ways.

**How to avoid:**
Model tasks as a DAG (directed acyclic graph), not a queue. Before any task is dispatched, resolve its dependencies — upstream tasks must be complete and their outputs reflected in shared context. The task distributor must answer two questions: "which tool?" AND "is it safe to start now?" Build dependency resolution before building routing intelligence.

**Warning signs:**
- Tasks completing but producing outputs that don't reference each other's work
- Developer finding "this code assumes the old API" in newly generated code
- Integration tests failing after parallel runs that pass after sequential runs

**Phase to address:**
Task orchestration engine phase — DAG scheduling is foundational, must precede intelligent routing.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Polling stdout with a timeout instead of proper async streams | Simpler initial implementation | Missed output, race conditions on fast-completing tasks, CPU waste | Never — use async streams from day one |
| Storing shared context as a flat JSON file | No database dependency | Concurrent write corruption, no history, no rollback | MVP only if single-tool (not parallel) and with file locking |
| Using `--dangerouslyAllowAllTools` for Claude Code | No permission management headache | Any task can delete any file, no audit trail, security risk | Never in a desktop app with user project files |
| Single process for all tool management | Simpler architecture | One crashed tool takes down all orchestration | Never — isolate tool processes |
| Parsing CLI output with regex | Quick to implement | Breaks on every tool update, terminal width change, or locale switch | Never — use structured output flags (`--output-format json`) |
| Skipping git worktrees and sharing one working directory | Fewer moving parts | Silent file overwrites between parallel tools | Never if parallel execution is enabled |

---

## Integration Gotchas

Common mistakes when connecting to the specific tools.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Claude Code (headless) | Trusting exit code 0 as success | Parse JSON output, validate `result` content length and token count |
| Claude Code (headless) | Using interactive-only slash commands like `/commit` in `-p` mode | Describe the task in natural language; slash commands silently do nothing in headless mode |
| Claude Code (headless) | Missing the space in `--allowedTools "Bash(git diff *)"` | The space before `*` is mandatory — without it, `git diff*` matches unintended commands like `git diff-index` |
| Gemini CLI | Assuming stable non-interactive SDK support | Gemini CLI has documented lack of full programmatic SDK; use `-p` flag but treat its interface as unstable |
| Gemini CLI | Single-folder workspace assumption | Gemini CLI cannot operate across multi-root workspaces (GitHub issue #6209) — design context sharing to work within this constraint |
| Gemini CLI | Ignoring quota management failures | Gemini CLI has documented multi-day lockouts from quota exhaustion; implement quota checks before dispatching |
| Tauri sidecars | Assuming Tauri kills sidecar children on app exit | Only direct child is killed; grandchild processes become orphans — use process groups and `RunEvent::Exit` |
| Tauri IPC | Using the event system for high-frequency streaming data | Events are JSON-serialized; batch output and use Raw Request IPC for large payloads |
| Tauri secrets | Using the deprecated `stronghold` plugin for API key storage | Use OS keychain via `tauri-plugin-keyring` for API keys — stronghold is being deprecated in v3 |

---

## Performance Traps

Patterns that work at small scale but fail under realistic use.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Forwarding every stdout line as a Tauri event | UI lag, freezing with 2+ tools running | Batch events in 100-500ms windows, use Raw Request for large data | Immediately with 2+ tools streaming in parallel |
| Re-generating full project context on every task | 5-30 second dispatch latency per task | Maintain incremental context as a write-ahead log, update on file changes | After first few tasks when context exceeds ~50 files |
| Spawning a fresh CLI process per task instead of reusing sessions | 2-5 second cold start overhead per task | Use `--resume session_id` for Claude Code to continue sessions; pool processes where possible | Immediately if tasks are frequent and short |
| Storing all tool output in memory for the session | Memory leak over long sessions with many tasks | Stream output to disk, keep only the last N lines in memory | After ~20+ tasks generating verbose output |
| Synchronous context reads in the Rust command handlers | UI freezes while context is read | All file and context I/O must be async (`tokio::fs`, async channels) | On first large project with many files |

---

## Security Mistakes

Domain-specific security issues for a desktop app managing AI tool credentials.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Storing API keys (Anthropic, Google) in plaintext in app config or localStorage | Keys exposed to any process reading app data directory | Use OS keychain (`tauri-plugin-keyring`) — never write API keys to disk unencrypted |
| Passing API keys as CLI arguments to spawned processes | Keys visible in `ps aux` and process lists to any user on the machine | Pass via environment variables (`ANTHROPIC_API_KEY`) to child processes, never as `--api-key` args |
| Using `--dangerouslyAllowAllTools` without scoping to project directory | Claude Code can read/write/delete any file on the filesystem | Scope `allowedTools` to specific Bash commands and always set working directory to the project path |
| Logging full prompts and responses to disk | Developer's code, prompts, and AI responses are sensitive IP — log files may be accessible | Never log raw prompt/response content; log only metadata (session ID, timestamps, token counts) |
| Trusting tool output as safe to render in WebView without sanitization | A malicious code snippet in AI output could execute if rendered as HTML | Treat all tool output as untrusted text; sanitize before rendering in any HTML context |

---

## UX Pitfalls

Common user experience mistakes in AI tool orchestration interfaces.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Showing raw terminal output from AI tools in the UI | Overwhelming, unreadable, no signal-to-noise | Parse and display structured output: file changes, summary, status; offer "raw output" as expandable detail |
| No indication of which tool is working on what | User can't tell what's happening or if things are stuck | Show per-tool status (idle / running / waiting / done / error) with elapsed time and current file being edited |
| Blocking UI while orchestrator dispatches tasks | App feels slow and unresponsive | All orchestration is async; UI is always interactive; use optimistic updates |
| Surfacing conflict errors as cryptic diffs | User doesn't know what to do | Translate conflict into human-readable form: "Tool A and Tool B both modified `auth.ts` — choose which version to keep" |
| Auto-accepting AI changes without review step | User loses confidence, mistakes slip through | Make review the default; auto-accept is opt-in per task or per session |
| Showing all 3 tools' outputs simultaneously with equal weight | Cognitive overload, unclear what to focus on | Show the currently active tool prominently; collapse idle tools |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Parallel execution:** Task A and Task B both completed — verify they did not modify overlapping files. Check git diff across both branches before merge.
- [ ] **Process cleanup:** App quit and restarted cleanly — verify no zombie `claude`/`gemini`/`codex` processes via `pgrep -l claude` before marking process management done.
- [ ] **Context sync:** Both tools ran and produced output — verify Tool B's output references state introduced by Tool A (not pre-Task-A state).
- [ ] **Rate limit handling:** Tasks ran to completion — verify behavior when the Anthropic/Google API returns 429; confirm backoff and retry works without human intervention.
- [ ] **Silent failure detection:** Headless Claude Code returned exit 0 — verify the JSON output `result` field contains substantive content and token count is non-zero.
- [ ] **Output parsing stability:** Tool output parsed correctly today — verify parsing survives after `npm update` of the Claude Code or Gemini CLI package.
- [ ] **Secrets security:** API keys stored and retrieved — verify keys are in OS keychain, not in `~/Library/Application Support/WhaleCode/` in plaintext.
- [ ] **Graceful shutdown:** Window closed — verify no background processes remain, and next launch doesn't error on stale lock files or PID conflicts.

---

## Recovery Strategies

When pitfalls occur despite prevention.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| File overwrite conflict discovered post-merge | MEDIUM | Use git reflog to recover both branches' states; manually diff and merge; add conflict detection to prevent recurrence |
| Orphaned processes found after app crash | LOW | `pkill -f "claude\|gemini\|codex"` on startup; add startup cleanup as a permanent measure |
| Context drift causing cascading bad outputs | HIGH | Discard all in-flight tasks; reset context from a clean git state; re-queue tasks sequentially until root cause is fixed |
| Claude Code headless silent failure in a user workflow | LOW | Re-queue the task with a more explicit prompt and higher timeout; add response validation to prevent future silent successes |
| CLI output format changed after tool update | MEDIUM | Pin the CLI tool version (`npm install -g @anthropic-ai/claude-code@1.x.x`); update the adapter's snapshot tests; unpin once adapter is updated |
| Rate limit thundering herd causing all tasks to fail | LOW | Drain the queue; implement jitter and centralized quota tracking; re-queue one task at a time to confirm recovery |
| API key exposed in process list | HIGH | Rotate the key immediately; audit logs for unauthorized usage; fix to use env vars; notify user |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Parallel agents overwriting files | Phase: Parallel execution + git worktree isolation | Run two agents editing the same file; confirm neither silently overwrites the other |
| Orphaned processes after shutdown | Phase: Process management foundation | Kill the app mid-task; `pgrep` for child processes; confirm zero found |
| Brittle CLI output parsing | Phase: CLI adapter per tool | Update Claude Code / Gemini CLI to latest; confirm adapter tests still pass |
| Context drift between tools | Phase: Shared project memory / context store | Agent B's output must reference Agent A's last commit; verify with a specific symbol rename test |
| Claude Code silent failures | Phase: Claude Code adapter | Force a silent failure (ambiguous prompt + restrictive permissions); confirm orchestrator detects and re-queues |
| Tauri IPC streaming bottleneck | Phase: Tauri UI / output streaming | Run 2 tools in parallel; measure frontend frame rate; must stay above 30fps |
| API rate limit collisions | Phase: Task dispatcher / queue management | Dispatch 5 parallel tasks; confirm no thundering herd; verify jitter in retry logs |
| Task dependency not modeled (routing vs. coordination) | Phase: Task orchestration engine | Dispatch task B that depends on task A; confirm B waits for A to complete before starting |

---

## Sources

- [Claude Code headless mode documentation](https://code.claude.com/docs/en/headless)
- [Headless Mode and CI/CD - Common Mistakes, SFEIR Institute](https://institute.sfeir.com/en/claude-code/claude-code-headless-mode-and-ci-cd/errors/)
- [Tauri: Kill process on exit — Discussion #3273](https://github.com/tauri-apps/plugins-workspace/issues/3062)
- [Tauri: Sidecar Lifecycle Management Plugin — Issue #3062](https://github.com/tauri-apps/plugins-workspace/issues/3062)
- [Git Worktrees for parallel AI agents — DEV Community](https://dev.to/mashrulhaque/git-worktrees-for-ai-coding-run-multiple-agents-in-parallel-3pgb)
- [clash: Avoid merge conflicts across git worktrees](https://github.com/clash-sh/clash)
- [Solving parallel workflow conflicts between AI agents — Medium](https://medium.com/@raminmammadzada/solving-parallel-workflow-conflicts-between-ai-agents-and-developers-in-shared-codebases-286504422125)
- [Why multi-agent systems need memory engineering — MongoDB](https://www.mongodb.com/company/blog/technical/why-multi-agent-systems-need-memory-engineering)
- [Tauri IPC performance — Send data at high rate, Discussion #7146](https://github.com/tauri-apps/tauri/discussions/7146)
- [Tauri secrets storage discussion — Discussion #7846](https://github.com/tauri-apps/tauri/discussions/7846)
- [Gemini CLI limitations — Milvus AI Reference](https://milvus.io/ai-quick-reference/what-are-the-limitations-of-gemini-cli)
- [Gemini CLI programmatic tool calling — Issue #17323](https://github.com/google-gemini/gemini-cli/issues/17323)
- [Writing CLI Tools That AI Agents Actually Want to Use — DEV Community](https://dev.to/uenyioha/writing-cli-tools-that-ai-agents-actually-want-to-use-39no)
- [AI Agent Rate Limiting Best Practices — Fast.io](https://fast.io/resources/ai-agent-rate-limiting/)
- [Top 6 Reasons AI Agents Fail in Production — Maxim](https://www.getmaxim.ai/articles/top-6-reasons-why-ai-agents-fail-in-production-and-how-to-fix-them/)
- [Tauri + Rust performance under pressure — Medium](https://medium.com/@srish5945/tauri-rust-speed-but-heres-where-it-breaks-under-pressure-fef3e8e2dcb3)

---
*Pitfalls research for: WhaleCode — AI coding tool orchestration desktop app (Tauri v2)*
*Researched: 2026-03-05*
