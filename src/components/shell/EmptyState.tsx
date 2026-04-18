import { useState, type FormEvent, type KeyboardEvent } from 'react';

import { runMockOrchestration } from '../../lib/mockOrchestration';
import { useGraphStore } from '../../state/graphStore';

const TITLE = 'WhaleCode';
const TAGLINE = 'Your AI team, orchestrated visually';
const PLACEHOLDER = 'What should the team build?';
const SHORTCUTS: readonly string[] = ['⌘K', '⌘H', '⌘T', '⌘,'];

export function EmptyState() {
  const submitTask = useGraphStore((s) => s.submitTask);
  const setOrchestrationCancel = useGraphStore((s) => s.setOrchestrationCancel);
  const [value, setValue] = useState('');

  function launch(trimmed: string) {
    submitTask(trimmed);
    const handle = runMockOrchestration(trimmed, useGraphStore);
    setOrchestrationCancel(handle.cancel);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    launch(trimmed);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const trimmed = value.trim();
      if (!trimmed) return;
      launch(trimmed);
    }
  }

  return (
    <div className="flex h-full w-full items-center justify-center px-6">
      <form onSubmit={handleSubmit} className="flex w-full max-w-[560px] flex-col items-center">
        <h1 className="text-title font-medium text-fg-primary" style={{ letterSpacing: '0.5px' }}>
          {TITLE}
        </h1>
        <p className="mt-2 text-meta text-fg-tertiary">{TAGLINE}</p>

        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={PLACEHOLDER}
          autoFocus
          className="mt-12 w-full rounded-lg border border-border-default bg-bg-elevated px-5 py-[18px] text-[20px] text-fg-primary placeholder:text-fg-secondary focus:border-[var(--color-agent-master)] focus:outline-none"
          aria-label={PLACEHOLDER}
        />

        <div className="mt-3 flex items-center gap-2 text-hint text-fg-tertiary">
          <KeyChip>Enter</KeyChip>
          <span>to start</span>
        </div>

        <div className="mt-8 flex items-center gap-2">
          {SHORTCUTS.map((s) => (
            <KeyChip key={s}>{s}</KeyChip>
          ))}
        </div>
      </form>
    </div>
  );
}

function KeyChip({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center rounded-sm border border-border-default bg-bg-elevated px-1.5 py-0.5 text-hint text-fg-secondary">
      {children}
    </span>
  );
}
