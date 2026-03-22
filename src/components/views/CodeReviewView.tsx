import { useEffect, useState, useCallback, useMemo } from 'react';
import { C } from '@/lib/theme';
import { AGENTS } from '@/lib/agents';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTaskStore, type ToolName } from '@/stores/taskStore';
import { useUIStore } from '@/stores/uiStore';
import { DiffReview } from '../../components/review/DiffReview';
import { useWorktree } from '../../hooks/useWorktree';

/* ── Types ─────────────────────────────────────────────── */

interface CodeReviewViewProps {
  onDone: () => void;
}

type WorktreeStatus = 'pending' | 'merged' | 'discarded' | 'error';

/* ── Sub-components ────────────────────────────────────── */

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div
      style={{
        flex: 1,
        padding: '16px 14px',
        borderRadius: 14,
        background: C.surface,
        border: `1px solid ${C.border}`,
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 24, fontWeight: 700, color, lineHeight: '32px' }}>{value}</div>
      <div style={{ fontSize: 11, color: C.textSecondary, marginTop: 4 }}>{label}</div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="8" cy="8" r="7" stroke={C.green} strokeWidth="1.5" />
      <path d="M5 8l2 2 4-4" stroke={C.green} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <path d="M8 2L14.93 14H1.07L8 2z" stroke={C.amber} strokeWidth="1.3" fill="none" />
      <line x1="8" y1="6.5" x2="8" y2="10" stroke={C.amber} strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="12" r="0.6" fill={C.amber} />
    </svg>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      style={{
        flexShrink: 0,
        transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: 'transform 150ms ease',
      }}
    >
      <path d="M5 3l4 4-4 4" stroke={C.textMuted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatusBadge({ status }: { status: WorktreeStatus }) {
  const config = {
    pending: { label: 'Pending', bg: C.surface, color: C.textMuted, border: C.border },
    merged: { label: 'Merged', bg: C.greenBg, color: C.green, border: C.greenBorder },
    discarded: { label: 'Discarded', bg: C.surface, color: C.textMuted, border: C.border },
    error: { label: 'Error', bg: C.redBg, color: C.red, border: C.border },
  }[status];

  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: 6,
        background: config.bg,
        color: config.color,
        border: `1px solid ${config.border}`,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}
    >
      {config.label}
    </span>
  );
}

/* ── Main Component ────────────────────────────────────── */

