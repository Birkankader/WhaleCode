import type { StoreApi, UseBoundStore } from 'zustand';

import type { AgentKind, GraphState } from '../state/graphStore';
import { MASTER_ID } from '../state/graphStore';
import type { NodeState } from '../state/nodeMachine';

type GraphStore = UseBoundStore<StoreApi<GraphState>>;

export type OrchestrationHandle = {
  /** Abort the run: clears pending timers + subscriptions. Safe to call twice. */
  cancel: () => void;
  /** Resolves when the full scripted demo completes, or when cancelled. */
  done: Promise<void>;
};

const CANCELLED = Symbol('mock-orchestration-cancelled');

/**
 * Runs the scripted Phase 1 demo end-to-end against the store. Pure state
 * mutations — no React, no IPC. Phase 2's real orchestrator will have the
 * same shape, with actual agent output driving the transitions.
 *
 * Timing marks follow phase-1-spec so the approval moments land where demos
 * need them. Tests drive this with `vi.useFakeTimers()`; production uses
 * real setTimeout.
 */
export function runMockOrchestration(_taskInput: string, store: GraphStore): OrchestrationHandle {
  let cancelled = false;
  const timeouts = new Set<ReturnType<typeof setTimeout>>();
  const unsubscribes = new Set<() => void>();
  // Every in-flight await registers its reject here so cancel() can flush the
  // whole chain in one pass — otherwise cleared setTimeout handles would leave
  // the orchestrator's main promise hanging forever.
  const pendingRejects = new Set<(reason: unknown) => void>();

  function schedule(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (cancelled) {
        reject(CANCELLED);
        return;
      }
      pendingRejects.add(reject);
      const t = setTimeout(() => {
        timeouts.delete(t);
        pendingRejects.delete(reject);
        if (cancelled) {
          reject(CANCELLED);
          return;
        }
        resolve();
      }, ms);
      timeouts.add(t);
    });
  }

  function awaitApproval(): Promise<void> {
    return new Promise((resolve, reject) => {
      const verdict = (status: GraphState['status']): 'ok' | 'rejected' | null => {
        if (status === 'running') return 'ok';
        if (status === 'idle' || status === 'applied') return 'rejected';
        return null;
      };
      if (cancelled) {
        reject(CANCELLED);
        return;
      }
      const initial = verdict(store.getState().status);
      if (initial === 'ok') {
        resolve();
        return;
      }
      if (initial === 'rejected') {
        reject(CANCELLED);
        return;
      }
      pendingRejects.add(reject);
      const unsub = store.subscribe((state) => {
        if (cancelled) {
          unsub();
          pendingRejects.delete(reject);
          reject(CANCELLED);
          return;
        }
        const v = verdict(state.status);
        if (v === 'ok') {
          unsub();
          pendingRejects.delete(reject);
          resolve();
        } else if (v === 'rejected') {
          unsub();
          pendingRejects.delete(reject);
          reject(CANCELLED);
        }
      });
      unsubscribes.add(unsub);
    });
  }

  function awaitNodeState(id: string, target: NodeState): Promise<void> {
    return new Promise((resolve, reject) => {
      if (cancelled) {
        reject(CANCELLED);
        return;
      }
      if (store.getState().nodeSnapshots.get(id)?.value === target) {
        resolve();
        return;
      }
      pendingRejects.add(reject);
      const unsub = store.subscribe((state) => {
        if (cancelled) {
          unsub();
          pendingRejects.delete(reject);
          reject(CANCELLED);
          return;
        }
        if (state.nodeSnapshots.get(id)?.value === target) {
          unsub();
          pendingRejects.delete(reject);
          resolve();
        }
      });
      unsubscribes.add(unsub);
    });
  }

  async function streamLogs(id: string, lines: readonly string[], perLineMs: number) {
    for (const line of lines) {
      if (cancelled) throw CANCELLED;
      store.getState().appendLogToNode(id, line);
      await schedule(perLineMs);
    }
  }

  async function runHappySubtask(id: string, durationMs: number, logs: readonly string[]) {
    store.getState().updateSubtaskState(id, { type: 'START' });
    await streamLogs(id, logs, durationMs / Math.max(logs.length, 1));
    store.getState().updateSubtaskState(id, { type: 'COMPLETE' });
  }

  async function runRetrySubtask(
    id: string,
    firstMs: number,
    retryMs: number,
    firstLogs: readonly string[],
    retryLogs: readonly string[],
  ) {
    store.getState().updateSubtaskState(id, { type: 'START' });
    await streamLogs(id, firstLogs, firstMs / Math.max(firstLogs.length, 1));
    store.getState().updateSubtaskState(id, { type: 'FAIL' }); // running → retrying
    await streamLogs(id, retryLogs, retryMs / Math.max(retryLogs.length, 1));
    store.getState().updateSubtaskState(id, { type: 'RETRY_SUCCESS' });
    store.getState().updateSubtaskState(id, { type: 'COMPLETE' });
  }

  async function runDoubleFailSubtask(
    id: string,
    firstMs: number,
    retryMs: number,
    firstLogs: readonly string[],
    retryLogs: readonly string[],
  ) {
    store.getState().updateSubtaskState(id, { type: 'START' });
    await streamLogs(id, firstLogs, firstMs / Math.max(firstLogs.length, 1));
    store.getState().updateSubtaskState(id, { type: 'FAIL' }); // running → retrying
    await streamLogs(id, retryLogs, retryMs / Math.max(retryLogs.length, 1));
    store.getState().updateSubtaskState(id, { type: 'FAIL' }); // retrying → failed
    store.getState().updateSubtaskState(id, { type: 'ESCALATE' }); // failed → escalating
  }

  async function runDependentHappy(
    id: string,
    dependsOn: string,
    durationMs: number,
    logs: readonly string[],
  ) {
    if (store.getState().nodeSnapshots.get(dependsOn)?.value !== 'done') {
      store.getState().updateSubtaskState(id, { type: 'BLOCK' });
      await awaitNodeState(dependsOn, 'done');
      store.getState().updateSubtaskState(id, { type: 'UNBLOCK' });
    }
    await runHappySubtask(id, durationMs, logs);
  }

  // Dispatch IIFEs are consumed by Promise.all below, but cancel() can reject
  // them before Promise.all attaches. Swallow here so the CANCELLED rejection
  // doesn't surface as an unhandled-rejection — Promise.all still sees it via
  // the original promise handles.
  const swallowCancel = (p: Promise<void>) => {
    p.catch((err) => {
      if (err !== CANCELLED) throw err;
    });
    return p;
  };

  const done = (async () => {
    try {
      // ─── Planning phase: master streams logs, then proposes 4 subtasks. ───
      await schedule(2000);
      await streamLogs(MASTER_ID, PLANNING_LOGS, 800);
      // Total so far: 2000 + 4 × 800 = 5200 ms. Pad to 6000.
      await schedule(800);

      store.getState().proposeSubtasks(INITIAL_SUBTASKS);

      // ─── Approval gate 1. ───
      await awaitApproval();

      // ─── Dispatch: staggered starts, one dep-aware. ───
      const authRun = swallowCancel(
        (async () => {
          await schedule(500);
          await runHappySubtask('auth', 2000, LOGS.auth);
        })(),
      );

      const toggleRun = swallowCancel(
        (async () => {
          await schedule(1000);
          await runRetrySubtask('toggle-ui', 2000, 1500, LOGS.toggleUiFirst, LOGS.toggleUiRetry);
        })(),
      );

      const wireRun = swallowCancel(
        (async () => {
          await schedule(1500);
          await runDoubleFailSubtask(
            'wire-toggle',
            2000,
            1500,
            LOGS.wireToggleFirst,
            LOGS.wireToggleRetry,
          );
        })(),
      );

      const testsRun = swallowCancel(
        (async () => {
          await schedule(2000);
          await runDependentHappy('tests', 'auth', 2000, LOGS.tests);
        })(),
      );

      // ─── Layer 2 re-plan: wait for wire-toggle to escalate. ───
      await awaitNodeState('wire-toggle', 'escalating');

      // Master re-enters thinking; stream 1500 ms of replan logs.
      store.getState().updateSubtaskState(MASTER_ID, { type: 'THINK' });
      await streamLogs(MASTER_ID, REPLAN_LOGS, 1500 / REPLAN_LOGS.length);

      store.getState().proposeReplacementSubtasks(REPLACEMENT_SUBTASKS);

      // ─── Approval gate 2. ───
      await awaitApproval();

      const replacementRun = swallowCancel(
        (async () => {
          await schedule(500);
          await runHappySubtask('retheme', 2000, LOGS.retheme);
        })(),
      );

      await Promise.all([authRun, toggleRun, wireRun, testsRun, replacementRun]);

      // ─── Final node: populate diff, drive idle → running → done. ───
      store.getState().setFinalFiles(FINAL_FILES);
      store.getState().updateSubtaskState('final', { type: 'PROPOSE' });
      store.getState().updateSubtaskState('final', { type: 'APPROVE' });
      store.getState().updateSubtaskState('final', { type: 'START' });
      await schedule(600);
      store.getState().updateSubtaskState('final', { type: 'COMPLETE' });
      store.getState().completeRun();
    } catch (err) {
      if (err !== CANCELLED) throw err;
    }
  })();

  function cancel() {
    if (cancelled) return;
    cancelled = true;
    for (const t of timeouts) clearTimeout(t);
    timeouts.clear();
    for (const u of unsubscribes) u();
    unsubscribes.clear();
    for (const r of pendingRejects) r(CANCELLED);
    pendingRejects.clear();
  }

  return { cancel, done };
}

