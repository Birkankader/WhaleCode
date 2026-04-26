/**
 * Phase 6 Step 3 — ThinkingPanel + ShowThinkingToggle unit tests.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

import { useGraphStore } from '../../state/graphStore';

import { ShowThinkingToggle } from './ShowThinkingToggle';
import { ThinkingPanel } from './ThinkingPanel';

beforeEach(() => {
  useGraphStore.setState({ runId: 'r-1' });
});

afterEach(() => {
  useGraphStore.getState().reset();
});

function seedThinking(
  subtaskId: string,
  chunks: ReadonlyArray<{ chunk: string; timestampMs: number }>,
) {
  const map = new Map<
    string,
    ReadonlyArray<{ chunk: string; timestampMs: number }>
  >();
  map.set(subtaskId, chunks);
  useGraphStore.setState({ subtaskThinking: map });
}

describe('ThinkingPanel — render', () => {
  it('renders empty-state placeholder when no chunks recorded', () => {
    render(<ThinkingPanel subtaskId="s-1" />);
    expect(screen.getByTestId('thinking-empty-s-1')).toBeInTheDocument();
    expect(screen.queryByTestId('thinking-list-s-1')).toBeNull();
  });

  it('renders all chunks when count <= 3 (default-collapsed limit)', () => {
    seedThinking('s-1', [
      { chunk: 'first reasoning', timestampMs: 1000 },
      { chunk: 'second reasoning', timestampMs: 1100 },
    ]);
    render(<ThinkingPanel subtaskId="s-1" />);
    const list = screen.getByTestId('thinking-list-s-1');
    expect(list.querySelectorAll('li')).toHaveLength(2);
    expect(list.textContent).toContain('first reasoning');
    expect(list.textContent).toContain('second reasoning');
    // No expand button when count fits.
    expect(screen.queryByTestId('thinking-toggle-expand-s-1')).toBeNull();
  });

  it('renders latest 3 chunks collapsed and offers expand for more', () => {
    seedThinking(
      's-1',
      Array.from({ length: 7 }, (_, i) => ({
        chunk: `chunk-${i}`,
        timestampMs: 1000 + i,
      })),
    );
    render(<ThinkingPanel subtaskId="s-1" />);
    const list = screen.getByTestId('thinking-list-s-1');
    expect(list.querySelectorAll('li')).toHaveLength(3);
    expect(list.textContent).toContain('chunk-4');
    expect(list.textContent).toContain('chunk-5');
    expect(list.textContent).toContain('chunk-6');
    // Older chunks not visible until expand.
    expect(list.textContent).not.toContain('chunk-0');

    const expand = screen.getByTestId('thinking-toggle-expand-s-1');
    expect(expand.textContent).toMatch(/Show all 7 chunks/);
    fireEvent.click(expand);
    expect(list.querySelectorAll('li')).toHaveLength(7);
    expect(list.textContent).toContain('chunk-0');
  });

  it('preserves whitespace in chunks', () => {
    seedThinking('s-1', [
      { chunk: 'line one\n  indented', timestampMs: 1000 },
    ]);
    render(<ThinkingPanel subtaskId="s-1" />);
    const li = screen.getByTestId('thinking-list-s-1').querySelector('li');
    expect(li?.className).toMatch(/whitespace-pre-wrap/);
  });
});

describe('ShowThinkingToggle — capability gating', () => {
  it('renders enabled for Claude workers', () => {
    render(<ShowThinkingToggle subtaskId="s-1" agent="claude" />);
    const btn = screen.getByTestId('thinking-toggle-s-1');
    expect(btn).not.toBeDisabled();
    expect(btn.getAttribute('data-supported')).toBe('true');
    expect(btn.getAttribute('aria-label')).toMatch(/Show thinking/);
  });

  it.each(['codex', 'gemini'] as const)(
    'renders disabled with not-available copy for %s',
    (agent) => {
      render(<ShowThinkingToggle subtaskId="s-1" agent={agent} />);
      const btn = screen.getByTestId('thinking-toggle-s-1');
      expect(btn).toBeDisabled();
      expect(btn.getAttribute('data-supported')).toBe('false');
      expect(btn.getAttribute('aria-label')).toMatch(/not available/);
    },
  );
});

describe('ShowThinkingToggle — store integration', () => {
  it('clicking adds id to workerThinkingVisible (off → on)', () => {
    render(<ShowThinkingToggle subtaskId="s-1" agent="claude" />);
    expect(useGraphStore.getState().workerThinkingVisible.has('s-1')).toBe(
      false,
    );
    fireEvent.click(screen.getByTestId('thinking-toggle-s-1'));
    expect(useGraphStore.getState().workerThinkingVisible.has('s-1')).toBe(
      true,
    );
    expect(
      screen
        .getByTestId('thinking-toggle-s-1')
        .getAttribute('aria-label'),
    ).toMatch(/Hide thinking/);
  });

  it('clicking again removes id (on → off)', () => {
    useGraphStore.setState({ workerThinkingVisible: new Set(['s-1']) });
    render(<ShowThinkingToggle subtaskId="s-1" agent="claude" />);
    fireEvent.click(screen.getByTestId('thinking-toggle-s-1'));
    expect(useGraphStore.getState().workerThinkingVisible.has('s-1')).toBe(
      false,
    );
  });

  it('toggle on Codex worker is no-op', () => {
    render(<ShowThinkingToggle subtaskId="s-1" agent="codex" />);
    fireEvent.click(screen.getByTestId('thinking-toggle-s-1'));
    expect(useGraphStore.getState().workerThinkingVisible.has('s-1')).toBe(
      false,
    );
  });

  it('per-worker independence — toggling worker A does not affect worker B', () => {
    useGraphStore.setState({ workerThinkingVisible: new Set() });
    const { rerender } = render(
      <ShowThinkingToggle subtaskId="s-A" agent="claude" />,
    );
    fireEvent.click(screen.getByTestId('thinking-toggle-s-A'));
    expect(useGraphStore.getState().workerThinkingVisible.has('s-A')).toBe(
      true,
    );
    expect(useGraphStore.getState().workerThinkingVisible.has('s-B')).toBe(
      false,
    );
    rerender(<ShowThinkingToggle subtaskId="s-B" agent="claude" />);
    fireEvent.click(screen.getByTestId('thinking-toggle-s-B'));
    expect(useGraphStore.getState().workerThinkingVisible.has('s-A')).toBe(
      true,
    );
    expect(useGraphStore.getState().workerThinkingVisible.has('s-B')).toBe(
      true,
    );
  });
});

describe('supportsThinking helper', () => {
  it('returns true for claude only', async () => {
    const { supportsThinking } = await import('../../lib/ipc');
    expect(supportsThinking('claude')).toBe(true);
    expect(supportsThinking('codex')).toBe(false);
    expect(supportsThinking('gemini')).toBe(false);
  });
});
