import { createActor, type ActorRefFrom } from 'xstate';
import { create } from 'zustand';

import { nodeMachine, type NodeEvent, type NodeState } from './nodeMachine';

export type AgentKind = 'master' | 'claude' | 'gemini' | 'codex';

export type MasterNodeData = {
  id: 'master';
  agent: AgentKind;
  label: string;
};

export type SubtaskNodeData = {
  id: string;
  title: string;
  agent: AgentKind;
  dependsOn: string[];
};

export type FinalNodeData = {
  id: 'final';
  label: string;
  files: string[];
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
  | 'failed';

type NodeActorRef = ActorRefFrom<typeof nodeMachine>;

export type GraphState = {
  runId: string | null;
  taskInput: string;
  masterNode: MasterNodeData | null;
  subtasks: SubtaskNodeData[];
  finalNode: FinalNodeData | null;
  status: GraphStatus;
  selectedMasterAgent: AgentKind;
  selectedSubtaskIds: Set<string>;
  nodeActors: Map<string, NodeActorRef>;
  nodeSnapshots: Map<string, NodeSnapshot>;
  nodeLogs: Map<string, string[]>;
  /**
   * Handle for aborting an in-flight orchestrator (mock in Phase 1, real in
   * Phase 2). Stored here so reset() can tear down timers and subscriptions
   * before the store itself is cleared — no zombie callbacks.
   */
  orchestrationCancel: (() => void) | null;

  setMasterAgent: (agent: AgentKind) => void;
  setOrchestrationCancel: (fn: (() => void) | null) => void;
  submitTask: (input: string, masterAgent?: AgentKind) => void;
  proposeSubtasks: (subtasks: ReadonlyArray<Omit<SubtaskNodeData, 'logs'>>) => void;
  proposeReplacementSubtasks: (subtasks: ReadonlyArray<Omit<SubtaskNodeData, 'logs'>>) => void;
  toggleSubtaskSelection: (id: string) => void;
  selectAll: () => void;
  selectNone: () => void;
  approveSubtasks: (ids: string[]) => void;
  rejectAll: () => void;
  updateSubtaskState: (id: string, event: NodeEvent) => void;
  appendLogToNode: (id: string, line: string) => void;
  setFinalFiles: (files: readonly string[]) => void;
  completeRun: () => void;
  applyRun: () => void;
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
  | 'orchestrationCancel'
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
  orchestrationCancel: null,
};

function newRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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
    set({ finalNode: { id: FINAL_ID, label: 'Merge', files: [] } });
    registerActor(FINAL_ID);
  }

  return {
    ...initial,

    setMasterAgent(agent) {
      set({ selectedMasterAgent: agent });
    },

    setOrchestrationCancel(fn) {
      set({ orchestrationCancel: fn });
    },

    submitTask(input, masterAgent) {
      const agent = masterAgent ?? get().selectedMasterAgent;
      get().reset();
      const masterActor = registerActor(MASTER_ID);
      masterActor.send({ type: 'THINK' });
      set({
        runId: newRunId(),
        taskInput: input,
        masterNode: { id: MASTER_ID, agent, label: 'Master' },
        selectedMasterAgent: agent,
        status: 'planning',
      });
    },

    proposeSubtasks(defs) {
      const subtasks: SubtaskNodeData[] = defs.map((d) => ({ ...d }));
      for (const st of subtasks) {
        const actor = registerActor(st.id);
        actor.send({ type: 'PROPOSE' });
      }
      sendTo(MASTER_ID, { type: 'PROPOSE' });
      set({
        subtasks,
        selectedSubtaskIds: new Set(subtasks.map((s) => s.id)),
        status: 'awaiting_approval',
      });
    },

    /**
     * Append-only: keeps existing subtasks (including failed / escalating ones
     * the user should still see as strikethrough history). Drives the master
     * back through thinking → proposed so the approval bar can slide up again.
     */
    proposeReplacementSubtasks(defs) {
      const appended: SubtaskNodeData[] = defs.map((d) => ({ ...d }));
      for (const st of appended) {
        const actor = registerActor(st.id);
        actor.send({ type: 'PROPOSE' });
      }
      // approved → thinking → proposed (machine allows THINK from approved).
      sendTo(MASTER_ID, { type: 'THINK' });
      sendTo(MASTER_ID, { type: 'PROPOSE' });
      set((state) => ({
        subtasks: [...state.subtasks, ...appended],
        selectedSubtaskIds: new Set(appended.map((s) => s.id)),
        status: 'awaiting_approval',
      }));
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

    approveSubtasks(ids) {
      const approved = new Set(ids);
      // APPROVE/SKIP are no-ops from done/failed/escalating states, so we can
      // safely iterate all subtasks (including prior-wave completions).
      for (const st of get().subtasks) {
        sendTo(st.id, { type: approved.has(st.id) ? 'APPROVE' : 'SKIP' });
      }
      sendTo(MASTER_ID, { type: 'APPROVE' });
      set({ status: 'running' });
      ensureFinalNode();
    },

    rejectAll() {
      for (const st of get().subtasks) sendTo(st.id, { type: 'SKIP' });
      sendTo(MASTER_ID, { type: 'SKIP' });
      set({ status: 'idle' });
    },

    updateSubtaskState(id, event) {
      sendTo(id, event);
    },

    appendLogToNode(id, line) {
      if (!get().nodeActors.has(id)) return;
      set((state) => {
        const next = new Map(state.nodeLogs);
        next.set(id, [...(next.get(id) ?? []), line]);
        return { nodeLogs: next };
      });
    },

    setFinalFiles(files) {
      set((state) => {
        if (!state.finalNode) return state;
        return { finalNode: { ...state.finalNode, files: [...files] } };
      });
    },

    completeRun() {
      set({ status: 'done' });
    },

    applyRun() {
      // Terminal state for Phase 1. Stops any running actors + timers so the
      // graph freezes, then lets the EmptyState remount with a focused input.
      const cancel = get().orchestrationCancel;
      if (cancel) cancel();
      for (const actor of get().nodeActors.values()) actor.stop();
      set({
        ...initial,
        nodeActors: new Map(),
        nodeSnapshots: new Map(),
        nodeLogs: new Map(),
        status: 'applied',
      });
    },

    reset() {
      const cancel = get().orchestrationCancel;
      if (cancel) cancel();
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