// ─── Mock content ───────────────────────────────────────────────────────────

type SubtaskDef = {
  id: string;
  title: string;
  agent: AgentKind;
  dependsOn: string[];
};

const INITIAL_SUBTASKS: readonly SubtaskDef[] = [
  { id: 'auth', title: 'Settings page scaffold', agent: 'claude', dependsOn: [] },
  { id: 'toggle-ui', title: 'Dark-mode toggle UI', agent: 'gemini', dependsOn: [] },
  { id: 'wire-toggle', title: 'Wire toggle to theme store', agent: 'codex', dependsOn: [] },
  { id: 'tests', title: 'Integration tests for settings', agent: 'claude', dependsOn: ['auth'] },
];

const REPLACEMENT_SUBTASKS: readonly SubtaskDef[] = [
  { id: 'retheme', title: 'Rebuild toggle via theme hook', agent: 'gemini', dependsOn: [] },
];

const PLANNING_LOGS = [
  '→ Reading project structure...',
  '→ Detected mono-repo (4 packages)...',
  '→ Identifying settings page components...',
  '✓ Planning subtasks...',
] as const;

const REPLAN_LOGS = [
  '→ Reviewing failure on wire-toggle...',
  '⚠ Theme dispatch contract changed — adjusting plan...',
  '✓ Drafting replacement subtask...',
] as const;

