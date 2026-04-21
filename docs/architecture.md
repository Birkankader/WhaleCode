# Architecture

Detailed rationale behind the 7 architectural decisions. Read this when:
- Implementing orchestration logic
- Deciding how a feature should work
- Reviewing PRs against the product philosophy

## 1. Master agent selection

**Decision:** User-selectable with smart default via fallback chain.

**Fallback order:** Claude Code → Codex CLI → Gemini CLI. First installed agent becomes default master.

**Implementation:**
- On first launch, detect installed agents by checking `PATH` and common config locations.
- If none installed, show onboarding with install instructions + links.
- User preference persists in SQLite (`settings` table, key `master_agent`).
- If selected master is unavailable at runtime (API error, missing key), auto-fallback and notify user.
- Each agent gets a **custom master system prompt addon**. Claude, Gemini, and Codex respond to different prompting styles. Keep these prompts in `src-tauri/src/agents/prompts/master_{agent}.md`.

**Why not hardcoded:** Vendor lock-in violates "local-first, user in control" philosophy. User may have paid for one provider and not others.

**Why not task-based routing:** Overengineering for v2. Without telemetry we'd guess which agent is "best" for what. v3 decision.

## 2. Worker communication

**Decision:** Master-centric coordination + shared notes file.

**Model:** Workers cannot call each other directly. All coordination flows through master. Shared knowledge lives in `.whalecode/notes.md` inside the target repo.

**How shared notes work:**
- Created at task start, cleared at task end (not persisted across runs).
- Master writes initial entries: project structure, API contracts, design decisions.
- Each worker reads current notes as part of its context before starting.
- Workers append their completion summaries (append-only — no race conditions).
- Master periodically consolidates (token economy — notes can grow).
- Not in SQLite. Lives on filesystem. Simpler, inspectable by user.

**Why not peer-to-peer mesh (AutoGen/CrewAI style):**
- Debugging becomes impossible. When something goes wrong in a mesh, you can't trace cause.
- Infinite loop risk (A asks B, B asks A).
- Cost unpredictability — worker A's curiosity can blow the budget.
- Our users are solo developers, not framework authors. They want predictable outcomes.

**Why not sequential handoffs:**
- Loses parallelism, which is one of WhaleCode's core advantages.

**The Conway's law framing:** A junior dev team is more productive when led by a tech lead who coordinates through shared docs than when each dev DMs every other dev.

## 3. Fail handling

**Decision:** Progressive three-layer recovery.

**Layer 1 — Worker retry (max 1 attempt):**
- Failed worker gets error message appended to its context: "Previous attempt failed with: [error]".
- Retries once.
- Node visual: amber pulse with "retrying..." label.
- Purpose: Catches transient failures (network, race conditions, small mistakes).

**Layer 2 — Master re-plan (max 2 attempts):**
- If retry also fails, escalate to master.
- Master receives: original task + failed subtask + error history + what other workers completed.
- Master decides: reassign to different worker, split further, or mark as skip-worthy.
- New plan goes through approval (unless auto-approve is on).
- Node visual: original subtask strikethrough, new subtasks branch from master.
- Loop protection: Master cannot re-plan the same subtask more than 2 times total.

**Layer 3 — Human escalation:**
- If re-plan also fails, show user the raw error.
- Three options: [Manual fix] [Skip subtask] [Abort run].
- Error UI: short summary + expandable raw log.

**Master-level failures are special:**
- If master itself fails (rare), go directly to user. Do NOT retry master.
- Reason: A failing planner cannot fix a planning failure.

**Categorize failures for future analytics:**
- `api_error`, `test_fail`, `compile_error`, `permission_error`, `timeout`, `unknown`.
- Stored in SQLite `subtask_failures` table.

## 4. Repo support

**Decision:** Single repo + mono-repo awareness. Multi-repo is out of scope for v2.

**Mono-repo detection signals (check in this order):**
1. `pnpm-workspace.yaml`
2. `turbo.json`
3. `nx.json`
4. `rush.json`
5. `package.json` with `workspaces` field
6. `go.work`
7. `Cargo.toml` with `[workspace]`
8. `pyproject.toml` with workspace config

**When mono-repo detected:**
- Show indicator in top bar: `Mono-repo · N packages`.
- Scan package structure (names, paths, dependencies between packages).
- Inject package structure into master's system prompt automatically.
- Subtask nodes display a package chip (e.g., `apps/web`, `packages/shared`).

**Workers in mono-repo:**
- `cwd` is always repo root (for cross-package imports to resolve).
- Edit scope is enforced via prompt: "Primarily edit files in package X, but you may read from others."
- Git worktrees are repo-level, not package-level.
- Master considers inter-package dependencies when ordering subtasks.

**Why defer multi-repo:**
- 95% of developers work in single or mono setups.
- Multi-repo requires workspace abstraction, multiple worktrees, cross-repo coordination logic.
- v3 will introduce a "workspace" concept that naturally unifies all three.

## 5. Cost tracking

**Decision:** Summary-at-end default, optional live counter.

