import type { ToolName } from '@/stores/taskStore';

export function asToolName(name: string): ToolName {
  if (name === 'claude' || name === 'gemini' || name === 'codex') return name;
  console.warn(`Unknown tool name "${name}", falling back to claude`);
  return 'claude';
}

export const AGENTS: Record<ToolName, {
  label: string;
  letter: string;
  gradient: string;
  color: string;
}> = {
  claude: {
    label: 'Claude Code',
    letter: 'C',
    gradient: 'linear-gradient(135deg, #6d5efc 0%, #8b5cf6 100%)',
    color: '#8b5cf6',
  },
  gemini: {
    label: 'Gemini CLI',
    letter: 'G',
    gradient: 'linear-gradient(135deg, #0ea5e9 0%, #38bdf8 100%)',
    color: '#38bdf8',
  },
  codex: {
    label: 'Codex CLI',
    letter: 'X',
    gradient: 'linear-gradient(135deg, #22c55e 0%, #4ade80 100%)',
    color: '#4ade80',
  },
} as const;

/** Safe agent lookup — returns claude as fallback for unknown agent names. */
export function getAgent(name: string) {
  return AGENTS[name as ToolName] ?? AGENTS.claude;
}
