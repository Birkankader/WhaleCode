import { useEffect, useMemo, useState } from 'react';
import { C, STATUS } from '@/lib/theme';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTaskStore } from '@/stores/taskStore';
import { useUIStore } from '@/stores/uiStore';
import { commands } from '@/bindings';
import { TaskHeaderBar, TaskIdentity } from './task-detail/TaskHeader';
import { TaskActions } from './task-detail/TaskActions';
import { AgentActivityPanel } from '@/components/shared/AgentActivityPanel';
import type { TaskDisplayData } from './task-detail/TaskHeader';

/* ── Types ─────────────────────────────────────────────── */

interface TaskDetailProps {
  taskId: string;
  onClose: () => void;
}

/* ── Helpers ───────────────────────────────────────────── */

function resolveStatusKey(status: string): string {
  if (status === 'pending' || status === 'routing' || status === 'waiting') return 'queued';
  if (status === 'running' || status === 'falling_back') return 'running';
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'blocked') return 'blocked';
  if (status === 'retrying') return 'retrying';
  if (status === 'review') return 'review';
  return 'idle';
}

function branchNameForTask(toolName: string, taskId: string): string {
  return `whalecode/task/${toolName}-${taskId.slice(0, 6)}`;
}

/* ── Main Component ────────────────────────────────────── */

export function TaskDetail({ taskId, onClose }: TaskDetailProps) {
  const task = useTaskStore((s) => s.tasks.get(taskId));
  const projectDir = useUIStore((s) => s.projectDir);
  const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null);

  // Check if the project directory is a git repo
  useEffect(() => {
    if (!projectDir) {
      setIsGitRepo(false);
      return;
    }
    commands.gitStatus(projectDir).then((result) => {
      setIsGitRepo(result.status === 'ok');
    }).catch(() => {
      setIsGitRepo(false);
    });
  }, [projectDir]);

  // Derive display data from real task
  const display = useMemo((): TaskDisplayData | null => {
    if (!task) return null;
    const stKey = resolveStatusKey(task.status);
    const st = STATUS[stKey] ?? STATUS.idle;
    return {
      title: task.description || task.prompt.slice(0, 60),
      prompt: task.prompt,
      id: task.taskId,
      agent: task.toolName,
      status: task.status,
      statusLabel: st.label,
      statusDot: st.dot,
      statusBg: st.bg,
      statusText: st.text,
      branch: branchNameForTask(task.toolName, task.taskId),
      displayBranch: `wc/${task.toolName}-${task.taskId.slice(0, 6)}`,
      startedAt: task.startedAt,
      isRunning: task.status === 'running',
      isDone: task.status === 'completed' || task.status === 'waiting',
      role: task.role,
      resultSummary: task.resultSummary,
    };
  }, [task]);

  if (!display) {
    return (
      <div style={{ width: 340, borderLeft: `1px solid ${C.border}`, background: C.panel, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: C.textMuted, fontSize: 13 }}>Task not found</span>
      </div>
    );
  }

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'Inter, sans-serif',
        background: C.panel,
        borderLeft: `1px solid ${C.border}`,
      }}
    >
      {/* Header bar (outside scroll) */}
      <TaskHeaderBar onClose={onClose} />

      <ScrollArea style={{ flex: 1 }}>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Task identity: status, title, agent card, result */}
          <TaskIdentity display={display} />

          {/* Real-time agent activity (only for running tasks) */}
          <AgentActivityPanel taskId={taskId} />

          {/* Action sections: retry, branch, progress, diff, merge, reassign */}
          <TaskActions
            taskId={taskId}
            display={display}
            projectDir={projectDir}
            isGitRepo={isGitRepo}
            onClose={onClose}
          />
        </div>
      </ScrollArea>
    </div>
  );
}
