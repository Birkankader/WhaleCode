/**
 * Phase 6 Step 3 — per-card "Show thinking" toggle.
 *
 * Renders in the worker card footer. Capability-gated: enabled for
 * Claude workers (per `THINKING_CAPABLE_AGENTS`); disabled with a
 * tooltip on Codex / Gemini workers since those adapters emit no
 * thinking blocks (Step 0 diagnostic finding).
 *
 * Toggle state lives in `workerThinkingVisible: Set<SubtaskId>` on
 * the graph store. Default off (thinking is verbose; opt-in for
 * users who want depth). Per-worker state — toggling worker A
 * doesn't affect worker B.
 */

import { Brain } from 'lucide-react';

import { AGENT_FULL_LABEL } from '../primitives/agentColor';
import { useGraphStore } from '../../state/graphStore';
import { supportsThinking, type AgentKind } from '../../lib/ipc';

type Props = {
  subtaskId: string;
  agent: AgentKind;
};

export function ShowThinkingToggle({ subtaskId, agent }: Props) {
  const visible = useGraphStore((s) =>
    s.workerThinkingVisible.has(subtaskId),
  );
  const toggle = useGraphStore((s) => s.toggleWorkerThinking);
  const supported = supportsThinking(agent);

  const handleClick = () => {
    if (!supported) return;
    toggle(subtaskId);
  };

  const label = supported
    ? visible
      ? 'Hide thinking'
      : 'Show thinking'
    : `Thinking not available for ${AGENT_FULL_LABEL[agent]}`;

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!supported}
      aria-label={label}
      title={label}
      data-testid={`thinking-toggle-${subtaskId}`}
      data-active={supported && visible ? 'true' : 'false'}
      data-supported={supported ? 'true' : 'false'}
      className="flex h-5 w-5 items-center justify-center rounded-sm text-fg-secondary transition-colors hover:bg-bg-elev-1 hover:text-fg-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent data-[active=true]:text-fg-primary"
    >
      <Brain size={12} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}
