import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseUnifiedDiff } from '../../lib/diffParser';
import type { FileDiff } from '../../lib/ipc';
import { DiffPopover } from './DiffPopover';

/**
 * Shiki needs WebAssembly + async dynamic imports that don't resolve
 * cleanly under jsdom. Every DiffPopover test stubs the helper module
 * so we can (a) verify the grammar load is only kicked off on expand,
 * and (b) synchronously drive "ready" / "plain" transitions.
 *
 * The mock returns lightweight stand-ins whose shape matches the
 * component's narrow surface (HighlighterLike + TokenizedLine).
 */
const loadLanguage = vi.fn();
const tokenizeCode = vi.fn();

vi.mock('../../lib/shikiHighlighter', () => ({
  detectLanguage: (path: string) => {
    if (path.endsWith('.ts')) return 'typescript';
    if (path.endsWith('.rs')) return 'rust';
    return null;
  },
  loadLanguage: (...args: unknown[]) => loadLanguage(...args),
  tokenizeCode: (...args: unknown[]) => tokenizeCode(...args),
}));

// @tanstack/react-virtual relies on ResizeObserver / requestAnimationFrame
// which jsdom has but they don't measure real sizes — default behaviour
// still renders overscan items, which is enough for "is this row in the
// DOM?" assertions.
beforeEach(() => {
  loadLanguage.mockReset();
  tokenizeCode.mockReset();
});

afterEach(() => {
  loadLanguage.mockReset();
  tokenizeCode.mockReset();
});

function fd(partial: Partial<FileDiff> & Pick<FileDiff, 'path'>): FileDiff {
  return {
    additions: 0,
    deletions: 0,
    ...partial,
  };
}

describe('DiffPopover — collapsed/expanded rows', () => {
  it('renders one header per file, all collapsed on mount', () => {
    const files: FileDiff[] = [
      fd({ path: 'src/a.ts', additions: 3, deletions: 1 }),
      fd({ path: 'src/b.ts', additions: 0, deletions: 2 }),
    ];
    render(<DiffPopover files={files} onClose={() => {}} />);
    const headers = screen.getAllByTestId('diff-file-header');
    expect(headers).toHaveLength(2);
    // Stats visible on the collapsed header.
    expect(headers[0]!.textContent).toMatch(/\+3/);
    expect(headers[0]!.textContent).toMatch(/−1/);
    // No body rendered yet.
    expect(screen.queryByTestId('diff-body')).toBeNull();
    expect(screen.queryByTestId('diff-body-binary')).toBeNull();
  });

  it('clicking a header expands that file and loads the grammar', async () => {
    loadLanguage.mockResolvedValue(null); // force plain-text fallback so we don't
    //   exercise tokenization details here
    const files: FileDiff[] = [
      fd({
        path: 'src/a.ts',
        additions: 1,
        deletions: 0,
        status: { kind: 'modified' },
        unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n',
      }),
    ];
    render(<DiffPopover files={files} onClose={() => {}} />);
    const header = screen.getByTestId('diff-file-header');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    // DiffBody is lazy-loaded via React.lazy; wait for the chunk + state.
    await screen.findByTestId('diff-body');
    expect(loadLanguage).toHaveBeenCalledWith('typescript');
  });

  it('clicking an expanded header collapses it', async () => {
    loadLanguage.mockResolvedValue(null);
    const files: FileDiff[] = [
      fd({
        path: 'src/a.ts',
        additions: 1,
        deletions: 0,
        unifiedDiff: '@@ -1 +1 @@\n+x\n',
      }),
    ];
    render(<DiffPopover files={files} onClose={() => {}} />);
    const header = screen.getByTestId('diff-file-header');
    fireEvent.click(header);
    await screen.findByTestId('diff-body');
    fireEvent.click(header);
    expect(screen.queryByTestId('diff-body')).toBeNull();
  });

  it('does not load the grammar until a file is expanded', () => {
    const files: FileDiff[] = [
      fd({
        path: 'src/a.ts',
        additions: 1,
        deletions: 0,
        unifiedDiff: '@@ -1 +1 @@\n+x\n',
      }),
    ];
    render(<DiffPopover files={files} onClose={() => {}} />);
    expect(loadLanguage).not.toHaveBeenCalled();
  });
});

