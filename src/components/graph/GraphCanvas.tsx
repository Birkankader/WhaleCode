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
import { InlineDiffSidebar } from '../nodes/InlineDiffSidebar';
import { MasterNode, type MasterNodeData } from '../nodes/MasterNode';
import { WorkerNode, type WorkerNodeData } from '../nodes/WorkerNode';
import { ApplySummaryOverlay } from '../overlay/ApplySummaryOverlay';
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
 * Per-worker container height for states that have a streaming
 * surface — chip stack + hint input on top of title + why + header.
 *
 * History: 180 (Phase 4 Step 3) → 240 (Phase 7 polish after Step 1
 * screenshots showed cramping) → 200 (Phase 7 polish round 2 after
 * the LogBlock was removed from the default running view). The log
 * tail used to claim a 54px row; with stream-json turning that row
 * into raw NDJSON noise, the LogBlock now mounts only when the user
 * clicks the card to expand it. The remaining stack (header + title
 * + why + chip stack + hint input + footer) fits in ~180px; 200 gives
 * one row of breathing room for two-row chip overflow when the
 * compression rule doesn't fire.
 */
const LOGS_WORKER_HEIGHT = 200;
const LOGS_STATES: ReadonlySet<NodeState> = new Set([
  'running',
  'retrying',
  'done',
  'failed',
]);
/**
 * Phase 4 Step 3: worker card expanded *ceiling*. Promoted when the
 * user clicks the card body (non-chip, non-button) on a non-proposed
 * worker. Deliberately NOT viewport-relative so one enthusiastic
 * expand can't eat the whole canvas on a tall monitor. Wins over the
 * state-tier heights (logs/escalation) via the expand-override path
 * in `buildGraph`; row-max alignment in `layoutGraph` means row-mates
 * grow in sympathy, which keeps the grid readable.
 *
 * Lowered 560 → 420 → 340 across two post-Step-6 rounds: 420 still
 * pushed the final/merge node off-screen on a 14" laptop (≈800px
 * viewport). Stack math with the default one-worker row is
 * marginy(24) + master(80) + ranksep(48) + card(H) + ranksep(48)
 * + final(148) + marginy(24) = 372 + H; at H=340 total is 712px,
 * leaving real breathing room under the usable canvas height and
 * keeping the merge card visible without a pan.
 *
 * As of the content-fit round: this value is a *ceiling* only — the
 * actual height is computed by `expandedHeightFor(lineCount)` between
 * `EXPANDED_FLOOR` and here. A freshly-expanded card with no output
 * lands on the floor (200px) instead of painting a ~200px dead log
 * area below the "Waiting for output…" placeholder; a long log
 * clamps at the ceiling and the inner scroll handles the rest.
 */
const EXPANDED_WORKER_HEIGHT = 340;
/**
 * Content-fit floor for the expanded card. Covers the non-log chrome
 * (header ~20, title ~22, why ~18, footer ~28 + spacing) ≈ 120px plus
 * ~60px of padded log area so the "Waiting for output…" placeholder
 * and one/two-line log tails don't visibly underflow into dead space.
 */
const EXPANDED_FLOOR = 200;
/**
 * Non-log chrome height inside the expanded card: header row + title
 * + why + footer chips + internal gaps. Measured against the current
 * WorkerNode render at fontSize 10 + spacing token 4/8. Treated as a
 * constant here because a tweak to chrome typography lands in one
 * place and this math follows.
 */
const EXPANDED_CHROME_PX = 120;
/**
 * Per-log-line visual height inside `ExpandedLogBlock`: fontSize 10 ×
 * lineHeight 1.5 = 15px. Wrapped long lines produce additional visual
 * rows we can't see from layout time, but clamping at
 * `EXPANDED_WORKER_HEIGHT` means the worst-case underestimate falls
 * back to the fixed ceiling and an inner scrollbar takes over.
 */
const EXPANDED_LOG_LINE_PX = 15;
/** Padding around the scrollable log area (top + bottom = 6 + 6). */
const EXPANDED_LOG_PAD_PX = 12;

/**
 * Compute the expanded card height for a given log-line count. Caps
 * at `EXPANDED_WORKER_HEIGHT` so a runaway log can't escape the post-
 * Step-6 viewport constraint; floors at `EXPANDED_FLOOR` so the card
 * looks intentional when the log is empty. Chrome is treated as a
 * constant overhead; the log area grows linearly until the ceiling
 * claims control and the inner scroll handles overflow.
 */
function expandedHeightFor(lineCount: number): number {
  const logArea = lineCount * EXPANDED_LOG_LINE_PX + EXPANDED_LOG_PAD_PX;
  const desired = EXPANDED_CHROME_PX + logArea;
  return Math.max(EXPANDED_FLOOR, Math.min(EXPANDED_WORKER_HEIGHT, desired));
}
/**
 * States where the expand toggle is legal. Proposed is excluded
 * because the whole-card click is already the selection-toggle
 * affordance. The rest are the states that have log content worth
 * inspecting (running/retrying stream live; done/failed are the
 * final transcript; cancelled preserves the tombstone log;
 * human_escalation needs the full log for the "what went wrong"
 * moment). `escalating` / `skipped` are transient/uninteresting —
 * left out on purpose.
 */
const EXPANDABLE_STATES: ReadonlySet<NodeState> = new Set([
  'running',
  'retrying',
  'done',
  'failed',
  'human_escalation',
  'cancelled',
]);

