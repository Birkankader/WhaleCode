import type { AgentKind } from '../../state/graphStore';

export const AGENT_COLOR_VAR: Record<AgentKind, string> = {
  master: 'var(--color-agent-master)',
  claude: 'var(--color-agent-claude)',
  gemini: 'var(--color-agent-gemini)',
  codex: 'var(--color-agent-codex)',
};

export const AGENT_LABEL: Record<AgentKind, string> = {
  master: 'Master',
  claude: 'Claude',
  gemini: 'Gemini',
  codex: 'Codex',
};
