/**
 * Event-sourced graph store.
 *
 * Phase 2 rewrite: the store is a pure mirror of backend `run:*` events.
 * Actions invoke IPC commands and return. Every visible state change flows
 * through a handler that the active `RunSubscription` routes events to.
 *
 * Lifecycle:
 *   submitTask → IPC submit_task → attach RunSubscription → backend emits →
 *   handlers drive actors / status / logs → terminal event auto-detaches.
 *
 * Action surface (applyRun / discardRun / cancelRun / rejectAll) only wraps
 * IPC — it does not mutate store state. All state mutations live in the
 * handler methods. This keeps the frontend/backend contract one-directional
 * and removes the class of bugs where optimistic updates diverge from
 * backend reality.
 *
 * Backend vs. frontend nomenclature:
 *   backend RunStatus uses kebab-case ('awaiting-approval'), frontend uses
 *   underscore ('awaiting_approval'). Mapped at `mapRunStatus`. Phase 3
 *   should consider unifying these when it extends RunStatus for the real
 *   retry ladder; don't unify now.
 *
 * Attach timing:
 *   backend's `submit_task` has an INVARIANT (see `orchestration/lifecycle.rs`)
 *   that it yields before emitting the first event. That yield is what lets
 *   us attach AFTER the IPC call returns without dropping events. Don't
 *   reorder this without re-checking that contract.
 */

import { createActor, type ActorRefFrom } from 'xstate';
import { create } from 'zustand';

import {
  applyRun as applyRunIpc,
  approveSubtasks as approveSubtasksIpc,
  cancelRun as cancelRunIpc,
  discardRun as discardRunIpc,
  rejectRun as rejectRunIpc,
  submitTask as submitTaskIpc,
  type AgentKind as BackendAgentKind,
  type BaseBranchDirty,
  type Completed,
  type DiffReady,
  type Failed,
  type MasterLog,
  type MergeConflict,
  type RunStatus,
  type StatusChanged,
  type SubtaskLog,
  type SubtaskState,
  type SubtaskStateChanged,
  type SubtasksProposed,
} from '../lib/ipc';
import { RunSubscription, defaultOnParseError } from '../lib/runSubscription';
import { nodeMachine, type NodeEvent, type NodeEventType, type NodeState } from './nodeMachine';
import { useRepoStore } from './repoStore';

/**
 * Frontend agent token. `'master'` is a display-only marker that selects the
 * amber master color; the underlying CLI is `selectedMasterAgent`.
 */
export type AgentKind = BackendAgentKind | 'master';

export type MasterNodeData = {
  id: 'master';
  agent: AgentKind;
  label: string;
};

export type SubtaskNodeData = {
  id: string;
  title: string;
  agent: BackendAgentKind;
  dependsOn: string[];
};

export type FinalNodeData = {
  id: 'final';
  label: string;
  files: string[];
  /**
   * Populated by `handleMergeConflict`. Null means "no conflict" (distinct
   * from `[]`, which would be meaningless). Cleared on: fresh `submitTask`,
   * `reset`, or a successful `Completed` event. Not cleared on subsequent
   * `MergeConflict` events — latest wins. Commit 3 will render a conflict
   * variant from this field.
   */
  conflictFiles: string[] | null;
};

export type NodeSnapshot = {
  value: NodeState;
  retries: number;
};

export type GraphStatus =
  | 'idle'
  | 'planning'
  | 'awaiting_approval'
  | 'running'
  | 'merging'
  | 'done'
  | 'applied'
  | 'rejected'
  | 'failed';

type NodeActorRef = ActorRefFrom<typeof nodeMachine>;

export type GraphState = {
  runId: string | null;
  taskInput: string;
  masterNode: MasterNodeData | null;
  subtasks: SubtaskNodeData[];
  finalNode: FinalNodeData | null;
  status: GraphStatus;
  selectedMasterAgent: BackendAgentKind;
  selectedSubtaskIds: Set<string>;
  nodeActors: Map<string, NodeActorRef>;
  nodeSnapshots: Map<string, NodeSnapshot>;
  nodeLogs: Map<string, string[]>;
  /** Live subscription to the active run's events. Null between runs. */
  activeSubscription: RunSubscription | null;
  /** Last surfaced error (IPC failure or backend `Failed` event). */
  currentError: string | null;

  setMasterAgent: (agent: BackendAgentKind) => void;
  submitTask: (input: string, masterAgent?: BackendAgentKind) => Promise<void>;
  toggleSubtaskSelection: (id: string) => void;
  selectAll: () => void;
  selectNone: () => void;
  approveSubtasks: (ids: string[]) => Promise<void>;
  rejectAll: () => Promise<void>;
  applyRun: () => Promise<void>;
  discardRun: () => Promise<void>;
  cancelRun: () => Promise<void>;
  dismissError: () => void;
  reset: () => void;
};

