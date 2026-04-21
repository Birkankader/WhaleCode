const AGENTS_READY: readonly string[] = ['claude-code', 'gemini-cli', 'codex-cli'];
const LAST_RUN = 'Last run: 2h ago · $0.24';

export function Footer() {
  const left = `${AGENTS_READY.length} agents ready · ${AGENTS_READY.join(' · ')}`;
  return (
    <footer
      className="flex h-8 shrink-0 items-center justify-between border-t border-border-subtle px-4 text-hint text-fg-tertiary"
      role="contentinfo"
    >
      <span>{left}</span>
      <span>{LAST_RUN}</span>
    </footer>
  );
}
