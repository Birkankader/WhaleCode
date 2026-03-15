import { AGENTS } from '@/lib/agents';
import type { ToolName } from '@/stores/taskStore';

interface AgentBadgeProps {
  agent: ToolName;
  size?: 'sm' | 'md' | 'lg';
}

const SIZES = {
  sm: { box: 20, radius: 6, font: 9 },
  md: { box: 28, radius: 8, font: 12 },
  lg: { box: 36, radius: 10, font: 14 },
};

/**
 * Reusable agent icon badge with gradient background and letter.
 * Replaces 7+ inline implementations across the codebase.
 */
export function AgentBadge({ agent, size = 'md' }: AgentBadgeProps) {
  const info = AGENTS[agent];
  const s = SIZES[size];

  return (
    <div
      style={{
        width: s.box,
        height: s.box,
        borderRadius: s.radius,
        background: info.gradient,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: s.font,
        fontWeight: 700,
        color: '#fff',
        flexShrink: 0,
      }}
    >
      {info.letter}
    </div>
  );
}

interface StatusPillProps {
  status: string;
  dot: string;
  label: string;
  bg: string;
}

/**
 * Reusable status pill with colored dot and label.
 * Replaces 4+ inline implementations across the codebase.
 */
export function StatusPill({ dot, label, bg }: StatusPillProps) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 10px',
        borderRadius: 999,
        background: bg,
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: dot,
          flexShrink: 0,
        }}
      />
      <span style={{ color: dot }}>{label}</span>
    </span>
  );
}
