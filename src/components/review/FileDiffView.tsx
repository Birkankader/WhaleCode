interface FileDiffViewProps {
  patch: string;
}

/**
 * Renders a unified diff patch with line-level coloring.
 *
 * Line coloring by prefix:
 * - `+` lines: green text on green bg/20
 * - `-` lines: red text on red bg/20
 * - `@@` lines: cyan
 * - `diff`, `index`, `---`, `+++` header lines: muted zinc-500
 * - Context lines: zinc-300
 */
export function FileDiffView({ patch }: FileDiffViewProps) {
  if (!patch || patch.trim().length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        No diff available
      </div>
    );
  }

  const lines = patch.split('\n');

  return (
    <div className="overflow-auto h-full font-mono text-xs leading-5">
      {lines.map((line, i) => {
        let className = 'px-3 whitespace-pre text-zinc-300';

        // Check multi-char header prefixes first (before single-char +/-)
        if (
          line.startsWith('diff ') ||
          line.startsWith('index ') ||
          line.startsWith('--- ') ||
          line.startsWith('+++ ')
        ) {
          className = 'px-3 whitespace-pre text-zinc-500';
        } else if (line.startsWith('@@')) {
          className = 'px-3 whitespace-pre text-cyan-400';
        } else if (line.startsWith('+')) {
          className = 'px-3 whitespace-pre text-green-400 bg-green-900/20';
        } else if (line.startsWith('-')) {
          className = 'px-3 whitespace-pre text-red-400 bg-red-900/20';
        }

        return (
          <div key={i} className={className}>
            {line}
          </div>
        );
      })}
    </div>
  );
}
