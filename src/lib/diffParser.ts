/**
 * Parse a unified diff blob into typed display rows for the diff
 * preview UI (`InlineDiffSidebar` / `DiffBody`).
 *
 * Drops the `diff --git` / `index` / `--- a/` / `+++ b/` preamble (the
 * filename is already in the row header) and flattens each hunk into a
 * sequence of context / add / remove / hunk rows with the +/- marker
 * stripped from `text`. `\ No newline at end of file` is preserved as a
 * context row so it doesn't disappear silently.
 */
export type DiffRowKind = 'hunk' | 'context' | 'add' | 'remove';

export type DiffRow = {
  kind: DiffRowKind;
  /** Line content with the leading +/-/space marker removed. */
  text: string;
};

export function parseUnifiedDiff(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const lines = patch.split('\n');
  let inHunk = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    // Skip trailing empty line produced by final `\n`.
    if (i === lines.length - 1 && line === '') continue;
    if (line.startsWith('@@')) {
      rows.push({ kind: 'hunk', text: line });
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'remove', text: line.slice(1) });
    } else if (line.startsWith(' ')) {
      rows.push({ kind: 'context', text: line.slice(1) });
    } else if (line.startsWith('\\')) {
      rows.push({ kind: 'context', text: line });
    }
    // Unknown prefix: skip silently (defensive).
  }
  return rows;
}
