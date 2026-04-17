import '@xyflow/react/dist/base.css';

import { ReactFlow, type Edge, type Node, type NodeTypes, type EdgeTypes } from '@xyflow/react';
import { useMemo } from 'react';
import { useShallow } from 'zustand/shallow';

import { layoutGraph, type LayoutNodeInput, type LayoutEdgeInput } from '../../lib/layout';
import { FinalNode, type FinalNodeData } from '../nodes/FinalNode';
import { MasterNode, type MasterNodeData } from '../nodes/MasterNode';
import { WorkerNode, type WorkerNodeData } from '../nodes/WorkerNode';
import { MASTER_ID, FINAL_ID, useGraphStore } from '../../state/graphStore';
import type { NodeSnapshot } from '../../state/graphStore';
import type { NodeState } from '../../state/nodeMachine';
import { FlowEdge } from './edges/FlowEdge';

const nodeTypes: NodeTypes = {
  master: MasterNode,
  worker: WorkerNode,
  final: FinalNode,
};

const edgeTypes: EdgeTypes = {
  flow: FlowEdge,
};

const RUNNING_STATES: ReadonlySet<NodeState> = new Set(['running', 'retrying']);

export function GraphCanvas() {
  // Structural selectors — references stay stable across log appends.
  const structure = useGraphStore(
    useShallow((s) => ({
      masterNode: s.masterNode,
      subtasks: s.subtasks,
      finalNode: s.finalNode,
    })),
  );
  // Snapshot map — changes only on state transitions, not on logs.
  const nodeSnapshots = useGraphStore((s) => s.nodeSnapshots);

  const { nodes, edges } = useMemo(() => {
    return buildGraph(structure, nodeSnapshots);
  }, [structure, nodeSnapshots]);

  return (
    <div className="h-full w-full bg-bg-primary">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        panOnDrag={false}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      />
    </div>
  );
}

type Structure = {
  masterNode: ReturnType<typeof useGraphStore.getState>['masterNode'];
  subtasks: ReturnType<typeof useGraphStore.getState>['subtasks'];
  finalNode: ReturnType<typeof useGraphStore.getState>['finalNode'];
};

function buildGraph(
  structure: Structure,
  snapshots: Map<string, NodeSnapshot>,
): { nodes: Node[]; edges: Edge[] } {
  const { masterNode, subtasks, finalNode } = structure;
  if (!masterNode) return { nodes: [], edges: [] };

  const layoutInputs: LayoutNodeInput[] = [{ id: masterNode.id, kind: 'master' }];
  for (const st of subtasks) layoutInputs.push({ id: st.id, kind: 'worker' });
  if (finalNode) layoutInputs.push({ id: finalNode.id, kind: 'final' });

  const layoutEdges: LayoutEdgeInput[] = [];
  for (const st of subtasks) {
    layoutEdges.push({ source: masterNode.id, target: st.id });
    if (finalNode) layoutEdges.push({ source: st.id, target: finalNode.id });
  }

  const positioned = layoutGraph(layoutInputs, layoutEdges);

  const nodes: Node[] = positioned.map((p) => {
    const data = dataFor(p.id, p.kind, structure, snapshots);
    return {
      id: p.id,
      type: p.kind,
      position: { x: p.x, y: p.y },
      data: data as unknown as Record<string, unknown>,
      draggable: false,
      selectable: false,
    };
  });

  const edges: Edge[] = layoutEdges.map((e) => ({
    id: `${e.source}->${e.target}`,
    source: e.source,
    target: e.target,
    type: 'flow',
    data: { animated: isRunning(snapshots, e.target) },
  }));

  return { nodes, edges };
}

function dataFor(
  id: string,
  kind: 'master' | 'worker' | 'final',
  structure: Structure,
  snapshots: Map<string, NodeSnapshot>,
): MasterNodeData | WorkerNodeData | FinalNodeData {
  const snap = snapshots.get(id);
  const state: NodeState = snap?.value ?? 'idle';

  if (kind === 'master' && id === MASTER_ID && structure.masterNode) {
    return {
      state,
      agent: structure.masterNode.agent,
      title: structure.masterNode.label,
    };
  }
  if (kind === 'final' && id === FINAL_ID && structure.finalNode) {
    return {
      state,
      label: structure.finalNode.label,
      files: structure.finalNode.files,
    };
  }
  // Worker
  const st = structure.subtasks.find((s) => s.id === id);
  return {
    state,
    agent: st?.agent ?? 'claude',
    title: st?.title ?? id,
    retries: snap?.retries ?? 0,
  };
}

function isRunning(snapshots: Map<string, NodeSnapshot>, id: string): boolean {
  const snap = snapshots.get(id);
  return snap ? RUNNING_STATES.has(snap.value) : false;
}
