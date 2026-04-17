import dagre from '@dagrejs/dagre';

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

/**
 * Fixed node dimensions per type — Dagre needs deterministic sizes before the
 * DOM measures anything. Step 6 may tune these once real node content lands;
 * layout tests lock the ratios until then.
 */
export const NODE_DIMENSIONS: Record<LayoutNodeKind, { width: number; height: number }> = {
  master: { width: 240, height: 80 },
  worker: { width: 200, height: 72 },
  final: { width: 160, height: 64 },
};

/** Spacing aligns with the design-system 24/48 tokens. */
export const LAYOUT_SPACING = {
  ranksep: 48,
  nodesep: 24,
  marginx: 24,
  marginy: 24,
} as const;

export function layoutGraph(
  nodes: readonly LayoutNodeInput[],
  edges: readonly LayoutEdgeInput[],
): LayoutNodeOutput[] {
  if (nodes.length === 0) return [];

  const g = new dagre.graphlib.Graph({ directed: true });
  g.setGraph({
    rankdir: 'TB',
    nodesep: LAYOUT_SPACING.nodesep,
    ranksep: LAYOUT_SPACING.ranksep,
    marginx: LAYOUT_SPACING.marginx,
    marginy: LAYOUT_SPACING.marginy,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    const { width, height } = NODE_DIMENSIONS[node.kind];
    g.setNode(node.id, { width, height });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const { width, height } = NODE_DIMENSIONS[node.kind];
    const centered = g.node(node.id);
    return {
      id: node.id,
      kind: node.kind,
      width,
      height,
      // Dagre reports center coordinates; React Flow expects top-left.
      x: centered.x - width / 2,
      y: centered.y - height / 2,
    };
  });
}
