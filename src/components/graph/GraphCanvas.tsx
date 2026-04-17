import '@xyflow/react/dist/base.css';

import { ReactFlow, type Edge, type Node, type NodeTypes, type EdgeTypes } from '@xyflow/react';
import { useMemo } from 'react';
import { useShallow } from 'zustand/shallow';

import { layoutGraph, type LayoutNodeInput, type LayoutEdgeInput } from '../../lib/layout';
import { MASTER_ID, FINAL_ID, useGraphStore } from '../../state/graphStore';
import type { NodeState } from '../../state/nodeMachine';
import { FlowEdge } from './edges/FlowEdge';
import { PlaceholderNode, type PlaceholderNodeData } from './nodes/PlaceholderNode';

const nodeTypes: NodeTypes = {
  master: PlaceholderNode,
  worker: PlaceholderNode,
  final: PlaceholderNode,
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
  snapshots: Map<string, { value: NodeState; retries: number }>,
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
    const data: PlaceholderNodeData = {
      kind: p.kind,
      label: labelFor(p.id, structure),
    };
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

function labelFor(id: string, structure: Structure): string {
  if (id === MASTER_ID) return structure.masterNode?.agent ?? 'master';
  if (id === FINAL_ID) return structure.finalNode?.label ?? 'merge';
  const st = structure.subtasks.find((s) => s.id === id);
  return st?.title ?? id;
}

function isRunning(
  snapshots: Map<string, { value: NodeState; retries: number }>,
  id: string,
): boolean {
  const snap = snapshots.get(id);
  return snap ? RUNNING_STATES.has(snap.value) : false;
}