export const MASTER_ID = 'master' as const;
export const FINAL_ID = 'final' as const;

const initial: Pick<
  GraphState,
  | 'runId'
  | 'taskInput'
  | 'masterNode'
  | 'subtasks'
  | 'finalNode'
  | 'status'
  | 'selectedMasterAgent'
  | 'selectedSubtaskIds'
  | 'nodeActors'
  | 'nodeSnapshots'
  | 'nodeLogs'
  | 'activeSubscription'
  | 'currentError'
> = {
  runId: null,
  taskInput: '',
  masterNode: null,
  subtasks: [],
  finalNode: null,
  status: 'idle',
  selectedMasterAgent: 'claude',
  selectedSubtaskIds: new Set(),
  nodeActors: new Map(),
  nodeSnapshots: new Map(),
  nodeLogs: new Map(),
  activeSubscription: null,
  currentError: null,
};

function mapRunStatus(s: RunStatus): GraphStatus {
  // Kebab-case backend → underscore frontend. See file-top comment — Phase 3
  // should consider unifying these when it extends RunStatus.
  switch (s) {
    case 'idle':
      return 'idle';
    case 'planning':
      return 'planning';
    case 'awaiting-approval':
      return 'awaiting_approval';
    case 'running':
      return 'running';
    case 'merging':
      return 'merging';
    case 'done':
      return 'done';
    case 'rejected':
      return 'rejected';
    case 'failed':
      return 'failed';
  }
}

/**
 * Translate a backend-reported SubtaskState into the NodeEvent(s) the local
 * machine needs to land in the matching state. Uses the current snapshot to
 * disambiguate transitions that have multiple reachable paths.
 */
function eventsForSubtaskState(
  target: SubtaskState,
  current: NodeState | undefined,
): NodeEventType[] {
  switch (target) {
    case 'proposed':
      // Normally covered by SubtasksProposed spawning the actor; this is
      // the redundant signal. No-op unless actor somehow skipped PROPOSE.
      return current === undefined || current === 'idle' ? ['PROPOSE'] : [];
    case 'waiting':
      // Backend may jump proposed→waiting if a subtask is approved but its
      // dependency is still pending. Bridge via APPROVE → BLOCK.
      if (current === 'proposed') return ['APPROVE', 'BLOCK'];
      if (current === 'approved') return ['BLOCK'];
      return [];
    case 'running':
      // Backend's subtask_state_changed for an approved subtask jumps
      // straight to 'running' — the machine's `approved` state is a
      // frontend-only waypoint the backend doesn't model. Bridge it here
      // so the actor lands where backend expects.
      if (current === 'proposed') return ['APPROVE', 'START'];
      if (current === 'waiting') return ['UNBLOCK', 'START'];
      if (current === 'approved') return ['START'];
      return [];
    case 'done':
      // Bridge the same approved-waypoint gap if backend jumps
      // proposed/waiting/approved → done (e.g. a no-op subtask).
      if (current === 'proposed') return ['APPROVE', 'START', 'COMPLETE'];
      if (current === 'waiting') return ['UNBLOCK', 'START', 'COMPLETE'];
      if (current === 'approved') return ['START', 'COMPLETE'];
      return ['COMPLETE'];
    case 'failed':
      // MAX_RETRIES = 0 so `running --FAIL→ failed` directly. Bridge from
      // non-running states too (backend may emit failed on a never-started
      // subtask, e.g. master re-plan invalidation).
      if (current === 'proposed') return ['APPROVE', 'START', 'FAIL'];
      if (current === 'waiting') return ['UNBLOCK', 'START', 'FAIL'];
      if (current === 'approved') return ['START', 'FAIL'];
      return ['FAIL'];
    case 'skipped':
      // SKIP is only defined from `proposed` and `human_escalation` in the
      // machine. From other states (approved mid-cancel, etc.) we leave
      // the actor where it is — the terminal run status already conveys
      // "run ended" visually via the muted graph.
      return ['SKIP'];
  }
}

