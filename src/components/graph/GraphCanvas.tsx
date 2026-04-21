import '@xyflow/react/dist/base.css';

import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type CoordinateExtent,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeTypes,
} from '@xyflow/react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/shallow';

import { useRecenterShortcut } from '../../hooks/useRecenterShortcut';
import { useZoomShortcuts } from '../../hooks/useZoomShortcuts';
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
/**
 * Per-worker container height when a subtask is in `human_escalation` —
 * tall enough for the error summary + two primary buttons + tertiary row
 * without clipping. Same-row neighbours align to this via `layoutGraph`'s
 * row-max logic.
 */
const ESCALATION_WORKER_HEIGHT = 280;
/**
 * Per-worker container height for states that have a LogBlock (54px) on
 * top of the title + why + header + chip stack. The default 140px isn't
 * enough — the why line gets visually overwritten by the LogBlock's
 * opaque background when flex squeezes the NonProposedBody. 180px is
 * the middle ground between the compact proposed card (140px) and the
 * escalated surface (280px), and row-max alignment keeps mixed-state
 * rows (one proposed + one running) visually aligned to the taller one.
 */
const LOGS_WORKER_HEIGHT = 180;
const LOGS_STATES: ReadonlySet<NodeState> = new Set([
  'running',
  'retrying',
  'done',
  'failed',
]);

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

  // One-shot fit on the first frame that has nodes to show. After that,
  // the viewport is the user's territory — layout churn (replan adds a
  // row, window resize flips compact mode, a subtask finishes) no longer
  // re-centers, so their current zoom and pan survive the transition.
  // Cmd+0 or the Controls fit-view button are the only way back to auto.
  const didInitialFitRef = useRef(false);
  useLayoutEffect(() => {
    if (didInitialFitRef.current) return;
    if (nodes.length === 0) return;
    didInitialFitRef.current = true;
    recenter(0);
  }, [recenter, nodes.length]);

  useRecenterShortcut(useCallback(() => recenter(300), [recenter]));
  useZoomShortcuts();

  return (
    <div ref={containerRef} className="h-full w-full bg-bg-primary">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        minZoom={0.4}
        maxZoom={2.5}
        translateExtent={translateExtent}
        panOnDrag
        panOnScroll={false}
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
      >
        <GraphBackground />
        <Controls
          showInteractive={false}
          position="bottom-right"
          className="whalecode-controls"
        />
      </ReactFlow>
    </div>
  );
}

/**
 * Subtle dot grid. Visible at regular zoom levels; fades out above 1.5
 * because the dots turn into a loud, pulsing pattern when scaled up —
 * at that point the graph content is large enough to orient on its own
 * and the grid becomes distracting chrome.
 */
function GraphBackground() {
  // `useStore` here is RF's own store, scoped to the provider. The
  // transform tuple is `[x, y, zoom]`; reading zoom only avoids
  // re-rendering on pan.
  const zoom = useStore((s) => s.transform[2]);
  if (zoom > 1.5) return null;
  return (
    <Background
      variant={BackgroundVariant.Dots}
      gap={24}
      size={1}
      color="#1f1f1f"
    />
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

  // Per-subtask height overrides. `layoutGraph` applies row-max
  // alignment, so row-mates match automatically and the final node
  // Y math accounts for the larger row. Empty map = pre-refactor
  // footprint.
  //
  // Two tiers above the 140px default:
  //   - `human_escalation`: 280px, fits EscalationActions surface
  //   - states with a LogBlock (running/retrying/done/failed): 180px,
  //     fits header + title + why + LogBlock(54px) + chip
  // `human_escalation` wins when both apply — the state machine
  // can only land in one at a time, but the guard is explicit for
  // future-proofing.
  const workerHeights = new Map<string, number>();
  for (const st of subtasks) {
    const snap = snapshots.get(st.id);
    const state = snap?.value;
    if (state === 'human_escalation') {
      workerHeights.set(st.id, ESCALATION_WORKER_HEIGHT);
    } else if (state && LOGS_STATES.has(state as NodeState)) {
      workerHeights.set(st.id, LOGS_WORKER_HEIGHT);
    }
  }

  const positioned = layoutGraph(layoutInputs, layoutEdges, {
    maxPerRow,
    workerHeights: workerHeights.size > 0 ? workerHeights : undefined,
  });

  // Thread `p.height` into the WorkerNode data so the container sizes
  // to the row-max (expanded for escalation rows). `computeBounds`
  // reads the same value back off `node.data.height` to include the
  // taller row when clamping the pan extent.
  const nodes: Node[] = positioned.map((p) => {
    const data = dataFor(p.id, p.kind, structure, snapshots, retryCounts, p.height);
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
    // Workers can be taller than `NODE_DIMENSIONS.worker.height` when
    // in escalation; read the emitted height from node.data (the
    // source of truth is `layoutGraph`'s per-row max, which WorkerNode
    // already uses to size its container). Master / final are always
    // the fixed dims.
    const dataHeight =
      n.type === 'worker'
        ? (n.data as { height?: number } | undefined)?.height
        : undefined;
    const h = typeof dataHeight === 'number' ? dataHeight : dim.height;
    if (n.position.x < minX) minX = n.position.x;
    if (n.position.y < minY) minY = n.position.y;
    if (n.position.x + dim.width > maxX) maxX = n.position.x + dim.width;
    if (n.position.y + h > maxY) maxY = n.position.y + h;
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
  positionedHeight: number,
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
    // `why` and `dependsOn` are Phase 3 Step 2 additions — they're only
    // surfaced while the subtask is in the `proposed` state (inline edit
    // UI + dependency footer). Carrying them always keeps the data shape
    // static so WorkerNode doesn't need conditional typing.
    why: st?.why ?? null,
    dependsOn: st?.dependsOn ?? [],
    // `replaces` is non-empty only for Layer-2 replan replacements; the
    // WorkerNode renders a "replaces #N" badge when present. Default to
    // `[]` so the data shape stays static regardless of whether the
    // subtask row has landed yet.
    replaces: st?.replaces ?? [],
    retries: retryCounts.get(id) ?? 0,
    // Row-max height for the container. Defaults to the baseline worker
    // height when the subtask row isn't in the store yet (rare — layout
    // runs only after structure settles).
    replanCount: st?.replanCount ?? 0,
    height: positionedHeight,
  };
}

function isRunning(snapshots: Map<string, NodeSnapshot>, id: string): boolean {
  const snap = snapshots.get(id);
  return snap ? RUNNING_STATES.has(snap.value) : false;
}