const LOGS = {
  auth: [
    '→ Creating src/pages/Settings.tsx...',
    '→ Wiring route in App.tsx...',
    '✓ Adding session guard...',
  ],
  toggleUiFirst: [
    '→ Reading existing theme components...',
    '→ Drafting DarkModeToggle.tsx...',
    '⚠ Type mismatch on useTheme() — aborting.',
  ],
  toggleUiRetry: [
    '→ Regenerating component against theme typings...',
    '✓ Rendering toggle in Settings page...',
  ],
  wireToggleFirst: [
    '→ Reading theme store interface...',
    '→ Attempting dispatch wiring...',
    '✗ Runtime error: setTheme is not a function.',
  ],
  wireToggleRetry: ['→ Patching import path...', '✗ Retrying dispatch — still failing.'],
  tests: [
    '→ Scaffolding settings.spec.tsx...',
    '→ Rendering Settings with MemoryRouter...',
    '✓ Asserting toggle persists theme...',
  ],
  retheme: [
    '→ Adopting useTheme() hook contract...',
    '→ Wiring toggle through hook instead of store...',
    '✓ Verifying persistence layer...',
  ],
} as const;

const FINAL_FILES: readonly string[] = [
  'src/pages/Settings.tsx',
  'src/components/DarkModeToggle.tsx',
  'src/lib/theme.ts',
  'src/App.tsx',
  'src/index.css',
  'tests/settings.spec.tsx',
];
