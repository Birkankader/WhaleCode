# S02 — Worktree Isolation & Parallel Workers — Research

**Date:** 2026-03-23
**Requirements:** R003 (worktree isolation), R004 (parallel same-agent workers), R011 (rate limit retry + fallback)

## Summary

The worktree subsystem is fully implemented and well-tested (22 tests pass). What's missing is the wiring — the orchestrator dispatch loop never creates worktrees and passes project_dir as the cwd for every worker. Similarly, acquire_tool_slot() blocks on tool_name (agent name), so two Claude workers can never run concurrently.

## Recommendation

Wire existing worktree infra into orchestrator dispatch; refactor tool slots from per-agent-name to per-task-id. Build order: tool slot refactor first, then worktree creation + cwd wiring, then event enrichment.

## Key Changes

1. Tool slot refactor: acquire_tool_slot/release_tool_slot → task-id based tracking
2. Worktree creation in dispatch loop: create_for_task before each dispatch_task call
3. Event enrichment: worktree_created events, worktree metadata in worker_started/task_completed
4. Parallel dispatch within waves (stretch goal)