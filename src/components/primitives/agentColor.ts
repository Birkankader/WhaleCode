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

/** Full CLI names — used in TopBar and Footer where space is not constrained. */
export const AGENT_FULL_LABEL: Record<AgentKind, string> = {
  master: 'Master',
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
  codex: 'Codex CLI',
};