describe('DiffPopover — status variants', () => {
  it('renames show "old → new" with a "renamed" badge', () => {
    const files: FileDiff[] = [
      fd({
        path: 'src/new.ts',
        status: { kind: 'renamed', from: 'src/old.ts' },
      }),
    ];
    render(<DiffPopover files={files} onClose={() => {}} />);
    const header = screen.getByTestId('diff-file-header');
    expect(header.textContent).toMatch(/src\/old\.ts/);
    expect(header.textContent).toMatch(/→/);
    expect(header.textContent).toMatch(/src\/new\.ts/);
    expect(header.textContent?.toLowerCase()).toMatch(/renamed/);
  });

  it('added files carry a "new" badge', () => {
    const files: FileDiff[] = [
      fd({ path: 'src/a.ts', additions: 10, status: { kind: 'added' } }),
    ];
    render(<DiffPopover files={files} onClose={() => {}} />);
    expect(screen.getByTestId('diff-file-header').textContent?.toLowerCase()).toMatch(/new/);
  });

  it('deleted files carry a "removed" badge', () => {
    const files: FileDiff[] = [
      fd({ path: 'src/a.ts', deletions: 10, status: { kind: 'deleted' } }),
    ];
    render(<DiffPopover files={files} onClose={() => {}} />);
    expect(screen.getByTestId('diff-file-header').textContent?.toLowerCase()).toMatch(/removed/);
  });

  it('binary files short-circuit the body (no Shiki load)', async () => {
    const files: FileDiff[] = [
      fd({
        path: 'assets/logo.png',
        status: { kind: 'binary' },
        unifiedDiff: '',
      }),
    ];
    render(<DiffPopover files={files} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('diff-file-header'));
    const body = await screen.findByTestId('diff-body-binary');
    expect(body.textContent?.toLowerCase()).toMatch(/binary/);
    expect(loadLanguage).not.toHaveBeenCalled();
  });

  it('modified files (no status field) render without a badge', () => {
    const files: FileDiff[] = [fd({ path: 'src/a.ts', additions: 1 })];
    render(<DiffPopover files={files} onClose={() => {}} />);
    const header = screen.getByTestId('diff-file-header');
    const header_text = header.textContent?.toLowerCase() ?? '';
    expect(header_text).not.toMatch(/\b(new|removed|renamed|binary)\b/);
  });
});

describe('DiffPopover — plain-text fallback', () => {
  it('unsupported extensions skip the grammar loader and tokenizer', async () => {
    const files: FileDiff[] = [
      fd({
        path: 'docs/NOTES', // no extension
        additions: 1,
        deletions: 0,
        unifiedDiff: '@@ -1 +1 @@\n+note\n',
      }),
    ];
    render(<DiffPopover files={files} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('diff-file-header'));
    const body = await screen.findByTestId('diff-body');
    expect(body.getAttribute('data-lang')).toBe('plain');
    expect(body.getAttribute('data-highlight-state')).toBe('plain');
    expect(loadLanguage).not.toHaveBeenCalled();
    expect(tokenizeCode).not.toHaveBeenCalled();
  });

  it('supported extension tokenises via Shiki once loaded', async () => {
    const highlighter = {} as never;
    loadLanguage.mockResolvedValue(highlighter);
    tokenizeCode.mockReturnValue([[{ content: 'new', color: '#fff' }]]);
    const files: FileDiff[] = [
      fd({
        path: 'src/a.ts',
        additions: 1,
        deletions: 0,
        unifiedDiff: '@@ -1 +1 @@\n+new\n',
      }),
    ];
    render(<DiffPopover files={files} onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('diff-file-header'));
    // Wait for the async setState after the grammar resolves.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const body = screen.getByTestId('diff-body');
    expect(body.getAttribute('data-lang')).toBe('typescript');
    expect(body.getAttribute('data-highlight-state')).toBe('ready');
    expect(tokenizeCode).toHaveBeenCalledTimes(1);
  });
});

describe('parseUnifiedDiff', () => {
  it('extracts hunks, context, adds, and removes in order', () => {
    const patch =
      'diff --git a/x b/x\n' +
      'index 0000..1111 100644\n' +
      '--- a/x\n' +
      '+++ b/x\n' +
      '@@ -1,3 +1,3 @@\n' +
      ' context-1\n' +
      '-removed\n' +
      '+added\n' +
      ' context-2\n';
    const rows = parseUnifiedDiff(patch);
    expect(rows.map((r) => r.kind)).toEqual([
      'hunk',
      'context',
      'remove',
      'add',
      'context',
    ]);
    expect(rows[0]!.text).toBe('@@ -1,3 +1,3 @@');
    expect(rows[1]!.text).toBe('context-1');
    expect(rows[2]!.text).toBe('removed');
    expect(rows[3]!.text).toBe('added');
  });

  it('preserves "\\ No newline at end of file" as context', () => {
    const patch = '@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n';
    const rows = parseUnifiedDiff(patch);
    const last = rows[rows.length - 1]!;
    expect(last.kind).toBe('context');
    expect(last.text).toMatch(/No newline/);
  });

  it('ignores lines before the first @@ hunk header', () => {
    const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n+only\n';
    const rows = parseUnifiedDiff(patch);
    expect(rows.map((r) => r.kind)).toEqual(['hunk', 'add']);
  });
});

describe('DiffPopover — expand state scoping', () => {
  it('expanding one file does not expand its siblings', async () => {
    loadLanguage.mockResolvedValue(null);
    const files: FileDiff[] = [
      fd({ path: 'src/a.ts', unifiedDiff: '@@ -1 +1 @@\n+a\n' }),
      fd({ path: 'src/b.ts', unifiedDiff: '@@ -1 +1 @@\n+b\n' }),
    ];
    render(<DiffPopover files={files} onClose={() => {}} />);
    const [first, second] = screen.getAllByTestId('diff-file-header');
    fireEvent.click(first!);
    await screen.findByTestId('diff-body');
    expect(first!.getAttribute('aria-expanded')).toBe('true');
    expect(second!.getAttribute('aria-expanded')).toBe('false');
  });
});
