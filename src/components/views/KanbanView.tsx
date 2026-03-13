import { useMemo } from 'react';
import { C, STATUS } from '@/lib/theme';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTaskStore, type TaskEntry, type ToolName } from '@/stores/taskStore';

/* ── Types ─────────────────────────────────────────────── */

interface KanbanViewProps {
  selectedTask: string | null;
  setSelectedTask: (id: string) => void;
}

type ColumnKey = 'queued' | 'running' | 'done';

interface ColumnDef {
  key: ColumnKey;
  label: string;
  statusKey: keyof typeof STATUS;
}

interface MappedTask {
  id: string;
  title: string;
  agent: ToolName;
  column: ColumnKey;
  startedAt: number | null;
  duration: string | null;
  progress: number | null;
  branch: string;
  status: TaskEntry['status'];
}

/* ── Constants ─────────────────────────────────────────── */

const COLUMNS: ColumnDef[] = [
  { key: 'queued', label: 'Queued', statusKey: 'queued' },
  { key: 'running', label: 'In Progress', statusKey: 'running' },
  { key: 'done', label: 'Done', statusKey: 'done' },
];

const AGENT_ICON: Record<ToolName, { letter: string; gradient: string }> = {
  claude: { letter: 'C', gradient: 'linear-gradient(135deg, #6d5efc 0%, #8b5cf6 100%)' },
  gemini: { letter: 'G', gradient: 'linear-gradient(135deg, #0ea5e9 0%, #38bdf8 100%)' },
  codex: { letter: 'X', gradient: 'linear-gradient(135deg, #22c55e 0%, #4ade80 100%)' },
};

const AGENT_LABEL: Record<ToolName, string> = {
  claude: 'Claude',
  gemini: 'Gemini',
  codex: 'Codex',
};

/* ── Helpers ───────────────────────────────────────────── */

function mapColumn(status: TaskEntry['status']): ColumnKey {
  switch (status) {
    case 'pending':
    case 'routing':
    case 'waiting':
    case 'blocked':
      return 'queued';
    case 'running':
    case 'retrying':
    case 'falling_back':
      return 'running';
    case 'completed':
    case 'review':
    case 'failed':
      return 'done';
    default:
      return 'queued';
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/* ── Sub-components ────────────────────────────────────── */

function StatusDot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        display: 'inline-block',
        flexShrink: 0,
      }}
    />
  );
}

function Pill({ children, bg, color }: { children: React.ReactNode; bg: string; color: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 999,
        background: bg,
        color,
        fontSize: 11,
        fontWeight: 600,
        fontFamily: 'Inter, sans-serif',
        lineHeight: '18px',
      }}
    >
      {children}
    </span>
  );
}

