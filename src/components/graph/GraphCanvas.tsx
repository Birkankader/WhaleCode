import '@xyflow/react/dist/base.css';

import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type CoordinateExtent,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/shallow';

import { useRecenterShortcut } from '../../hooks/useRecenterShortcut';
import {
  NODE_DIMENSIONS,
  layoutGraph,
  type LayoutEdgeInput,
  type LayoutNodeInput,
} from '../../lib/layout';
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

/**
 * Container-width threshold below which we stack subtasks 2-per-row instead
 * of spreading them across a single wide row.
 */
const COMPACT_BREAKPOINT = 1280;
/** Pan headroom past the graph bounds so users can scroll into the margin. */
const PAN_MARGIN = 200;

/** See `onNodeClick` comment below — this noop unblocks pointer-events. */
const noopNodeClick = () => undefined;

export function GraphCanvas() {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner />
    </ReactFlowProvider>
  );
}

function GraphCanvasInner() {
  const structure = useGraphStore(
    useShallow((s) => ({
      masterNode: s.masterNode,
      subtasks: s.subtasks,
      finalNode: s.finalNode,
    })),
  );
  const nodeSnapshots = useGraphStore((s) => s.nodeSnapshots);
  // Step 3a: retry counts are tracked in the store, not in machine
  // context. Subscribe separately so a retry tick doesn't rebuild
  // nodes whose state didn't change — the buildGraph memo re-runs
  // only when one of its own inputs changes.
  const retryCounts = useGraphStore((s) => s.subtaskRetryCounts);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);

  // Track container width so we can switch between single-row and stacked
  // grid layouts. We read from getBoundingClientRect on every signal rather
  // than trusting ResizeObserver's contentRect — some preview/embed contexts
  // drop RO callbacks, and the window resize listener is the authoritative
  // fallback. Reading twice is cheap (a single layout query, no work on hot
  // paths like pointermove).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const apply = () => setCompact(el.getBoundingClientRect().width < COMPACT_BREAKPOINT);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    window.addEventListener('resize', apply);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', apply);
    };
  }, []);

  const { nodes, edges } = useMemo(() => {
    return buildGraph(structure, nodeSnapshots, retryCounts, compact ? 2 : undefined);
  }, [structure, nodeSnapshots, retryCounts, compact]);

  const { setViewport } = useReactFlow();

  const structureSignature = useMemo(() => {
    const ids = [
      structure.masterNode?.id ?? '',
      ...structure.subtasks.map((s) => s.id),
      structure.finalNode?.id ?? '',
    ];
    return ids.join('|');
  }, [structure]);

  // Ref the latest nodes so the recenter callback identity doesn't churn on
  // every snapshot update. Effects that depend on recenter would otherwise
  // cancel their pending rAFs before the structural frame got a chance to fit.
  // The ref is synced in a layout effect (not during render) so the write is
  // observable and ordered — React runs layout effects in declaration order,
  // so this one fires before the recenter effect below and every call to
  // `recenter` reads the nodes value from the same render cycle.
  const nodesRef = useRef(nodes);
  useLayoutEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const recenter = useCallback(
    (duration = 300) => {
      const box = containerRef.current?.getBoundingClientRect();
      if (!box) return;
      const bounds = computeBounds(nodesRef.current);
      if (!bounds) return;
      const pad = 0.15;
      const scale = Math.min(
        1,
        (box.width * (1 - 2 * pad)) / bounds.w,
        (box.height * (1 - 2 * pad)) / bounds.h,
      );
      const x = (box.width - bounds.w * scale) / 2 - bounds.minX * scale;
      const y = (box.height - bounds.h * scale) / 2 - bounds.minY * scale;
      setViewport({ x, y, zoom: scale }, duration > 0 ? { duration } : undefined);
    },
    [setViewport],
  );

  // Clamp panning so users can't sling the graph entirely off-screen. Margin
  // gives a breathable gutter past the node edges; recomputed whenever the
  // structure changes so a new final node or replan doesn't land out of reach.
  const translateExtent = useMemo<CoordinateExtent | undefined>(() => {
    const bounds = computeBounds(nodes);
    if (!bounds) return undefined;
    return [
      [bounds.minX - PAN_MARGIN, bounds.minY - PAN_MARGIN],
      [bounds.minX + bounds.w + PAN_MARGIN, bounds.minY + bounds.h + PAN_MARGIN],
    ];
  }, [nodes]);

  // Recenter when the *layout* changes (structure, compact mode, or container
  // size). No animation — stomping animations during rapid layout updates
  // (resize drag, orchestration ramp-up) produced a stale viewport; snap is
  // instant and visually fine at these cadences.
  useLayoutEffect(() => {
    if (nodes.length === 0) return;
    recenter(0);
  }, [structureSignature, compact, recenter, nodes.length]);

  useRecenterShortcut(useCallback(() => recenter(300), [recenter]));

  return (
    <div ref={containerRef} className="h-full w-full bg-bg-primary">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        minZoom={0.4}
        maxZoom={1}
        translateExtent={translateExtent}
        panOnDrag
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        // React Flow's NodeWrapper sets an inline `pointer-events: none` when
        // a node is not draggable, not selectable, and has no node-level mouse
        // handlers — which happens to match our config exactly. That style
        // beats the `pointer-events: all` rule in base.css, so inner `onClick`
        // handlers (card-click-to-select, Apply/Discard buttons on the final
        // node) never fire. Passing a noop `onNodeClick` flips the wrapper
        // back to pointer-events:all without enabling RF's own selection UI.
        onNodeClick={noopNodeClick}
        // Step 2: inline edit UI lives inside proposed nodes. Belt-and-
        // suspenders with `elementsSelectable={false}` — nothing is selectable
        // so RF's delete path is already dead, but an explicit null guarantees
        // Backspace/Delete inside an input never triggers a graph-level side
        // effect no matter what future config changes we make.
        deleteKeyCode={null}
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
  retryCounts: Map<string, number>,
  maxPerRow: number | undefined,
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

  const positioned = layoutGraph(layoutInputs, layoutEdges, { maxPerRow });

  const nodes: Node[] = positioned.map((p) => {
    const data = dataFor(p.id, p.kind, structure, snapshots, retryCounts);
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

function computeBounds(
  nodes: Node[],
): { minX: number; minY: number; w: number; h: number } | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const dim = NODE_DIMENSIONS[n.type as keyof typeof NODE_DIMENSIONS];
    if (!dim) continue;
    if (n.position.x < minX) minX = n.position.x;
    if (n.position.y < minY) minY = n.position.y;
    if (n.position.x + dim.width > maxX) maxX = n.position.x + dim.width;
    if (n.position.y + dim.height > maxY) maxY = n.position.y + dim.height;
  }
  if (!isFinite(minX)) return null;
  return { minX, minY, w: maxX - minX, h: maxY - minY };
}

function dataFor(
  id: string,
  kind: 'master' | 'worker' | 'final',
  structure: Structure,
  snapshots: Map<string, NodeSnapshot>,
  retryCounts: Map<string, number>,
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
      conflictFiles: structure.finalNode.conflictFiles,
    };
  }
  const st = structure.subtasks.find((s) => s.id === id);
  return {
    state,
    agent: st?.agent ?? 'claude',
    title: st?.title ?? id,
    retries: retryCounts.get(id) ?? 0,
  };
}

function isRunning(snapshots: Map<string, NodeSnapshot>, id: string): boolean {
  const snap = snapshots.get(id);
  return snap ? RUNNING_STATES.has(snap.value) : false;
}
