# Feature Research

**Domain:** AI coding tool orchestration desktop app (macOS)
**Researched:** 2026-03-05
**Confidence:** MEDIUM-HIGH (WebSearch verified against official product pages and docs)

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = product feels incomplete or broken.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Parallel agent execution | Every serious competitor (Cursor, OpenAI Codex app, Augment Intent) runs agents in parallel; sequential execution defeats the purpose | HIGH | Requires isolated execution environments; git worktrees are the dominant pattern |
| Git worktree isolation per agent | Multiple agents touching the same repo without isolation = immediate file conflicts; worktrees are the standard solution (used by Codex app, Intent, Clash) | MEDIUM | Each agent gets its own worktree; parent manages merge back to main branch |
| Live agent status visibility | Users need to see which agents are running, paused, or done — "fire and forget" without status is anxiety-inducing | MEDIUM | Status panel showing each tool's state, current task, and last output |
| Diff review before commit | Every tool in this space (Codex app, Intent, Cursor agents) gates changes behind a human review step; auto-committing without review is a trust-breaker | MEDIUM | Unified diff view per agent, with accept/reject at line or file level |
| Persistent project context | The #1 user pain point is re-explaining context to each tool every session; Claude Code uses CLAUDE.md, others use memory files | HIGH | Shared context store that all tools read; maps to CLAUDE.md/AGENTS.md pattern across tools |
| Task history awareness | Tool A must know what Tool B changed; without this, agents contradict each other and undo each other's work | HIGH | The defining problem WhaleCode solves — event log of all changes, indexed by file |
| Native macOS experience | Users choosing a desktop app over terminal expect native feel — proper window management, menubar, notifications, keyboard shortcuts | MEDIUM | Tauri v2 enables this; avoid web-app-in-a-shell aesthetic |
| Per-tool output log | Each AI tool produces verbose output; users need to inspect what each tool actually did, not just a summary | LOW | Scrollable log per agent thread, with timestamps |
| Conflict detection | When two agents edit the same file, this must surface before merge, not after; Clash and GitKraken both flag this proactively | HIGH | File-level lock or change-set comparison before agent completes |
| Cancel/pause agent | Users need control — a runaway agent needs to be stopped without losing other agents' progress | LOW | Per-agent stop/pause controls; graceful shutdown of subprocess |

### Differentiators (Competitive Advantage)

Features that set the product apart. These map directly to WhaleCode's stated Core Value.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Automatic prompt optimization per tool | User writes one prompt; WhaleCode rewrites it for each tool's conventions (Claude prefers extended thinking + explicit planning; Gemini benefits from larger context dumps; Codex CLI prefers concise task framing) | HIGH | This is the key differentiator — no competitor does cross-tool prompt rewriting today; requires per-model prompt templates and routing logic |
| Intelligent task routing | System decides which tool handles which task based on task type and each tool's strengths (Claude for complex refactoring/architecture, Gemini for large codebase reads, Codex for test generation) | HIGH | Requires a routing model or rules engine; can start rule-based, evolve to ML-based; no competitor does cross-tool routing today |
| Unified shared context across heterogeneous tools | Claude Code, Gemini CLI, and Codex CLI each have separate context systems (CLAUDE.md, AGENTS.md); WhaleCode maintains one source of truth and writes it to each tool's native format | HIGH | Technically hardest feature; translates one context schema to multiple tool-specific formats |
| Cross-tool change awareness event log | Structured log of every file change by every tool, queryable by path or agent; injected into each tool's context before it starts a task | MEDIUM | Like a git log but richer — includes intent, not just diffs; enables true "Tool A knows what Tool B did" |
| Bounded autonomy controls | Per-task guardrails specifying which files an agent may touch, which commands it may run, what it must ask before proceeding — modeled on Cursor's "bounded autonomy" pattern | MEDIUM | Trust-building feature; makes power users comfortable running multiple agents simultaneously |
| Task decomposition assistant | User describes a feature; WhaleCode breaks it into subtasks and assigns each to the optimal tool — eliminating the coordination overhead the user currently does manually | HIGH | Requires an orchestration model layer (likely Claude Opus as planner, then routing decisions) |
| Conflict resolution suggestions | When two agents produce conflicting changes, surface both diffs side-by-side with an AI-suggested resolution — not just raw merge conflict markers | HIGH | AI merge conflict resolution is emerging (GitKraken AI, VS Code 1.105) — WhaleCode can do it cross-tool |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good but create problems — build these and you'll regret it.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Built-in code editor | "Everything in one app" sounds great | Scope explosion; you'd be competing with Cursor and VS Code instead of complementing them; WhaleCode's value is coordination, not editing | Open diffs in the user's existing editor (VS Code, Cursor) via file path handoff |
| Real-time agent-to-agent communication | Feels like the agents would be smarter if they talked directly | Cursor tested this: equal-status agents with coordination slowed 20 agents to 2-3 effective throughput; communication overhead is exponential | Hierarchical: WhaleCode as orchestrator writes context files; agents are stateless workers that read context |
| Fully autonomous unattended operation | Users want to "set it and forget it" | METR research found developers perceived 20% speedup but were actually 19% slower; autonomous agents accumulate technical debt, copy-paste code, avoid hard refactoring | Bounded autonomy with mandatory human review gates at configurable checkpoints |
| More than 3 tools in v1 | "Support every AI tool" sounds like a feature | Each tool integration requires a separate adapter, prompt template, context translator, and test surface; more tools = quadratically more edge cases | Ship with Claude Code + Gemini CLI, then add Codex CLI; design adapter interface to make adding tools mechanical not heroic |
| Custom AI model selection per tool | Power users want to choose which Claude model WhaleCode uses for orchestration | Routing layer complexity explodes; model capability differences break prompt templates | Lock orchestration to Opus 4.5 as planner, let each tool use its own default model for execution |
| Automatic push to remote | Convenient, but removes a critical human checkpoint | One bad agent run + auto-push = corrupted remote history visible to teammates | Auto-commit to local branch only; always require explicit push |
| Chat interface for task entry | Familiar from Cursor/Windsurf, feels natural | If WhaleCode has a chat, users will expect it to be a coding tool itself — scope and positioning confusion | Structured task input form (description, target files, tool preference, guardrails) rather than open chat |

