import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FINAL_ID, MASTER_ID, useGraphStore } from '../state/graphStore';
import { runMockOrchestration } from './mockOrchestration';

function snap(id: string) {
  return useGraphStore.getState().nodeSnapshots.get(id)?.value;
}

describe('runMockOrchestration — integration', () => {
  beforeEach(() => {
    useGraphStore.getState().reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Reset BEFORE restoring real timers so any pending scheduled callbacks
    // the orchestrator registered are cancelled while fake timers still own
    // the queue.
    useGraphStore.getState().reset();
    vi.useRealTimers();
  });

  it('plays the full demo: planning → approval → subtasks (with retry + escalate) → replan → final done', async () => {
    useGraphStore.getState().submitTask('Scaffold settings page with dark mode');
    const orch = runMockOrchestration('Scaffold settings page with dark mode', useGraphStore);

    // Planning takes 6000 ms; advance past it.
    await vi.advanceTimersByTimeAsync(6500);

    const gate1 = useGraphStore.getState();
    expect(gate1.status).toBe('awaiting_approval');
    expect(gate1.subtasks).toHaveLength(4);
    expect(snap(MASTER_ID)).toBe('proposed');
    expect((gate1.nodeLogs.get(MASTER_ID) ?? []).length).toBeGreaterThanOrEqual(4);

    // Approve all four.
    useGraphStore.getState().approveSubtasks(useGraphStore.getState().subtasks.map((s) => s.id));

    // Subtask execution + escalate + replan land around +6500 ms.
    await vi.advanceTimersByTimeAsync(7000);

    const gate2 = useGraphStore.getState();
    expect(gate2.status).toBe('awaiting_approval');
    expect(gate2.subtasks).toHaveLength(5);
    expect(gate2.subtasks[4].id).toBe('retheme');
    expect(snap('auth')).toBe('done');
    expect(snap('toggle-ui')).toBe('done');
    expect(snap('wire-toggle')).toBe('escalating');
    expect(snap('tests')).toBe('done');
    expect(snap('retheme')).toBe('proposed');
    expect(snap(MASTER_ID)).toBe('proposed');
    // Retry was exercised on toggle-ui.
    expect(gate2.nodeSnapshots.get('toggle-ui')?.retries).toBe(1);
    expect(gate2.nodeSnapshots.get('wire-toggle')?.retries).toBe(1);
    // Only the replacement is selected by default after replan.
    expect(gate2.selectedSubtaskIds).toEqual(new Set(['retheme']));

    // Approve the replacement.
    useGraphStore.getState().approveSubtasks(useGraphStore.getState().subtasks.map((s) => s.id));

    // Replacement (~2500 ms) + final activation (600 ms).
    await vi.advanceTimersByTimeAsync(4000);
    await orch.done;

    const final = useGraphStore.getState();
    expect(final.status).toBe('done');
    expect(snap('retheme')).toBe('done');
    expect(snap(FINAL_ID)).toBe('done');
    expect(final.finalNode?.files).toEqual([
      'src/pages/Settings.tsx',
      'src/components/DarkModeToggle.tsx',
      'src/lib/theme.ts',
      'src/App.tsx',
      'src/index.css',
      'tests/settings.spec.tsx',
    ]);
    // wire-toggle stays strikethrough (escalating, not advanced past).
    expect(snap('wire-toggle')).toBe('escalating');
    // Every non-escalating subtask ends up done.
    expect(snap('auth')).toBe('done');
    expect(snap('toggle-ui')).toBe('done');
    expect(snap('tests')).toBe('done');
    // Master concluded the run in approved — no further actions pending.
    expect(snap(MASTER_ID)).toBe('approved');
  });

  it('cancel() aborts the run: no further store transitions after cancel', async () => {
    useGraphStore.getState().submitTask('x');
    const orch = runMockOrchestration('x', useGraphStore);

    await vi.advanceTimersByTimeAsync(3000);
    orch.cancel();
    // Advance well past when subtasks would have been proposed.
    await vi.advanceTimersByTimeAsync(15000);
    await orch.done;

    const s = useGraphStore.getState();
    // Master streamed some logs but never proposed subtasks.
    expect(s.status).toBe('planning');
    expect(s.subtasks).toHaveLength(0);
    expect(snap(MASTER_ID)).toBe('thinking');
  });

  it('store.reset() triggers the registered orchestration cancel handle', async () => {
    useGraphStore.getState().submitTask('x');
    const orch = runMockOrchestration('x', useGraphStore);
    useGraphStore.getState().setOrchestrationCancel(orch.cancel);

    await vi.advanceTimersByTimeAsync(3000);
    useGraphStore.getState().reset();
    await vi.advanceTimersByTimeAsync(15000);
    await orch.done;

    // reset wipes everything; nothing should resurrect.
    const s = useGraphStore.getState();
    expect(s.status).toBe('idle');
    expect(s.masterNode).toBeNull();
    expect(s.subtasks).toHaveLength(0);
  });
});