function newLocalRunId(): string {
  return `pending_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const useGraphStore = create<GraphState>((set, get) => {
  function spawnActor(id: string): NodeActorRef {
    const actor = createActor(nodeMachine);
    actor.subscribe((snap) => {
      set((state) => {
        const nextSnaps = new Map(state.nodeSnapshots);
        nextSnaps.set(id, {
          value: snap.value as NodeState,
          retries: snap.context.retries,
        });
        return { nodeSnapshots: nextSnaps };
      });
    });
    actor.start();
    return actor;
  }

  function registerActor(id: string): NodeActorRef {
    const actor = spawnActor(id);
    set((state) => {
      const nextActors = new Map(state.nodeActors);
      nextActors.set(id, actor);
      return { nodeActors: nextActors };
    });
    return actor;
  }

  function sendTo(id: string, event: NodeEvent): void {
    const actor = get().nodeActors.get(id);
    if (!actor) return;
    actor.send(event);
  }

  function ensureFinalNode() {
    if (get().finalNode) return;
    set({ finalNode: { id: FINAL_ID, label: 'Merge', files: [], conflictFiles: null } });
    registerActor(FINAL_ID);
  }

  function appendLog(id: string, line: string) {
    if (!get().nodeActors.has(id)) return;
    set((state) => {
      const next = new Map(state.nodeLogs);
      next.set(id, [...(next.get(id) ?? []), line]);
      return { nodeLogs: next };
    });
  }

  function detachActiveSubscription() {
    const sub = get().activeSubscription;
    if (!sub) return;
    set({ activeSubscription: null });
    // Fire-and-forget: detach is idempotent and tolerates teardown errors.
    void sub.detach();
  }

  // ---------- Event handlers ----------

  function handleStatusChanged(e: StatusChanged) {
    if (e.runId !== get().runId) return;
    const mapped = mapRunStatus(e.status);
    set({ status: mapped });

    // Spawn the final node on first entry into running. Matches Phase 1
    // behavior: node sits empty with the apply button disabled until
    // DiffReady populates files.
    if (mapped === 'running' && !get().finalNode) {
      ensureFinalNode();
    }

    // Master lifecycle: planning → thinking, awaiting_approval → proposed,
    // running → approved. Keeps the master node label consistent with the
    // overall run state without separate master-specific events.
    if (mapped === 'planning') sendTo(MASTER_ID, { type: 'THINK' });
    if (mapped === 'running') sendTo(MASTER_ID, { type: 'APPROVE' });

    // Terminal events auto-detach. `merging` is NOT terminal — it's the
    // transient apply state, and conflicts may keep the run alive.
    if (mapped === 'done' || mapped === 'failed' || mapped === 'rejected') {
      detachActiveSubscription();
    }
  }

  function handleMasterLog(e: MasterLog) {
    if (e.runId !== get().runId) return;
    appendLog(MASTER_ID, e.line);
  }

  function handleSubtasksProposed(e: SubtasksProposed) {
    if (e.runId !== get().runId) return;
    const existing = new Set(get().subtasks.map((s) => s.id));
    const appended: SubtaskNodeData[] = [];
    for (const st of e.subtasks) {
      if (existing.has(st.id)) continue;
      appended.push({
        id: st.id,
        title: st.title,
        agent: st.assignedWorker,
        dependsOn: st.dependencies,
      });
      const actor = registerActor(st.id);
      actor.send({ type: 'PROPOSE' });
    }
    // Master transitions to proposed. On re-plan (master was approved),
    // route through thinking → proposed; on first wave (master thinking),
    // just PROPOSE. Machine no-ops PROPOSE from proposed, so re-emit is safe.
    const masterSnap = get().nodeSnapshots.get(MASTER_ID)?.value;
    if (masterSnap === 'approved') {
      sendTo(MASTER_ID, { type: 'THINK' });
    }
    sendTo(MASTER_ID, { type: 'PROPOSE' });

    set((state) => ({
      subtasks: [...state.subtasks, ...appended],
      selectedSubtaskIds: new Set(appended.map((s) => s.id)),
    }));
  }

  function handleSubtaskStateChanged(e: SubtaskStateChanged) {
    if (e.runId !== get().runId) return;
    const current = get().nodeSnapshots.get(e.subtaskId)?.value;
    const events = eventsForSubtaskState(e.state, current);
    for (const type of events) {
      sendTo(e.subtaskId, { type });
    }
  }

  function handleSubtaskLog(e: SubtaskLog) {
    if (e.runId !== get().runId) return;
    appendLog(e.subtaskId, e.line);
  }

  function handleDiffReady(e: DiffReady) {
    if (e.runId !== get().runId) return;
    ensureFinalNode();
    set((state) => {
      if (!state.finalNode) return state;
      return {
        finalNode: {
          ...state.finalNode,
          files: e.files.map((f) => f.path),
        },
      };
    });
    // Drive the final node's XState actor into `running` so FinalNode
    // renders its Apply button as enabled. Without this the actor sits
    // at `idle` forever and the merge UI looks clickable but is inert.
    // The machine no-ops unknown transitions from a later state, so
    // re-sending the full chain is safe on repeat DiffReady events
    // (e.g. master re-plan between approval and merge).
    const finalSnap = get().nodeSnapshots.get(FINAL_ID)?.value;
    if (finalSnap === 'idle') {
      sendTo(FINAL_ID, { type: 'PROPOSE' });
      sendTo(FINAL_ID, { type: 'APPROVE' });
      sendTo(FINAL_ID, { type: 'START' });
    }
  }

  function handleMergeConflict(e: MergeConflict) {
    if (e.runId !== get().runId) return;
    ensureFinalNode();
    set((state) => {
      if (!state.finalNode) return state;
      return {
        finalNode: {
          ...state.finalNode,
          conflictFiles: [...e.files],
        },
      };
    });
  }

  function handleBaseBranchDirty(e: BaseBranchDirty) {
    if (e.runId !== get().runId) return;
    // Distinct from MergeConflict: the user's base-branch WIP blocked
    // the merge before it started. Worker branches are clean, so we
    // don't want to paint the FinalNode as conflicting — it's still a
    // clean apply once the user tidies their own tree. Surface the
    // failure through `currentError` (ErrorBanner picks it up) with a
    // clear instruction and the offending file list so they know
    // exactly what to commit or stash.
    //
    // Prefix the absolute repo path so two same-named repos in
    // different parent dirs (e.g. `~/Projects/foo` vs
    // `~/Projects/archive/foo`) don't trick the user into cleaning
    // the wrong one. Cheap to include; saves a real debugging hour.
    const repoPath = useRepoStore.getState().currentRepo?.path;
    const where = repoPath ? ` in ${repoPath}` : '';
    const list = e.files.join(', ');
    const msg =
      e.files.length === 1
        ? `You have uncommitted changes${where}: ${list}. Commit or stash it, then click Apply again.`
        : `You have uncommitted changes${where} in ${e.files.length} files (${list}). Commit or stash them, then click Apply again.`;
    set({ currentError: msg });
  }

  function handleCompleted(e: Completed) {
    if (e.runId !== get().runId) return;
    // `Completed` fires after a successful apply. Clear any stale conflict
    // metadata, mark the run applied so App.tsx routes back to EmptyState,
    // and detach.
    set((state) => ({
      status: 'applied',
      finalNode: state.finalNode
        ? { ...state.finalNode, conflictFiles: null }
        : state.finalNode,
    }));
    // Land the final actor in its terminal `done` state. No-op if Apply
    // was never clicked (actor still at idle/proposed/approved), which
    // matches reality — Completed only reaches the frontend after a
    // successful merge, by which point the actor is already in running.
    sendTo(FINAL_ID, { type: 'COMPLETE' });
    detachActiveSubscription();
  }

  function handleFailed(e: Failed) {
    if (e.runId !== get().runId) return;
    set({ currentError: e.error, status: 'failed' });
    detachActiveSubscription();
  }

  function buildHandlers() {
    return {
      onStatusChanged: handleStatusChanged,
      onMasterLog: handleMasterLog,
      onSubtasksProposed: handleSubtasksProposed,
      onSubtaskStateChanged: handleSubtaskStateChanged,
      onSubtaskLog: handleSubtaskLog,
      onDiffReady: handleDiffReady,
      onMergeConflict: handleMergeConflict,
      onBaseBranchDirty: handleBaseBranchDirty,
      onCompleted: handleCompleted,
      onFailed: handleFailed,
      onParseError: defaultOnParseError,
    };
  }

  // ---------- Public actions ----------

  return {
    ...initial,

    setMasterAgent(agent) {
      set({ selectedMasterAgent: agent });
    },

    async submitTask(input, masterAgent) {
      // `handleCompleted` / `handleFailed` mark the run terminal but
      // leave `runId` populated (the final graph is still on-screen
      // until the user acts). Once App.tsx routes back to EmptyState
      // (on `applied` / `rejected` / `failed`) the user can legally
      // submit a new task — clean up the stale run first. Only refuse
      // when there's genuinely a live run in flight.
      const { runId: priorRunId, status: priorStatus } = get();
      if (priorRunId !== null) {
        const priorIsTerminal =
          priorStatus === 'applied' ||
          priorStatus === 'rejected' ||
          priorStatus === 'failed';
        if (!priorIsTerminal) {
          throw new Error(
            'A run is already active. Reset or discard the current run before submitting again.',
          );
        }
        get().reset();
      }

      const repoPath = useRepoStore.getState().currentRepo?.path;
      if (!repoPath) {
        throw new Error('No repo selected');
      }

      const agent = masterAgent ?? get().selectedMasterAgent;

      // Optimistic master actor + planning status — gives instant feedback
      // while the IPC round-trip happens. Backend's status_changed(Planning)
      // will re-confirm once the subscription is attached.
      const masterActor = registerActor(MASTER_ID);
      masterActor.send({ type: 'THINK' });
      set({
        runId: newLocalRunId(),
        taskInput: input,
        masterNode: { id: MASTER_ID, agent: 'master', label: 'Master' },
        selectedMasterAgent: agent,
        status: 'planning',
        currentError: null,
      });

      let realRunId: string;
      try {
        realRunId = await submitTaskIpc(input, repoPath);
      } catch (err) {
        get().reset();
        set({ currentError: `Failed to start run: ${String(err)}` });
        throw err;
      }

      const subscription = new RunSubscription(realRunId, buildHandlers());
      try {
        await subscription.attach();
      } catch (err) {
        // Attach failed — we can't observe the run. Best effort: ask backend
        // to cancel so we don't leak a detached run, then clear.
        void cancelRunIpc(realRunId).catch(() => undefined);
        get().reset();
        set({ currentError: `Failed to subscribe to run: ${String(err)}` });
        throw err;
      }

      set({ runId: realRunId, activeSubscription: subscription });
    },

    toggleSubtaskSelection(id) {
      set((state) => {
        const next = new Set(state.selectedSubtaskIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return { selectedSubtaskIds: next };
      });
    },

    selectAll() {
      set((state) => ({
        selectedSubtaskIds: new Set(state.subtasks.map((s) => s.id)),
      }));
    },

    selectNone() {
      set({ selectedSubtaskIds: new Set() });
    },

    async approveSubtasks(ids) {
      const runId = get().runId;
      if (!runId) return;
      try {
        await approveSubtasksIpc(runId, ids);
      } catch (err) {
        set({ currentError: `Approval failed: ${String(err)}` });
        throw err;
      }
    },

    async rejectAll() {
      const runId = get().runId;
      if (!runId) return;
      try {
        await rejectRunIpc(runId);
      } catch (err) {
        set({ currentError: `Reject failed: ${String(err)}` });
        throw err;
      }
    },

    async applyRun() {
      const runId = get().runId;
      if (!runId) return;
      // Clear any stale "base branch dirty" / "apply failed" error from a
      // prior attempt. If the new attempt fails the same way, the
      // event handler will repopulate with the fresh file list.
      set({ currentError: null });
      try {
        await applyRunIpc(runId);
      } catch (err) {
        set({ currentError: `Apply failed: ${String(err)}` });
        throw err;
      }
    },

    async discardRun() {
      const runId = get().runId;
      if (!runId) {
        // No active run — user still expects the graph to clear.
        get().reset();
        return;
      }
      try {
        await discardRunIpc(runId);
      } catch (err) {
        set({ currentError: `Discard failed: ${String(err)}` });
        throw err;
      }
      get().reset();
    },

    async cancelRun() {
      const runId = get().runId;
      if (!runId) return;
      try {
        await cancelRunIpc(runId);
      } catch (err) {
        set({ currentError: `Cancel failed: ${String(err)}` });
        throw err;
      }
    },

    dismissError() {
      set({ currentError: null });
    },

    reset() {
      detachActiveSubscription();
      for (const actor of get().nodeActors.values()) actor.stop();
      set({
        ...initial,
        nodeActors: new Map(),
        nodeSnapshots: new Map(),
        nodeLogs: new Map(),
      });
    },
  };
});