**Default behavior (what everyone sees):**
- Live UI stays clean. No cost during run.
- End-of-run footer: `Done in 2m 14s · 45k tokens · ~$0.32 · 4 subtasks`.
- The `~` symbol is important: we cannot guarantee exact cost (pricing changes). It signals approximation.
- Show cost on failed runs too: "Failed after $0.18".

**Opt-in live counter:**
- Settings toggle: "Show live cost counter".
- Top-right corner displays: `$0.12 · 18k tokens` during run.
- Hover any node to see its individual cost.
- Cmd+K → "Show cost breakdown" opens detailed per-subtask view.

**Implementation:**
- Each provider needs its own tokenizer (tiktoken for Claude/OpenAI, Gemini's own).
- Pricing config in `src-tauri/src/tokenizer/pricing.yaml` (editable, prices change).
- Always show dollar + tokens together. Dollar alone is misleading (providers differ).
- Always muted text color. Never alarm-red. Cost is not "bad".
- Free-tier usage ($0.00) is fine to show — it's a positive signal.

**Budget warnings (v2.1):**
- Settings: "Warn at $X per run".
- At 80% of budget: subtle warning.
- At 100%: master pauses, asks user to continue.
- In v2.0, warn only. In v2.1, enforce.

## 6. Team collaboration

**Decision:** Solo-only in v2 with config export/import. Full team features in v3.

**What v2 ships:**
- `.whalecode/config.yaml` — agent preferences, master selection, budget defaults.
- `.whalecode/templates/*.yaml` — named task templates (see example below).
- These files are committed to the target repo. Git IS the sync mechanism.
- Runtime state (runs, logs, cached context) goes in `.gitignore`.
- Cmd+K → "Apply template" lets user select a template before submitting.
- "Share this template" button copies YAML to clipboard.
- If CLAUDE.md, AGENTS.md, or GEMINI.md exist in the repo, their content is injected into master's system context automatically.

**Template format:**
```yaml
name: backend-task
description: API endpoint or database changes
master:
  agent: claude-code
  system_prompt_addon: |
    Focus on Go idioms. Always add table-driven tests.
    Prefer standard library over dependencies.
workers:
  preferred: [claude-code, codex]
  fallback: [gemini]
budget:
  max_usd: 3.00
```

**What v3 will add:**
- Cloud backend: auth, workspaces, billing.
- Real-time sync across team members.
- Template marketplace (community sharing).
- Usage dashboards for admins.

**Why defer:**
- Cloud backend is massive scope (auth, scaling, maintenance, billing infra).
- Solo experience must be proven first. Feedback shapes team features.
- Config-as-code pattern (Terraform, Kubernetes, devcontainer) handles ~50% of team needs already.
- At launch, collect emails via waitlist: "Team features coming in v3".

## 7. Headless / VPS strategy

**Decision:** Auto-approve mode in v2.0, dedicated server in v2.5.

**v2.0 — Auto-approve mode:**

- Settings toggle: "Auto-approve subtasks" (off by default).
- First activation shows warning modal: *"Master will execute plans without asking. You remain responsible for all changes. Continue?"*
- UI indicator when on: amber dot + "Auto" in top bar.
- Enables overnight runs on a MacBook (laptop open, caffeinate active).

**Safety gates (auto-approve CANNOT bypass these):**
- Destructive git: `push --force`, `reset --hard`, `branch -D`, `clean -fd`.
- Filesystem: writes/reads to `.env`, direct edits to `.git/`, deletions outside home directory.
- Network: sending credentials (tokens, API keys) to external endpoints.
- Budget: operations that would exceed configured budget cap.
- System: `sudo`, `chmod`, `chown`, package manager global operations.

These always prompt the user, regardless of auto-approve state.

**Background mode (macOS):**
- Settings: "Run in background" — hides from dock, menu bar icon shows status.
- Optional `caffeinate -dims` integration to prevent sleep.
- Native notifications: "Task completed", "Task needs attention", "Budget exceeded".

**v2.5 — WhaleCode Server:**

Separate binary (`whalecode-server`), distributed as:
- Rust binary (single file).
- Docker image (for Hetzner/DigitalOcean/Railway deploys).

Features:
- SSH key-based auth (v3 adds OAuth).
- Desktop app gains "Remote" toggle: connect to local or remote server.
- Mobile-friendly web UI: read-only status + approve buttons.
- Push notifications via ntfy.sh or Telegram bot.

**Why split across versions:**
- v2.0 can ship in ~10 weeks if scope stays focused.
- Full headless architecture is a separate refactor (backend/frontend decoupling, auth, network layer).
- v2.5 creates a second product launch moment — good for marketing momentum.
- Covers 90% of real-world "overnight run" use cases with auto-approve already.

## The unified philosophy

All seven decisions share a consistent character:

- **Simple default, deep configurability** (progressive disclosure at every layer)
- **Opinionated but overridable** (smart defaults + settings)
- **Local-first, cloud-optional** (privacy and control stay with user)
- **Solo excellence before team** (prove value at smallest unit)
- **Transparent but not overwhelming** (show what matters, hide what doesn't)
- **Automated with human checkpoints** (AI does the work, user owns decisions)

When a new feature is proposed, check it against these six. If it contradicts any, either reshape it or reject it.
