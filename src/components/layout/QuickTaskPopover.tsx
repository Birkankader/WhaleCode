import { useState, useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { humanizeError } from '@/lib/humanizeError';
import { useTaskStore, type ToolName } from '@/stores/taskStore';
import { useTaskDispatch } from '@/hooks/useTaskDispatch';
import { useUIStore } from '@/stores/uiStore';

/**
 * Quick Task popover — dropdown for dispatching ad-hoc tasks to agents.
 * Supports click-outside-to-close and Escape key.
 */
export function QuickTaskPopover() {
  const showQuickTask = useUIStore((s) => s.showQuickTask);
  const setShowQuickTask = useUIStore((s) => s.setShowQuickTask);
  const projectDir = useUIStore((s) => s.projectDir);
  const orchestrationPlan = useTaskStore((s) => s.orchestrationPlan);

  const [quickPrompt, setQuickPrompt] = useState('');
  const [quickAgent, setQuickAgent] = useState<ToolName>('claude');
  const [quickSubmitting, setQuickSubmitting] = useState(false);
  const { dispatchTask } = useTaskDispatch();

  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Sync quickAgent default when orchestrationPlan becomes available
  useEffect(() => {
    if (orchestrationPlan?.masterAgent) {
      setQuickAgent(orchestrationPlan.masterAgent);
    }
  }, [orchestrationPlan?.masterAgent]);

  // Click outside to close
  useEffect(() => {
    if (!showQuickTask) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        setShowQuickTask(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showQuickTask, setShowQuickTask]);

  const handleQuickTask = useCallback(async () => {
    if (!quickPrompt.trim() || !projectDir || quickSubmitting) return;
    setQuickSubmitting(true);
    try {
      const taskId = await dispatchTask(quickPrompt.trim(), projectDir, quickAgent);
      if (taskId) {
        const taskState = useTaskStore.getState();
        const task = taskState.tasks.get(taskId) ?? Array.from(taskState.tasks.values()).find(t => t.prompt === quickPrompt.trim());
        if (task) {
          const newTasks = new Map(taskState.tasks);
          newTasks.set(task.taskId, { ...task, role: 'worker' });
          useTaskStore.setState({ tasks: newTasks });
        }
      }
      setQuickPrompt('');
      setShowQuickTask(false);
      toast.success('Task dispatched', { description: quickPrompt.trim().slice(0, 80) });
      useTaskStore.getState().addOrchestrationLog({
        agent: quickAgent,
        level: 'cmd',
        message: `New task dispatched: ${quickPrompt.trim().slice(0, 80)}`,
      });
    } catch (e) {
      console.error('Quick task failed:', e);
      toast.error('Task failed', { description: humanizeError(e) });
      useTaskStore.getState().addOrchestrationLog({
        agent: quickAgent,
        level: 'error',
        message: `Task failed: ${e}`,
      });
    } finally {
      setQuickSubmitting(false);
    }
  }, [quickPrompt, projectDir, quickAgent, quickSubmitting, dispatchTask, setShowQuickTask]);

  if (!projectDir) return null;

  return (
    <div className="relative ml-2">
      <button
        ref={triggerRef}
        onClick={() => setShowQuickTask(!showQuickTask)}
        className={`flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-xs font-semibold transition-all border ${
          showQuickTask
            ? 'bg-wc-accent text-white border-wc-accent'
            : 'bg-wc-surface text-wc-text-secondary border-wc-border-strong'
        }`}
      >
        <span className="text-sm leading-none">+</span>
        <span>New Task</span>
      </button>

      {showQuickTask && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Quick task"
          className="absolute top-full left-0 mt-2 z-50 flex flex-col gap-2.5 p-3.5 rounded-xl w-[380px] bg-wc-panel border border-wc-border-strong shadow-[0_12px_40px_rgba(0,0,0,0.6)]"
        >
          <div className="text-xs font-bold text-wc-text-muted uppercase tracking-wide">
            Quick Task
          </div>
          <div className="flex items-center gap-2">
            <select
              aria-label="Select agent"
              value={quickAgent}
              onChange={(e) => setQuickAgent(e.target.value as ToolName)}
              className="text-xs rounded-lg px-2 py-1.5 bg-wc-surface text-wc-text-primary border border-wc-border outline-none"
            >
              <option value="claude">Claude</option>
              <option value="gemini">Gemini</option>
              <option value="codex">Codex</option>
            </select>
            <input
              aria-label="Task description"
              autoFocus
              type="text"
              value={quickPrompt}
              onChange={(e) => setQuickPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleQuickTask(); if (e.key === 'Escape') setShowQuickTask(false); }}
              placeholder="Describe the task..."
              className="flex-1 text-xs rounded-lg px-2.5 py-1.5 bg-wc-surface text-wc-text-primary border border-wc-border outline-none"
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-wc-text-muted">
              {projectDir.split('/').pop()}
            </span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-wc-text-muted">
                Enter to send
              </span>
              <button
                onClick={handleQuickTask}
                disabled={!quickPrompt.trim() || quickSubmitting}
                className={`text-xs font-semibold px-4 py-1.5 rounded-lg transition-all ${
                  quickPrompt.trim()
                    ? 'bg-wc-accent text-white'
                    : 'bg-wc-border-strong text-wc-text-muted'
                } ${quickSubmitting ? 'opacity-50' : ''}`}
              >
                {quickSubmitting ? 'Sending...' : 'Run'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
