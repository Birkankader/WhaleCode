import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { C } from '@/lib/theme';
import { AGENTS } from '@/lib/agents';
import { humanizeError } from '@/lib/humanizeError';
import { removeTaskWithUndo } from '@/lib/undoableActions';
import { useTaskStore, type ToolName } from '@/stores/taskStore';
import { useTaskDispatch } from '@/hooks/useTaskDispatch';
import { useConfirmDialog } from '@/components/shared/ConfirmDialog';
import { commands } from '@/bindings';
import type { FileDiff } from '@/bindings';
import type { TaskDisplayData } from './TaskHeader';
import { InlineDiffView } from './DiffViewer';

/* ── Constants ─────────────────────────────────────────── */

const REASSIGN_OPTIONS: ToolName[] = ['claude', 'gemini', 'codex'];

/* ── Types ─────────────────────────────────────────────── */

interface TaskActionsProps {
  taskId: string;
  display: TaskDisplayData;
  projectDir: string | null;
  isGitRepo: boolean | null;
  onClose: () => void;
}

/* ── Component ─────────────────────────────────────────── */

export function TaskActions({ taskId, display, projectDir, isGitRepo, onClose }: TaskActionsProps) {
  const task = useTaskStore((s) => s.tasks.get(taskId));
  const updateTaskAgent = useTaskStore((s) => s.updateTaskAgent);
  const updateTaskStatus = useTaskStore((s) => s.updateTaskStatus);
  const { dispatchTask } = useTaskDispatch();
  const { confirm, ConfirmDialogElement } = useConfirmDialog();
  const [reassignOpen, setReassignOpen] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeSuccess, setMergeSuccess] = useState(false);
  const [diffFiles, setDiffFiles] = useState<FileDiff[] | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const handleReassign = useCallback((newAgent: ToolName) => {
    setReassignOpen(false);
    updateTaskAgent(taskId, newAgent);
    useTaskStore.getState().addOrchestrationLog({
      agent: newAgent,
      level: 'info',
      message: `Task ${taskId.slice(0, 6)} reassigned to ${AGENTS[newAgent].label}`,
    });
  }, [taskId, updateTaskAgent]);

  const handleMerge = useCallback(async () => {
    if (!projectDir || !display) return;
    const ok = await confirm({
      title: 'Merge Branch',
      description: `Merge branch "${display.displayBranch}" into main? This cannot be undone.`,
      confirmLabel: 'Merge',
      destructive: false,
    });
    if (!ok) return;
    setMerging(true);
    setMergeError(null);
    try {
      const result = await commands.mergeWorktree(projectDir, display.branch, null);
      if (result.status === 'ok') {
        setMergeSuccess(true);
        updateTaskStatus(taskId, 'completed' as any);
        useTaskStore.getState().addOrchestrationLog({
          agent: display.agent,
          level: 'success',
          message: `Branch ${display.displayBranch} merged into main`,
        });
        toast.success('Branch merged successfully');
      } else {
        setMergeError(result.error);
        toast.error('Merge failed');
      }
    } catch (e) {
      setMergeError(String(e));
      toast.error('Merge failed');
    } finally {
      setMerging(false);
    }
  }, [projectDir, display, taskId, updateTaskStatus, confirm]);

  const handleViewChanges = useCallback(async () => {
    if (!projectDir || !display) return;
    if (diffFiles) {
      setDiffFiles(null);
      return;
    }
    setDiffLoading(true);
    setDiffError(null);
    try {
      const result = await commands.getWorktreeDiff(projectDir, display.branch);
      if (result.status === 'ok') {
        setDiffFiles(result.data.files);
      } else {
        setDiffError(result.error);
      }
    } catch (e) {
      setDiffError(String(e));
    } finally {
      setDiffLoading(false);
    }
  }, [projectDir, display, diffFiles]);

  const handleRetry = useCallback(async () => {
    if (!projectDir || !task || retrying) return;
    const ok = await confirm({
      title: 'Retry Task',
      description: `Retry this task with ${AGENTS[task.toolName].label}? The failed task will be removed.`,
      confirmLabel: 'Retry',
      destructive: true,
    });
    if (!ok) return;
    setRetrying(true);
    try {
      useTaskStore.getState().addOrchestrationLog({
        agent: task.toolName,
        level: 'info',
        message: `Retrying: ${task.description}`,
      });
      // Dispatch new task first — only remove old one on success
      const newTaskId = await dispatchTask(task.prompt, projectDir, task.toolName);

      if (newTaskId) {
        // Remove old failed task with undo support
        removeTaskWithUndo(taskId, task.description);

        // Mark retried task as worker
        const ts = useTaskStore.getState();
        const newTask = ts.tasks.get(newTaskId);
        if (newTask) {
          const newTasks = new Map(ts.tasks);
          newTasks.set(newTask.taskId, { ...newTask, role: 'worker' });
          useTaskStore.setState({ tasks: newTasks });
        }
      }
      toast.success('Task retried');
      onClose();
    } catch (e) {
      console.error('Retry failed:', e);
      toast.error('Retry failed');
      useTaskStore.getState().addOrchestrationLog({
        agent: task.toolName,
        level: 'error',
        message: `Retry failed: ${e}`,
      });
    } finally {
      setRetrying(false);
    }
  }, [projectDir, task, taskId, retrying, dispatchTask, onClose, confirm]);

  const handleCancel = useCallback(async () => {
    if (!task || cancelling) return;
    const ok = await confirm({
      title: 'Cancel Task',
      description: `Cancel the running task "${task.description}"? The agent process will be terminated.`,
      confirmLabel: 'Cancel Task',
      destructive: true,
    });
    if (!ok) return;
    setCancelling(true);
    try {
      const result = await commands.cancelProcess(task.taskId);
      if (result.status === 'ok') {
        updateTaskStatus(taskId, 'failed' as any);
        useTaskStore.getState().addOrchestrationLog({
          agent: task.toolName,
          level: 'warn',
          message: `Task cancelled by user: ${task.description}`,
        });
        toast.success('Task cancelled');
      } else {
        toast.error('Failed to cancel task', { description: humanizeError(result.error) });
      }
    } catch (e) {
      toast.error('Failed to cancel task', { description: humanizeError(e) });
    } finally {
      setCancelling(false);
    }
  }, [task, taskId, cancelling, updateTaskStatus, confirm]);

  const progress = display.isRunning && display.startedAt
    ? Math.min(95, Math.floor(((Date.now() - display.startedAt) / 120_000) * 100))
    : null;

  return (
    <>
      {ConfirmDialogElement}

      {/* Cancel card — only show for running tasks */}
      {display.isRunning && (
        <div
          style={{
            padding: 16,
            borderRadius: 14,
            background: C.amberBg,
            border: `1px solid ${C.amberBorder}`,
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: C.amber,
              marginBottom: 8,
            }}
          >
            Task Running
          </div>
          <p
            style={{
              fontSize: 12,
              color: C.textSecondary,
              margin: 0,
              marginBottom: 14,
              lineHeight: '18px',
            }}
          >
            This task is currently being processed. You can cancel it to stop the agent.
          </p>
          <button
            type="button"
            disabled={cancelling}
            onClick={handleCancel}
            style={{
              padding: '8px 20px',
              borderRadius: 10,
              background: cancelling ? C.borderStrong : C.red,
              border: 'none',
              color: '#fff',
              fontSize: 13,
              fontWeight: 700,
              cursor: cancelling ? 'wait' : 'pointer',
              fontFamily: 'Inter, sans-serif',
              transition: 'all 150ms ease',
              opacity: cancelling ? 0.7 : 1,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
            onMouseEnter={(e) => {
              if (!cancelling) e.currentTarget.style.filter = 'brightness(1.15)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.filter = 'brightness(1)';
            }}
          >
            {cancelling ? 'Cancelling...' : '✕ Cancel Task'}
          </button>
        </div>
      )}

      {/* Retry card — only show for failed tasks */}
      {display.status === 'failed' && projectDir && (
        <div
          style={{
            padding: 16,
            borderRadius: 14,
            background: C.redBg,
            border: `1px solid rgba(239,68,68,0.3)`,
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: '#f87171',
              marginBottom: 8,
            }}
          >
            Task Failed
          </div>
          <p
            style={{
              fontSize: 12,
              color: C.textSecondary,
              margin: 0,
              marginBottom: 14,
              lineHeight: '18px',
            }}
          >
            This task failed. You can retry with the same agent or reassign to a different one below.
          </p>
          <button
            type="button"
            disabled={retrying}
            onClick={handleRetry}
            style={{
              padding: '8px 20px',
              borderRadius: 10,
              background: retrying ? C.borderStrong : '#ef4444',
              border: 'none',
              color: '#fff',
              fontSize: 13,
              fontWeight: 700,
              cursor: retrying ? 'wait' : 'pointer',
              fontFamily: 'Inter, sans-serif',
              transition: 'all 150ms ease',
              opacity: retrying ? 0.7 : 1,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
            onMouseEnter={(e) => {
              if (!retrying) e.currentTarget.style.filter = 'brightness(1.15)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.filter = 'brightness(1)';
            }}
          >
            {retrying ? 'Retrying...' : '\u21BB Retry Task'}
          </button>
        </div>
      )}

      {/* Branch — only show if project is a git repo */}
      {isGitRepo && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 12,
            background: C.surface,
            border: `1px solid ${C.border}`,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: C.textMuted,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: 6,
            }}
          >
            Branch
          </div>
          <div
            style={{
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
              color: C.accentText,
            }}
          >
            {display.displayBranch}
          </div>
        </div>
      )}

      {/* Progress bar (if running) */}
      {progress !== null && (
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 11,
              color: C.textSecondary,
              marginBottom: 6,
            }}
          >
            <span>Progress</span>
            <span>{progress}%</span>
          </div>
          <div
            style={{
              width: '100%',
              height: 6,
              borderRadius: 3,
              background: C.border,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: '100%',
                borderRadius: 3,
                background: C.amber,
                transition: 'width 300ms ease',
              }}
            />
          </div>
        </div>
      )}

      {/* View Changes button (when done or running, and project is a git repo) */}
      {(display.isDone || display.isRunning) && projectDir && isGitRepo && (
        <div>
          <button
            type="button"
            onClick={handleViewChanges}
            disabled={diffLoading}
            style={{
              width: '100%',
              padding: '10px 14px',
              borderRadius: 12,
              background: C.surface,
              border: `1px solid ${C.border}`,
              color: C.accentText,
              fontSize: 12,
              fontWeight: 600,
              fontFamily: 'Inter, sans-serif',
              cursor: diffLoading ? 'wait' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              transition: 'all 150ms ease',
              opacity: diffLoading ? 0.6 : 1,
            }}
            onMouseEnter={(e) => {
              if (!diffLoading) e.currentTarget.style.borderColor = C.accent;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = C.border;
            }}
          >
            {diffLoading ? 'Loading diff...' : diffFiles ? 'Hide Changes' : 'View Changes'}
          </button>
          {diffError && (
            <div style={{ marginTop: 6, fontSize: 11, color: '#f87171' }}>{diffError}</div>
          )}
        </div>
      )}

      {/* Inline diff viewer */}
      {diffFiles && diffFiles.length > 0 && (
        <InlineDiffView files={diffFiles} onClose={() => setDiffFiles(null)} />
      )}
      {diffFiles && diffFiles.length === 0 && (
        <div
          style={{
            padding: 16,
            borderRadius: 14,
            background: C.surface,
            border: `1px solid ${C.border}`,
            textAlign: 'center',
            color: C.textMuted,
            fontSize: 12,
          }}
        >
          No changes detected in this branch yet.
        </div>
      )}

      {/* Awaiting merge card (if done and git repo) */}
      {display.isDone && !mergeSuccess && isGitRepo && (
        <div
          style={{
            padding: 16,
            borderRadius: 14,
            background: C.greenBg,
            border: `1px solid ${C.greenBorder}`,
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: C.green,
              marginBottom: 10,
            }}
          >
            Awaiting Merge
          </div>
          <p
            style={{
              fontSize: 12,
              color: C.textSecondary,
              margin: 0,
              marginBottom: 14,
              lineHeight: '18px',
            }}
          >
            This task is complete and its branch is ready to be merged into main.
          </p>
          {mergeError && (
            <p
              style={{
                fontSize: 11,
                color: '#f87171',
                margin: 0,
                marginBottom: 10,
                lineHeight: '16px',
                padding: '6px 10px',
                borderRadius: 8,
                background: 'rgba(248,113,113,0.1)',
              }}
            >
              {mergeError}
            </p>
          )}
          <button
            type="button"
            disabled={merging || !projectDir}
            onClick={handleMerge}
            style={{
              padding: '8px 20px',
              borderRadius: 10,
              background: merging ? C.borderStrong : C.green,
              border: 'none',
              color: '#052e16',
              fontSize: 13,
              fontWeight: 700,
              cursor: merging ? 'wait' : 'pointer',
              fontFamily: 'Inter, sans-serif',
              transition: 'all 150ms ease',
              opacity: merging ? 0.7 : 1,
            }}
            onMouseEnter={(e) => {
              if (!merging) e.currentTarget.style.filter = 'brightness(1.1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.filter = 'brightness(1)';
            }}
          >
            {merging ? 'Merging...' : 'Merge Branch'}
          </button>
        </div>
      )}

      {/* Merge success */}
      {mergeSuccess && (
        <div
          style={{
            padding: 16,
            borderRadius: 14,
            background: C.greenBg,
            border: `1px solid ${C.greenBorder}`,
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: C.green }}>
            Branch merged successfully
          </div>
        </div>
      )}

      {/* Reassign dropdown */}
      <div>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: C.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            marginBottom: 8,
          }}
        >
          Reassign Agent
        </div>
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setReassignOpen(!reassignOpen)}
            style={{
              width: '100%',
              padding: '10px 14px',
              borderRadius: 12,
              background: C.surface,
              border: `1px solid ${C.border}`,
              color: C.textPrimary,
              fontSize: 13,
              fontFamily: 'Inter, sans-serif',
              textAlign: 'left',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              transition: 'all 150ms ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = C.borderStrong;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = C.border;
            }}
          >
            <span>{AGENTS[display.agent].label}</span>
            <span style={{ fontSize: 10, color: C.textMuted }}>
              {reassignOpen ? '\u25B2' : '\u25BC'}
            </span>
          </button>

          {reassignOpen && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                marginTop: 4,
                borderRadius: 12,
                background: C.surface,
                border: `1px solid ${C.borderStrong}`,
                boxShadow: '0 12px 36px rgba(0,0,0,0.5)',
                zIndex: 10,
                overflow: 'hidden',
              }}
            >
              {REASSIGN_OPTIONS.filter((t) => t !== display.agent).map((toolName) => {
                const icon = AGENTS[toolName];
                return (
                  <button
                    key={toolName}
                    type="button"
                    onClick={() => handleReassign(toolName)}
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      background: 'transparent',
                      border: 'none',
                      borderBottom: `1px solid ${C.border}`,
                      color: C.textPrimary,
                      fontSize: 13,
                      fontFamily: 'Inter, sans-serif',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'background 150ms ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = C.surfaceHover;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <div
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 7,
                        background: icon.gradient,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 10,
                        fontWeight: 700,
                        color: '#fff',
                        flexShrink: 0,
                      }}
                    >
                      {icon.letter}
                    </div>
                    {AGENTS[toolName].label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