---

## Feature Dependencies

```
[Parallel Agent Execution]
    └──requires──> [Git Worktree Isolation]
                       └──requires──> [Conflict Detection]

[Task Routing (Differentiator)]
    └──requires──> [Parallel Agent Execution]
    └──requires──> [Persistent Project Context]

[Prompt Optimization (Differentiator)]
    └──requires──> [Task Routing]
    └──requires──> [Per-tool adapter layer]

[Cross-tool Change Awareness (Differentiator)]
    └──requires──> [Task History / Event Log]
    └──requires──> [Persistent Project Context]
    └──enhances──> [Conflict Detection]

[Diff Review]
    └──requires──> [Git Worktree Isolation]
    └──enhances──> [Conflict Resolution Suggestions (Differentiator)]

[Task Decomposition Assistant (Differentiator)]
    └──requires──> [Task Routing]
    └──enhances──> [Parallel Agent Execution]

[Live Agent Status]
    └──requires──> [Per-tool output log]
    └──enhances──> [Cancel/Pause Agent]

[Bounded Autonomy Controls (Differentiator)]
    └──enhances──> [Parallel Agent Execution]
    └──enhances──> [Conflict Detection]
```

### Dependency Notes

- **Git Worktree Isolation requires Conflict Detection:** Creating isolated worktrees is only half the solution; without proactive conflict detection before merge, isolation is incomplete.
- **Task Routing requires Persistent Project Context:** The router cannot make good decisions about which tool to use if it does not understand the project structure and past decisions.
- **Prompt Optimization requires Per-tool Adapter Layer:** Adapters must be built before prompt templates can be applied; rushing prompt optimization before adapters are stable causes brittle behavior.
- **Cross-tool Change Awareness requires Event Log:** The event log is the infrastructure; cross-tool context injection is the application on top.
- **Task Decomposition Assistant requires Task Routing:** Decomposition generates subtasks; routing decides where each one goes. Decomposition without routing is just a task list with no execution.
- **Conflict Resolution Suggestions conflict with Autonomous Merge:** Offering AI suggestions implies human decision-making remains in the loop. Never automatically resolve conflicts without user confirmation.

---

## MVP Definition

### Launch With (v1)

Minimum viable to validate that multi-tool orchestration is worth the coordination overhead.

- [ ] **Git worktree isolation per agent** — Without this, parallel execution causes immediate file conflicts that destroy trust in the product
- [ ] **Parallel execution (Claude Code + Gemini CLI)** — Two tools in parallel is the core hypothesis; must ship to validate
- [ ] **Persistent shared project context** — CLAUDE.md-compatible context file maintained by WhaleCode, injected into each tool before it starts; eliminates re-explaining
- [ ] **Task history event log** — File-level change log per agent, readable by other agents; the structural solution to "Tool A doesn't know what Tool B did"
- [ ] **Live agent status panel** — Running / completed / failed state per agent; minimal but essential for user confidence during parallel runs
- [ ] **Diff review before commit** — Human-in-the-loop gate; without this, the product is not safe to use on real projects
- [ ] **Conflict detection** — Surface file-level overlap between agents before merge; even a simple file lock warning is sufficient for v1
- [ ] **Cancel/pause per agent** — Control over runaway agents; required for production trust

### Add After Validation (v1.x)

Add when core orchestration is validated and users report specific friction.

- [ ] **Automatic prompt optimization per tool** — Validate that users accept AI-rewritten prompts; measure whether rewrites improve output quality vs. raw prompt
- [ ] **Intelligent task routing** — Start with user-controlled tool assignment; add automatic routing once routing rules are stable
- [ ] **Bounded autonomy controls** — Add guardrails (file allowlist/denylist per task) when users report unintended agent behavior
- [ ] **Codex CLI adapter** — Third tool; add after two-tool architecture is stable and adapter interface is proven

