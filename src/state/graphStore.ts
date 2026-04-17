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
  | 'failed';

type NodeActorRef = ActorRefFrom<typeof nodeMachine>;

export type GraphState = {
  runId: string | null;
  taskInput: string;
  masterNode: MasterNodeData | null;
  subtasks: SubtaskNodeData[];
  finalNode: FinalNodeData | null;
  status: GraphStatus;
  selectedSubtaskIds: Set<string>;
  nodeActors: Map<string, NodeActorRef>;
  nodeSnapshots: Map<string, NodeSnapshot>;
  nodeLogs: Map<string, string[]>;

  submitTask: (input: string, masterAgent?: AgentKind) => void;
  proposeSubtasks: (subtasks: Array<Omit<SubtaskNodeData, 'logs'>>) => void;
  toggleSubtaskSelection: (id: string) => void;
  selectAll: () => void;
  selectNone: () => void;
  approveSubtasks: (ids: string[]) => void;
  rejectAll: () => void;
  updateSubtaskState: (id: string, event: NodeEvent) => void;
  appendLogToNode: (id: string, line: string) => void;
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
  | 'selectedSubtaskIds'
  | 'nodeActors'
  | 'nodeSnapshots'
  | 'nodeLogs'
> = {
  runId: null,
  taskInput: '',
  masterNode: null,
  subtasks: [],
  finalNode: null,
  status: 'idle',
  selectedSubtaskIds: new Set(),
  nodeActors: new Map(),
  nodeSnapshots: new Map(),
  nodeLogs: new Map(),
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

  return {
    ...initial,

    submitTask(input, masterAgent = 'master') {
      get().reset();
      const masterActor = registerActor(MASTER_ID);
      masterActor.send({ type: 'THINK' });
      set({
        runId: newRunId(),
        taskInput: input,
        masterNode: { id: MASTER_ID, agent: masterAgent, label: 'Master' },
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
      for (const st of get().subtasks) {
        sendTo(st.id, { type: approved.has(st.id) ? 'APPROVE' : 'SKIP' });
      }
      sendTo(MASTER_ID, { type: 'APPROVE' });
      set({
        status: 'running',
        finalNode: { id: FINAL_ID, label: 'Merge' },
      });
      registerActor(FINAL_ID);
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

    reset() {
      for (const actor of get().nodeActors.values()) {
        actor.stop();
      }
      set({
        ...initial,
        nodeActors: new Map(),
        nodeSnapshots: new Map(),
        nodeLogs: new Map(),
      });
    },
  };
});