function TaskCard({
  task,
  selected,
  onClick,
}: {
  task: MappedTask;
  selected: boolean;
  onClick: () => void;
}) {
  const agent = AGENT_ICON[task.agent];

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%',
        textAlign: 'left',
        padding: 14,
        borderRadius: 16,
        background: C.surface,
        border: `1.5px solid ${selected ? C.accent : C.border}`,
        cursor: 'pointer',
        transition: 'all 150ms ease',
        opacity: task.status === 'blocked' ? 0.6 : 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        fontFamily: 'Inter, sans-serif',
      }}
    >
      {/* Title */}
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: C.textPrimary,
          lineHeight: '20px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {task.title}
      </span>

      {/* Agent row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            width: 20,
            height: 20,
            borderRadius: 6,
            background: agent.gradient,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 10,
            fontWeight: 700,
            color: '#fff',
            flexShrink: 0,
          }}
        >
          {agent.letter}
        </div>
        <span style={{ fontSize: 12, color: C.textSecondary }}>{AGENT_LABEL[task.agent]}</span>
      </div>

      {/* Status badges for special states */}
      {task.status === 'blocked' && (
        <Pill bg="rgba(239,68,68,0.15)" color="#ef4444">
          <span style={{ fontSize: 10 }}>&#x1F512;</span> Blocked
        </Pill>
      )}
      {task.status === 'retrying' && (
        <Pill bg="rgba(245,158,11,0.15)" color="#f59e0b">
          <span style={{ fontSize: 10 }}>{'\u21BB'}</span> Retrying
        </Pill>
      )}
      {task.status === 'falling_back' && (
        <Pill bg="rgba(168,85,247,0.15)" color="#a855f7">
          <span style={{ fontSize: 10 }}>{'\u21C4'}</span> Reassigning
        </Pill>
      )}

      {/* Progress bar (running) */}
      {task.progress !== null && (
        <div
          style={{
            width: '100%',
            height: 4,
            borderRadius: 2,
            background: C.border,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${task.progress}%`,
              height: '100%',
              borderRadius: 2,
              background: C.amber,
              transition: 'width 300ms ease',
            }}
          />
        </div>
      )}

      {/* Duration (done) */}
      {task.duration && (
        <span style={{ fontSize: 11, color: C.textMuted }}>{task.duration}</span>
      )}

      {/* Branch */}
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
        {task.branch}
      </span>
    </button>
  );
}

/* ── Main Component ────────────────────────────────────── */

export function KanbanView({ selectedTask, setSelectedTask }: KanbanViewProps) {
  const tasks = useTaskStore((s) => s.tasks);

  const mapped: MappedTask[] = useMemo(() => {
    const result: MappedTask[] = [];
    for (const [, task] of tasks) {
      const col = mapColumn(task.status);
      const now = Date.now();
      const elapsed = task.startedAt ? now - task.startedAt : 0;
      const isRunning = col === 'running';
      const isDone = col === 'done';

      result.push({
        id: task.taskId,
        title: task.description || task.prompt.slice(0, 60),
        agent: task.toolName,
        column: col,
        startedAt: task.startedAt,
        duration: isDone && task.startedAt ? formatDuration(elapsed) : null,
        progress: isRunning ? Math.min(95, Math.floor((elapsed / 120_000) * 100)) : null,
        branch: `wc/${task.toolName}-${task.taskId.slice(0, 6)}`,
        status: task.status,
      });
    }
    return result;
  }, [tasks]);

  const byColumn = useMemo(() => {
    const map: Record<ColumnKey, MappedTask[]> = { queued: [], running: [], done: [] };
    for (const t of mapped) {
      map[t.column].push(t);
    }
    return map;
  }, [mapped]);

  return (
    <div
      style={{
        display: 'flex',
        gap: 16,
        height: '100%',
        padding: 20,
        fontFamily: 'Inter, sans-serif',
      }}
    >
      {COLUMNS.map((col) => {
        const items = byColumn[col.key];
        const st = STATUS[col.statusKey];

        return (
          <div
            key={col.key}
            style={{
              flex: 1,
              minWidth: 220,
              display: 'flex',
              flexDirection: 'column',
              borderRadius: 20,
              border: `1px solid ${C.border}`,
              background: C.panel,
              overflow: 'hidden',
            }}
          >
            {/* Column header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '14px 16px',
                borderBottom: `1px solid ${C.border}`,
              }}
            >
              <StatusDot color={st.dot} />
              <span style={{ fontSize: 13, fontWeight: 600, color: st.text }}>{col.label}</span>
              <Pill bg={st.bg} color={st.text}>
                {items.length}
              </Pill>
            </div>

            {/* Cards */}
            <ScrollArea style={{ flex: 1, padding: 12 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {items.length === 0 ? (
                  <div
                    style={{
                      padding: '24px 16px',
                      textAlign: 'center',
                      fontSize: 12,
                      color: C.textMuted,
                      border: `1.5px dashed ${C.border}`,
                      borderRadius: 14,
                    }}
                  >
                    No tasks
                  </div>
                ) : (
                  items.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      selected={selectedTask === task.id}
                      onClick={() => setSelectedTask(task.id)}
                    />
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        );
      })}
    </div>
  );
}