export function CodeReviewView({ onDone }: CodeReviewViewProps) {
  const activePlan = useTaskStore((s) => s.activePlan);
  const orchestrationPlan = useTaskStore((s) => s.orchestrationPlan);
  const tasks = useTaskStore((s) => s.tasks);
  const orchestrationLogs = useTaskStore((s) => s.orchestrationLogs);
  const setOrchestrationPhase = useTaskStore((s) => s.setOrchestrationPhase);
  const worktreeEntries = useTaskStore((s) => s.worktreeEntries);

  const projectDir = useUIStore((s) => s.projectDir);
  const { mergeWorktree, cleanupWorktrees } = useWorktree(projectDir);

  // Determine master agent from config or plan
  const masterAgent: ToolName = (orchestrationPlan?.masterAgent as ToolName)
    || (activePlan?.master_agent as ToolName)
    || 'claude';
  const icon = AGENTS[masterAgent];

  // Derive stats from tasks
  const { taskArray, tasksDone, warnings, totalTasks } = useMemo(() => {
    const arr = Array.from(tasks.values());
    let done = 0, failed = 0;
    for (const t of arr) {
      if (t.status === 'completed') done++;
      else if (t.status === 'failed') failed++;
    }
    return { taskArray: arr, tasksDone: done, warnings: failed, totalTasks: arr.length };
  }, [tasks]);

  // Extract review text from orchestration logs
  const reviewLogs = orchestrationLogs.filter(
    l => l.level === 'success' || (l.level === 'info' && l.message.includes('Review complete'))
  );
  const reviewText = reviewLogs.length > 0
    ? reviewLogs.map(l => l.message).join('\n')
    : null;

  // Build task summary rows
  const taskRows = taskArray.map(t => ({
    id: t.taskId,
    description: t.description,
    agent: t.toolName,
    status: t.status,
    isOk: t.status === 'completed',
  }));

  // Per-worktree status tracking
  const [worktreeStatuses, setWorktreeStatuses] = useState<Map<string, WorktreeStatus>>(new Map());
  const [expandedWorktree, setExpandedWorktree] = useState<string | null>(null);
  const [mergeAllInProgress, setMergeAllInProgress] = useState(false);
  const [completing, setCompleting] = useState(false);

  // Initialize worktree statuses when entries arrive
  useEffect(() => {
    if (worktreeEntries.size > 0 && worktreeStatuses.size === 0) {
      const initial = new Map<string, WorktreeStatus>();
      for (const [dagId] of worktreeEntries) {
        initial.set(dagId, 'pending');
      }
      setWorktreeStatuses(initial);
    }
  }, [worktreeEntries, worktreeStatuses.size]);

  const entries = Array.from(worktreeEntries.values());
  const pendingCount = entries.filter(e => (worktreeStatuses.get(e.dagId) ?? 'pending') === 'pending').length;
  const errorCount = entries.filter(e => worktreeStatuses.get(e.dagId) === 'error').length;
  const allHandled = entries.length > 0 && pendingCount === 0 && errorCount === 0;
  const hasWorktrees = worktreeEntries.size > 0;

  const handleWorktreeClose = useCallback((dagId: string, action: 'merged' | 'discarded') => {
    setWorktreeStatuses(prev => {
      const next = new Map(prev);
      next.set(dagId, action);
      return next;
    });
    setExpandedWorktree(null);
  }, []);

  const handleMergeAll = useCallback(async () => {
    setMergeAllInProgress(true);
    try {
      const pendingEntries = entries.filter(e => worktreeStatuses.get(e.dagId) === 'pending');
      for (const entry of pendingEntries) {
        const success = await mergeWorktree(entry.branchName);
        setWorktreeStatuses(prev => {
          const next = new Map(prev);
          next.set(entry.dagId, success ? 'merged' : 'error');
          return next;
        });
      }
    } finally {
      setMergeAllInProgress(false);
    }
  }, [entries, worktreeStatuses, mergeWorktree]);

  const handleComplete = useCallback(async () => {
    setCompleting(true);
    try {
      await cleanupWorktrees();
    } catch {
      // Cleanup failure is non-fatal
    } finally {
      setOrchestrationPhase('completed');
      onDone();
    }
  }, [cleanupWorktrees, setOrchestrationPhase, onDone]);

  const handleDirectComplete = useCallback(() => {
    setOrchestrationPhase('completed');
    onDone();
  }, [setOrchestrationPhase, onDone]);

  return (
    <ScrollArea style={{ height: '100%' }}>
      <div
        style={{
          maxWidth: 720,
          padding: '32px 28px',
          fontFamily: 'Inter, sans-serif',
        }}
      >
        {/* Header — dynamic master agent */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 24 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: icon.gradient,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 15,
              fontWeight: 700,
              color: '#fff',
              flexShrink: 0,
            }}
          >
            {icon.letter}
          </div>
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: C.textPrimary, margin: 0 }}>
              Code Review
            </h2>
            <p style={{ fontSize: 12, color: C.textSecondary, marginTop: 2, marginBottom: 0 }}>
              {icon.label} has reviewed all completed work
            </p>
          </div>
        </div>

        {/* Stats grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
          <StatCard label="Completed" value={tasksDone} color={C.green} />
          <StatCard label="Total Tasks" value={totalTasks} color={C.accentText} />
          <StatCard label="Warnings" value={warnings} color={C.amber} />
        </div>

        {/* Review summary from master agent */}
        {reviewText && (
          <div
            style={{
              padding: 16,
              borderRadius: 16,
              background: C.surface,
              border: `1px solid ${C.border}`,
              marginBottom: 24,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 12,
                fontSize: 11,
                fontWeight: 700,
                color: C.textMuted,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              <div
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  background: icon.gradient,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 9,
                  fontWeight: 700,
                  color: '#fff',
                }}
              >
                {icon.letter}
              </div>
              {icon.label}&apos;s Review
            </div>
            <div
              style={{
                fontSize: 13,
                color: C.textPrimary,
                lineHeight: '22px',
                whiteSpace: 'pre-wrap',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {reviewText}
            </div>
          </div>
        )}

        {/* Task results table */}
        {taskRows.length > 0 && (
          <div
            style={{
              borderRadius: 16,
              border: `1px solid ${C.border}`,
              overflow: 'hidden',
              marginBottom: 24,
            }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '28px 1fr 1fr',
                gap: 12,
                padding: '10px 16px',
                background: C.surface,
                borderBottom: `1px solid ${C.border}`,
                fontSize: 11,
                fontWeight: 600,
                color: C.textMuted,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              <span />
              <span>Task</span>
              <span>Agent / Status</span>
            </div>
            {taskRows.map((row) => {
              const agentIcon = AGENTS[row.agent] ?? AGENTS.claude;
              return (
                <div
                  key={row.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '28px 1fr 1fr',
                    gap: 12,
                    padding: '12px 16px',
                    borderBottom: `1px solid ${C.border}`,
                    alignItems: 'center',
                  }}
                >
                  {row.isOk ? <CheckIcon /> : <WarningIcon />}
                  <span
                    style={{
                      fontSize: 12,
                      fontFamily: 'var(--font-mono)',
                      color: C.textPrimary,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {row.description}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 4,
                        background: agentIcon.gradient,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 8,
                        fontWeight: 700,
                        color: '#fff',
                        flexShrink: 0,
                      }}
                    >
                      {agentIcon.letter}
                    </div>
                    <span style={{ fontSize: 12, color: C.textSecondary, lineHeight: '18px' }}>
                      {agentIcon.label} — {row.status}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Per-Worktree Review Section ────────────────── */}
        {hasWorktrees ? (
          <div style={{ marginBottom: 24 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: C.textMuted,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                marginBottom: 12,
              }}
            >
              Worktree Changes ({entries.length})
            </div>

            {entries.map((entry) => {
              const status = worktreeStatuses.get(entry.dagId) ?? 'pending';
              const isExpanded = expandedWorktree === entry.dagId;
              const isHandled = status !== 'pending';

              return (
                <div
                  key={entry.dagId}
                  style={{
                    borderRadius: 14,
                    border: `1px solid ${C.border}`,
                    marginBottom: 10,
                    overflow: 'hidden',
                    opacity: isHandled ? 0.6 : 1,
                    transition: 'opacity 150ms ease',
                  }}
                >
                  {/* Worktree card header */}
                  <button
                    type="button"
                    onClick={() => setExpandedWorktree(isExpanded ? null : entry.dagId)}
                    disabled={isHandled}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '12px 16px',
                      background: C.surface,
                      border: 'none',
                      cursor: isHandled ? 'default' : 'pointer',
                      textAlign: 'left',
                      fontFamily: 'Inter, sans-serif',
                      transition: 'background 150ms ease',
                      outline: 'revert',
                    }}
                    onMouseEnter={(e) => {
                      if (!isHandled) e.currentTarget.style.background = C.surfaceHover;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = C.surface;
                    }}
                  >
                    <ChevronIcon expanded={isExpanded} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, marginBottom: 2 }}>
                        {entry.branchName}
                      </div>
                      <div style={{ fontSize: 11, color: C.textSecondary, display: 'flex', gap: 10 }}>
                        <span>{entry.fileCount} file{entry.fileCount !== 1 ? 's' : ''}</span>
                        <span style={{ color: C.green }}>+{entry.additions}</span>
                        <span style={{ color: '#f87171' }}>-{entry.deletions}</span>
                      </div>
                    </div>
                    <StatusBadge status={status} />
                  </button>

                  {/* Expanded diff viewer */}
                  {isExpanded && !isHandled && projectDir && (
                    <div style={{ height: 480, borderTop: `1px solid ${C.border}` }}>
                      <DiffReview
                        projectDir={projectDir}
                        branchName={entry.branchName}
                        taskId={entry.dagId}
                        onClose={(action) => handleWorktreeClose(entry.dagId, action)}
                      />
                    </div>
                  )}
                </div>
              );
            })}

            {/* Batch merge controls */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 10,
                marginTop: 16,
              }}
            >
              {pendingCount > 0 && (
                <button
                  type="button"
                  onClick={handleMergeAll}
                  disabled={mergeAllInProgress}
                  style={{
                    padding: '8px 20px',
                    borderRadius: 12,
                    background: icon.gradient,
                    border: 'none',
                    color: '#fff',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: mergeAllInProgress ? 'not-allowed' : 'pointer',
                    fontFamily: 'Inter, sans-serif',
                    boxShadow: '0 8px 24px rgba(109,94,252,0.28)',
                    opacity: mergeAllInProgress ? 0.6 : 1,
                    transition: 'all 150ms ease',
                  }}
                  onMouseEnter={(e) => {
                    if (!mergeAllInProgress) e.currentTarget.style.filter = 'brightness(1.1)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.filter = 'brightness(1)';
                  }}
                >
                  {mergeAllInProgress ? 'Merging…' : `Merge All (${pendingCount})`}
                </button>
              )}

              {allHandled && (
                <button
                  type="button"
                  onClick={handleComplete}
                  disabled={completing}
                  style={{
                    padding: '8px 20px',
                    borderRadius: 12,
                    background: C.green,
                    border: 'none',
                    color: '#fff',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: completing ? 'not-allowed' : 'pointer',
                    fontFamily: 'Inter, sans-serif',
                    opacity: completing ? 0.6 : 1,
                    transition: 'all 150ms ease',
                  }}
                >
                  {completing ? 'Cleaning up…' : 'Done'}
                </button>
              )}
            </div>
          </div>
        ) : (
          /* ── Zero worktreeEntries: direct completion path ── */
          <div style={{ marginBottom: 24 }}>
            <div
              style={{
                padding: 16,
                borderRadius: 16,
                background: C.surface,
                border: `1px solid ${C.border}`,
                textAlign: 'center',
              }}
            >
              <p style={{ fontSize: 13, color: C.textSecondary, margin: 0, marginBottom: 12 }}>
                No file changes to review
              </p>
              <button
                type="button"
                onClick={handleDirectComplete}
                style={{
                  padding: '8px 20px',
                  borderRadius: 12,
                  background: icon.gradient,
                  border: 'none',
                  color: '#fff',
                  fontSize: 13,
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
                Complete
              </button>
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
