import { C } from '@/lib/theme';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTaskStore } from '@/stores/taskStore';

/* ── Types ─────────────────────────────────────────────── */

interface DoneViewProps {
  onNew: () => void;
}

interface MergedPR {
  number: number;
  title: string;
  branch: string;
  agent: string;
}

/* ── Helpers ───────────────────────────────────────────── */

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

/* ── Main Component ────────────────────────────────────── */

export function DoneView({ onNew }: DoneViewProps) {
  const tasks = useTaskStore((s) => s.tasks);

  const allTasks = Array.from(tasks.values());
  const completedTasks = allTasks.filter(t => t.status === 'completed');
  const uniqueAgents = new Set(allTasks.map(t => t.toolName));

  const startTimes = allTasks.map(t => t.startedAt).filter((t): t is number => t !== null);
  const totalDuration = startTimes.length > 0
    ? Date.now() - Math.min(...startTimes)
    : 0;

  const stats = [
    { label: 'Tasks', value: String(allTasks.length) },
    { label: 'Completed', value: String(completedTasks.length) },
    { label: 'Total Time', value: formatDuration(totalDuration) },
    { label: 'Agents', value: String(uniqueAgents.size) },
  ];

  const prs: MergedPR[] = completedTasks.map((t, i) => ({
    number: i + 1,
    title: t.description || t.prompt.slice(0, 50),
    branch: `wc/${t.toolName}-${t.taskId.slice(0, 6)}`,
    agent: t.toolName.charAt(0).toUpperCase() + t.toolName.slice(1),
  }));
  return (
    <ScrollArea style={{ height: '100%' }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '48px 28px',
          fontFamily: 'Inter, sans-serif',
        }}
      >
        {/* Checkmark icon */}
        <div
          style={{
            width: 80,
            height: 80,
            borderRadius: 24,
            background: C.greenBg,
            border: `2px solid ${C.greenBorder}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 24,
          }}
        >
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
            <path
              d="M12 20l6 6 12-12"
              stroke={C.green}
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        {/* Title */}
        <h2
          style={{
            fontSize: 26,
            fontWeight: 700,
            color: C.green,
            margin: 0,
            marginBottom: 8,
          }}
        >
          Orchestration Complete
        </h2>
        <p
          style={{
            fontSize: 14,
            color: C.textSecondary,
            margin: 0,
            marginBottom: 36,
          }}
        >
          All tasks have been executed, reviewed, and merged successfully.
        </p>

        {/* Stats grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 12,
            width: '100%',
            maxWidth: 640,
            marginBottom: 36,
          }}
        >
          {stats.map((stat) => (
            <div
              key={stat.label}
              style={{
                padding: '16px 12px',
                borderRadius: 16,
                background: C.surface,
                border: `1px solid ${C.border}`,
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: 22, fontWeight: 700, color: C.textPrimary, lineHeight: '30px' }}>
                {stat.value}
              </div>
              <div style={{ fontSize: 11, color: C.textSecondary, marginTop: 4 }}>
                {stat.label}
              </div>
            </div>
          ))}
        </div>

        {/* Merged PRs table */}
        <div
          style={{
            width: '100%',
            maxWidth: 640,
            borderRadius: 18,
            border: `1px solid ${C.greenBorder}`,
            overflow: 'hidden',
            marginBottom: 36,
          }}
        >
          {/* Table header */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '56px 1fr 140px 80px',
              gap: 12,
              padding: '10px 16px',
              background: C.greenBg,
              borderBottom: `1px solid ${C.greenBorder}`,
              fontSize: 11,
              fontWeight: 600,
              color: C.green,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            <span>PR</span>
            <span>Title</span>
            <span>Branch</span>
            <span>Agent</span>
          </div>

          {/* Table rows */}
          {prs.map((pr) => (
            <div
              key={pr.number}
              style={{
                display: 'grid',
                gridTemplateColumns: '56px 1fr 140px 80px',
                gap: 12,
                padding: '12px 16px',
                borderBottom: `1px solid ${C.border}`,
                alignItems: 'center',
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: C.green,
                }}
              >
                #{pr.number}
              </span>
              <span
                style={{
                  fontSize: 13,
                  color: C.textPrimary,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {pr.title}
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  color: C.textMuted,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {pr.branch}
              </span>
              <span style={{ fontSize: 12, color: C.textSecondary }}>{pr.agent}</span>
            </div>
          ))}
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 12 }}>
          <button
            type="button"
            onClick={onNew}
            style={{
              padding: '10px 24px',
              borderRadius: 14,
              background: 'linear-gradient(90deg, #6d5efc 0%, #8b5cf6 100%)',
              border: 'none',
              color: '#fff',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'Inter, sans-serif',
              boxShadow: '0 8px 24px rgba(109,94,252,0.28)',
              transition: 'all 150ms ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.filter = 'brightness(1.1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.filter = 'brightness(1)';
            }}
          >
            New Orchestration
          </button>
          <button
            type="button"
            onClick={() => {
              // placeholder for GitHub navigation
            }}
            style={{
              padding: '10px 24px',
              borderRadius: 14,
              background: 'transparent',
              border: `1px solid ${C.border}`,
              color: C.textSecondary,
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'Inter, sans-serif',
              transition: 'all 150ms ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = C.surfaceHover;
              e.currentTarget.style.borderColor = C.borderStrong;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.borderColor = C.border;
            }}
          >
            GitHub
          </button>
        </div>
      </div>
    </ScrollArea>
  );
}