/** See `onNodeClick` comment below — this noop unblocks pointer-events. */
const noopNodeClick = () => undefined;

export function GraphCanvas() {
  return (
    <ReactFlowProvider>
      {/*
       * Phase 7 Step 1: outer flex container splits the canvas
       * area into a flex-1 graph region (with absolute-positioned
       * ApplySummaryOverlay riding on top) and the right-edge
       * InlineDiffSidebar. Sidebar collapse / drag-resize shrinks
       * the graph region; ResizeObserver inside GraphCanvasInner
       * re-fires the compact-mode breakpoint flip and ReactFlow's
       * own resize observer re-fits the viewport.
       */}
      <div className="flex h-full w-full">
        <div className="relative min-w-0 flex-1">
          <GraphCanvasInner />
          <ApplySummaryOverlay />
        </div>
        <InlineDiffSidebar />
      </div>
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
  // Selection drives the proposed-state dim: unticked proposed subtasks
  // and their incident edges go to 50% opacity. WorkerNode reads its own
  // bit straight from the store; `buildGraph` needs the set here so it
  // can tag edges whose source or target is a dim-worthy subtask.
  const selectedSubtaskIds = useGraphStore((s) => s.selectedSubtaskIds);
  // Phase 4 Step 3: expanded-worker ids drive the ~340px height
  // override in buildGraph. Subscribing here keeps the layout pass
  // reactive to toggle clicks from any WorkerNode — the Set identity
  // flips on each toggle so the memo below re-runs exactly once.
  const workerExpanded = useGraphStore((s) => s.workerExpanded);
  // Content-fit expand: the expanded card's height is computed from
  // the actual log-line count so a "Waiting for output…" card doesn't
  // paint a ~200px empty scroll area below the header. Subscribing
  // to the raw nodeLogs map here means the memo below re-runs on
  // every new log line pushed by the orchestrator stream — layout
  // itself is pure JS and O(n) in worker count, so the recompute is
  // cheap; React Flow's own data diff drops any node whose `height`
  // didn't move across the threshold, so the downstream render cost
  // stays proportional to how often the computed height actually
  // changes.
  const nodeLogs = useGraphStore((s) => s.nodeLogs);

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
    return buildGraph(
      structure,
      nodeSnapshots,
      retryCounts,
      selectedSubtaskIds,
      workerExpanded,
      nodeLogs,
      compact ? 2 : undefined,
    );
  }, [
    structure,
    nodeSnapshots,
    retryCounts,
    selectedSubtaskIds,
    workerExpanded,
    nodeLogs,
    compact,
  ]);

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
        // Scroll = pan (matches every map/design tool). Commit 4
        // originally flipped this to scroll-to-zoom, but real usage
        // with 6+ subtask plans made canvas drag-pan unreliable —
        // empty space became rare so every drag started on a node.
        // Falling back to RF's natural defaults: scroll pans;
        // Cmd/Ctrl + scroll zooms (via zoomActivationKeyCode); pinch
        // zooms; keyboard +/- zooms (see useZoomShortcuts); 0 fits.
        panOnScroll
        zoomOnScroll={false}
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
  selectedSubtaskIds: ReadonlySet<string>,
  workerExpanded: ReadonlySet<string>,
  nodeLogs: ReadonlyMap<string, string[]>,
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
  // Three tiers above the 140px default (highest wins):
  //   - expanded (Step 3): content-fit within
  //     [EXPANDED_FLOOR, EXPANDED_WORKER_HEIGHT], computed from the
  //     actual log-line count so a freshly-expanded card that hasn't
  //     received any output yet doesn't paint a ~200px blank scroll
  //     area below the header. Only promoted for non-proposed states
  //     — the store is permissive but WorkerNode gates toggle-on-
  //     click, and the `EXPANDABLE_STATES` guard here is defence in
  //     depth against a stale id surviving a state transition.
  //   - `human_escalation`: 280px, fits EscalationActions surface.
  //   - states with a LogBlock (running/retrying/done/failed): 180px,
  //     fits header + title + why + LogBlock(54px) + chip.
  const workerHeights = new Map<string, number>();
  for (const st of subtasks) {
    const snap = snapshots.get(st.id);
    const state = snap?.value;
    if (workerExpanded.has(st.id) && state && EXPANDABLE_STATES.has(state)) {
      const lineCount = nodeLogs.get(st.id)?.length ?? 0;
      workerHeights.set(st.id, expandedHeightFor(lineCount));
    } else if (state === 'human_escalation') {
      workerHeights.set(st.id, ESCALATION_WORKER_HEIGHT);
    } else if (state && LOGS_STATES.has(state)) {
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

  // An edge is dim-worthy when either endpoint is a proposed subtask
  // the user has unticked. Master / final ids are never in the subtask
  // set and will never match, so this cleanly handles both the
  // master→subtask and subtask→final edges without per-direction
  // special-casing.
  const isDimmedEndpoint = (id: string): boolean => {
    const snap = snapshots.get(id);
    return snap?.value === 'proposed' && !selectedSubtaskIds.has(id);
  };

  const edges: Edge[] = layoutEdges.map((e) => ({
    id: `${e.source}->${e.target}`,
    source: e.source,
    target: e.target,
    type: 'flow',
    data: {
      animated: isRunning(snapshots, e.target),
      dimmed: isDimmedEndpoint(e.source) || isDimmedEndpoint(e.target),
    },
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
