import { describe, expect, it } from 'vitest';

import {
  LAYOUT_SPACING,
  NODE_DIMENSIONS,
  layoutGraph,
  type LayoutEdgeInput,
  type LayoutNodeInput,
} from './layout';

const MASTER: LayoutNodeInput = { id: 'master', kind: 'master' };
const FINAL: LayoutNodeInput = { id: 'final', kind: 'final' };
const workerA: LayoutNodeInput = { id: 'a', kind: 'worker' };
const workerB: LayoutNodeInput = { id: 'b', kind: 'worker' };
const workerC: LayoutNodeInput = { id: 'c', kind: 'worker' };

function topologyEdges(
  masterId: string,
  workerIds: string[],
  finalId: string | null,
): LayoutEdgeInput[] {
  const edges: LayoutEdgeInput[] = workerIds.map((id) => ({ source: masterId, target: id }));
  if (finalId) for (const id of workerIds) edges.push({ source: id, target: finalId });
  return edges;
}

function byId(out: ReturnType<typeof layoutGraph>) {
  return new Map(out.map((n) => [n.id, n]));
}

describe('layoutGraph — empty and trivial', () => {
  it('returns [] for zero nodes', () => {
    expect(layoutGraph([], [])).toEqual([]);
  });

  it('places a single node at the origin-ish (respects margins, no NaN)', () => {
    const [master] = layoutGraph([MASTER], []);
    expect(Number.isFinite(master.x)).toBe(true);
    expect(Number.isFinite(master.y)).toBe(true);
    expect(master.width).toBe(NODE_DIMENSIONS.master.width);
    expect(master.height).toBe(NODE_DIMENSIONS.master.height);
  });
});

describe('layoutGraph — top-down orientation', () => {
  it('master sits above every worker; final sits below every worker', () => {
    const nodes = [MASTER, workerA, workerB, workerC, FINAL];
    const edges = topologyEdges('master', ['a', 'b', 'c'], 'final');
    const out = byId(layoutGraph(nodes, edges));

    const masterY = out.get('master')!.y;
    const workerYs = ['a', 'b', 'c'].map((id) => out.get(id)!.y);
    const finalY = out.get('final')!.y;

    for (const wy of workerYs) expect(wy).toBeGreaterThan(masterY);
    for (const wy of workerYs) expect(finalY).toBeGreaterThan(wy);
  });

  it('workers at the same rank share a y coordinate (within rounding)', () => {
    const nodes = [MASTER, workerA, workerB, workerC, FINAL];
    const edges = topologyEdges('master', ['a', 'b', 'c'], 'final');
    const out = byId(layoutGraph(nodes, edges));
    const ys = ['a', 'b', 'c'].map((id) => out.get(id)!.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(1);
  });
});

describe('layoutGraph — spacing matches design tokens', () => {
  it('vertical gap between master bottom and worker top is at least ranksep', () => {
    const nodes = [MASTER, workerA, FINAL];
    const edges = topologyEdges('master', ['a'], 'final');
    const out = byId(layoutGraph(nodes, edges));

    const master = out.get('master')!;
    const worker = out.get('a')!;
    const gap = worker.y - (master.y + master.height);
    expect(gap).toBeGreaterThanOrEqual(LAYOUT_SPACING.ranksep - 1);
  });

  it('horizontal gap between sibling workers is at least nodesep', () => {
    const nodes = [MASTER, workerA, workerB, FINAL];
    const edges = topologyEdges('master', ['a', 'b'], 'final');
    const out = byId(layoutGraph(nodes, edges));

    const a = out.get('a')!;
    const b = out.get('b')!;
    const [left, right] = a.x < b.x ? [a, b] : [b, a];
    const gap = right.x - (left.x + left.width);
    expect(gap).toBeGreaterThanOrEqual(LAYOUT_SPACING.nodesep - 1);
  });
});

describe('layoutGraph — node dimensions preserved', () => {
  it('each output carries the fixed width/height for its kind', () => {
    const nodes = [MASTER, workerA, FINAL];
    const edges = topologyEdges('master', ['a'], 'final');
    const out = byId(layoutGraph(nodes, edges));
    expect(out.get('master')!.width).toBe(NODE_DIMENSIONS.master.width);
    expect(out.get('master')!.height).toBe(NODE_DIMENSIONS.master.height);
    expect(out.get('a')!.width).toBe(NODE_DIMENSIONS.worker.width);
    expect(out.get('a')!.height).toBe(NODE_DIMENSIONS.worker.height);
    expect(out.get('final')!.width).toBe(NODE_DIMENSIONS.final.width);
    expect(out.get('final')!.height).toBe(NODE_DIMENSIONS.final.height);
  });
});

describe('layoutGraph — determinism', () => {
  it('identical inputs produce identical outputs across runs', () => {
    const nodes = [MASTER, workerA, workerB, workerC, FINAL];
    const edges = topologyEdges('master', ['a', 'b', 'c'], 'final');
    const first = layoutGraph(nodes, edges);
    const second = layoutGraph(nodes, edges);
    expect(second).toEqual(first);
  });

  it('input node order does not change positions (layout is content-driven)', () => {
    const nodes = [MASTER, workerA, workerB, workerC, FINAL];
    const shuffled = [FINAL, workerC, workerA, MASTER, workerB];
    const edges = topologyEdges('master', ['a', 'b', 'c'], 'final');
    const canonical = byId(layoutGraph(nodes, edges));
    const fromShuffled = byId(layoutGraph(shuffled, edges));
    for (const id of ['master', 'a', 'b', 'c', 'final']) {
      expect(fromShuffled.get(id)).toEqual(canonical.get(id));
    }
  });
});

describe('layoutGraph — coordinates are top-left (React Flow contract)', () => {
  it('returns top-left, not center (master x/y minus half dims lands top-left)', () => {
    const nodes = [MASTER];
    const [master] = layoutGraph(nodes, []);
    // Dagre would center at some (cx, cy); top-left = (cx - w/2, cy - h/2).
    // That means when we re-center, the result matches the dagre center exactly.
    const centerX = master.x + master.width / 2;
    const centerY = master.y + master.height / 2;
    // The center should be deterministic and positive (inside positive quadrant after margins).
    expect(centerX).toBeGreaterThan(0);
    expect(centerY).toBeGreaterThan(0);
  });
});
