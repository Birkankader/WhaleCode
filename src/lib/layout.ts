export type LayoutNodeKind = 'master' | 'worker' | 'final';

export type LayoutNodeInput = {
  id: string;
  kind: LayoutNodeKind;
};

export type LayoutEdgeInput = {
  source: string;
  target: string;
};

export type LayoutNodeOutput = {
  id: string;
  kind: LayoutNodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type LayoutOptions = {
  /**
   * Maximum workers per row. Undefined means unbounded (all workers on one
   * row) — the pre-responsive default. Set to 2 when the container is narrow
   * so the graph stacks instead of overflowing.
   */
  maxPerRow?: number;
  /**
   * Per-worker height overrides (id → px). Workers not listed fall back
   * to `NODE_DIMENSIONS.worker.height`. Used by Phase 3 Step 5 so a
   * worker in `human_escalation` can expand to ~280px (to host the
   * EscalationActions surface) without growing every other worker.
   *
   * A row's effective height is the max of its workers' heights — all
   * workers in the row emit that row-max in their output so their
   * containers align visually and the row/final-node Y math stays
   * consistent (each row contributes `rowMax + ranksep` to the Y
   * cursor).
   */
  workerHeights?: ReadonlyMap<string, number>;
};

export const NODE_DIMENSIONS: Record<LayoutNodeKind, { width: number; height: number }> = {
  master: { width: 240, height: 80 },
  worker: { width: 200, height: 140 },
  final: { width: 280, height: 148 },
};

/** Spacing aligns with the design-system 24/48 tokens. */
export const LAYOUT_SPACING = {
  ranksep: 48,
  nodesep: 24,
  marginx: 24,
  marginy: 24,
} as const;

/**
 * Deterministic manual layout for our fixed master → workers → final
 * topology. We dropped Dagre because (a) the topology is tightly constrained
 * so the extra graph-theory is dead weight, and (b) Dagre doesn't expose the
 * per-row worker count we need for responsive stacking.
 *
 * The `edges` parameter is kept for API stability — consumers pass the real
 * edge list for React Flow rendering, and future multi-hop topologies may
 * need it.
 */
export function layoutGraph(
  nodes: readonly LayoutNodeInput[],
  _edges: readonly LayoutEdgeInput[],
  options: LayoutOptions = {},
): LayoutNodeOutput[] {
  if (nodes.length === 0) return [];

  const master = nodes.find((n) => n.kind === 'master') ?? null;
  const final = nodes.find((n) => n.kind === 'final') ?? null;
  // Sort workers by id so layout is invariant to input order.
  const workers = nodes
    .filter((n) => n.kind === 'worker')
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));

  const workerW = NODE_DIMENSIONS.worker.width;
  const workerH = NODE_DIMENSIONS.worker.height;
  const masterW = NODE_DIMENSIONS.master.width;
  const masterH = NODE_DIMENSIONS.master.height;
  const finalW = NODE_DIMENSIONS.final.width;
  const finalH = NODE_DIMENSIONS.final.height;
  const { nodesep, ranksep, marginx, marginy } = LAYOUT_SPACING;

  const workerCount = workers.length;
  const requestedPerRow = options.maxPerRow;
  const cols =
    workerCount === 0
      ? 0
      : requestedPerRow === undefined
        ? workerCount
        : Math.max(1, Math.min(requestedPerRow, workerCount));
  const rows = cols > 0 ? Math.ceil(workerCount / cols) : 0;
  const fullRowWidth = cols > 0 ? cols * workerW + (cols - 1) * nodesep : 0;
  const contentWidth = Math.max(fullRowWidth, masterW, finalW);

  // Per-row max height: workers in a row align to the tallest member.
  // Missing overrides fall back to the default worker height, so a plan
  // with no escalated workers lands on the pre-refactor footprint.
  const heightOverrides = options.workerHeights;
  const rowHeights: number[] = [];
  for (let r = 0; r < rows; r++) {
    let h = workerH;
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (idx >= workerCount) break;
      const override = heightOverrides?.get(workers[idx].id);
      if (override !== undefined && override > h) h = override;
    }
    rowHeights.push(h);
  }

  // Y offset for each row's top edge, accumulated from preceding rows'
  // heights + ranksep gaps.
  const rowTops: number[] = [];
  {
    let acc = 0;
    for (const h of rowHeights) {
      rowTops.push(acc);
      acc += h + ranksep;
    }
  }

  const placed = new Map<string, LayoutNodeOutput>();
  let y = marginy;

  if (master) {
    placed.set(master.id, {
      id: master.id,
      kind: 'master',
      width: masterW,
      height: masterH,
      x: marginx + (contentWidth - masterW) / 2,
      y,
    });
    y += masterH + ranksep;
  }

  for (let i = 0; i < workerCount; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const itemsInRow = Math.min(cols, workerCount - row * cols);
    const rowWidth = itemsInRow * workerW + (itemsInRow - 1) * nodesep;
    const rowStartX = marginx + (contentWidth - rowWidth) / 2;
    placed.set(workers[i].id, {
      id: workers[i].id,
      kind: 'worker',
      width: workerW,
      // Emit the row-max so all workers in a row share the same
      // container height — the WorkerNode uses this to size its
      // NodeContainer and the graph bounds calculation to reserve
      // the right amount of vertical space.
      height: rowHeights[row],
      x: rowStartX + col * (workerW + nodesep),
      y: y + rowTops[row],
    });
  }

  if (rows > 0) {
    // Sum the per-row heights (already aligned to each row's max) +
    // ranksep gaps between rows + one ranksep before the final node.
    let span = 0;
    for (let r = 0; r < rows; r++) {
      span += rowHeights[r];
      if (r < rows - 1) span += ranksep;
    }
    y += span + ranksep;
  }

  if (final) {
    placed.set(final.id, {
      id: final.id,
      kind: 'final',
      width: finalW,
      height: finalH,
      x: marginx + (contentWidth - finalW) / 2,
      y,
    });
  }

  // Emit in input order so consumers that zip nodes/outputs stay aligned.
  const result: LayoutNodeOutput[] = [];
  for (const n of nodes) {
    const p = placed.get(n.id);
    if (p) result.push(p);
  }
  return result;
}