### Future Consideration (v2+)

Defer until product-market fit is confirmed.

- [ ] **Task decomposition assistant** — High complexity; requires orchestration model + routing working well together; premature if routing is still manual
- [ ] **Conflict resolution suggestions** — AI-suggested merge resolutions; valuable but requires strong diff infrastructure first
- [ ] **Cross-team context sharing** — Multi-developer shared context; v1 is single-developer only
- [ ] **Automation scheduling** — Background agent runs on schedules (like Codex app Automations); powerful but adds async state management complexity

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Git worktree isolation | HIGH | MEDIUM | P1 |
| Parallel execution (2 tools) | HIGH | HIGH | P1 |
| Persistent project context | HIGH | HIGH | P1 |
| Task history event log | HIGH | MEDIUM | P1 |
| Diff review before commit | HIGH | MEDIUM | P1 |
| Conflict detection | HIGH | HIGH | P1 |
| Live agent status panel | MEDIUM | LOW | P1 |
| Cancel/pause per agent | MEDIUM | LOW | P1 |
| Per-tool output log | MEDIUM | LOW | P1 |
| Automatic prompt optimization | HIGH | HIGH | P2 |
| Intelligent task routing | HIGH | HIGH | P2 |
| Bounded autonomy controls | MEDIUM | MEDIUM | P2 |
| Codex CLI adapter (3rd tool) | MEDIUM | MEDIUM | P2 |
| Task decomposition assistant | HIGH | HIGH | P3 |
| Conflict resolution suggestions | MEDIUM | HIGH | P3 |
| Automation scheduling | MEDIUM | HIGH | P3 |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add when possible
- P3: Nice to have, future consideration

---

## Competitor Feature Analysis

| Feature | OpenAI Codex App | Augment Intent | Cursor Agents | WhaleCode Approach |
|---------|-----------------|----------------|---------------|-------------------|
| Parallel agent execution | Yes — multiple threads per project | Yes — coordinator fans to implementor agents in waves | Yes — up to 20 agents on separate VMs | Yes — core premise; local execution |
| Worktree isolation | Yes — built in | Yes — each workspace has own worktree | Yes — separate VMs | Yes — git worktrees, single machine |
| Tool heterogeneity | No — Codex CLI only | Partial — Claude Code, Codex, OpenCode (not mixed on same task) | No — Cursor agents only | Yes — Claude Code + Gemini CLI + Codex CLI simultaneously |
| Prompt optimization per tool | No | No — unified context engine | No | Yes — planned differentiator; no competitor does this |
| Cross-tool change awareness | No — single tool | Partial — shared Context Engine but single provider at a time | No | Yes — planned core feature |
| Intelligent task routing | No | Partial — coordinator assigns subtasks to implementors | No | Yes — planned; routes tasks to optimal tool |
| Human review gate | Yes — diff view, comment | Yes — review before merge | Yes — diff view | Yes — required before commit |
| Context persistence | No explicit memory (relies on thread history) | Yes — Living Spec, Context Engine | Yes — codebase index | Yes — shared context file across all tools |
| Native macOS app | Yes | Yes (Electron-based) | No — VS Code extension | Yes — Tauri v2, native feel |
| Open tool ecosystem | No — closed to Codex | Partial — pluggable agent providers | No — closed | Yes — open adapter interface |

---

## Sources

- OpenAI Codex App announcement and feature docs: https://openai.com/index/introducing-the-codex-app/ and https://developers.openai.com/codex/app/
- Augment Intent blog and docs: https://www.augmentcode.com/blog/intent-a-workspace-for-agent-orchestration and https://docs.augmentcode.com/intent/overview
- AI Coding Agents in 2026 — Mike Mason (coherence patterns, what fails): https://mikemason.ca/writing/ai-coding-agents-jan-2026/
- Windsurf Cascade / Flow Awareness: https://www.secondtalent.com/resources/windsurf-review/
- Multi-agent orchestration patterns and anti-patterns: https://www.codebridge.tech/articles/mastering-multi-agent-orchestration-coordination-is-the-new-scale-frontier
- Clash — worktree conflict detection tool: https://github.com/clash-sh/clash
- Claude Code memory system: https://code.claude.com/docs/en/memory
- AI merge conflict resolution: https://www.graphite.com/guides/ai-code-merge-conflict-resolution
- Addy Osmani on future of agentic coding: https://addyosmani.com/blog/future-agentic-coding/
- Codified Context paper (context engineering for agents): https://arxiv.org/html/2602.20478v1
- AI model strengths for orchestration: https://machine-learning-made-simple.medium.com/gpt-vs-claude-vs-gemini-for-agent-orchestration-b3fbc584f0f7

---

*Feature research for: AI coding tool orchestration desktop app (WhaleCode)*
*Researched: 2026-03-05*
