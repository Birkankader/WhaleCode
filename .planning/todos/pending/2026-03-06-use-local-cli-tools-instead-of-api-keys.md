---
created: 2026-03-06T19:55:07.851Z
title: Use local CLI tools instead of API keys
area: general
files:
  - src/
---

## Problem

WhaleCode's core purpose is to orchestrate CLI-based coding agents (Claude Code, Gemini CLI, Codex CLI) on a shared project. Currently the app may require API keys, but since these tools are already installed locally on the user's Mac, API keys should be optional. The app should work directly with locally installed CLI tools.

## Solution

Rethink the core workflow to be CLI-first:

1. **Project selection** - User opens app, selects project path
2. **Agent selection** - User picks which CLI agents to use (Claude Code, Gemini CLI, Codex CLI)
3. **Sub-agent count** (optional) - User configures how many sub-agents each tool spawns
4. **Prompt input** - User enters the prompt
5. **Master agent orchestration** - The selected master agent receives the prompt and distributes tasks to sub-agents
6. **Result display** - Show each agent's responses and completed work
7. **Context tracking** - Display remaining context, used context, and other token metrics

API key input should be made optional since the CLI tools handle their own authentication.
