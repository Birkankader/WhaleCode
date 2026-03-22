import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronUp, ChevronDown, Plus, FileCode2, GitBranch } from 'lucide-react';
import { toast } from 'sonner';
import { C } from '@/lib/theme';
import { AGENTS } from '@/lib/agents';
import { useTaskStore, type ToolName } from '@/stores/taskStore';
import { useUIStore } from '@/stores/uiStore';
import { commands } from '@/bindings';

const AGENT_OPTIONS: ToolName[] = ['claude', 'gemini', 'codex'];

/** Extract file-like tokens from a prompt string (e.g., src/foo.ts, lib/bar.rs) */
function extractFilePills(text: string): string[] {
  const filePattern = /(?:^|\s)((?:[\w./-]+\/)?[\w.-]+\.(?:ts|tsx|js|jsx|rs|py|go|java|css|html|json|toml|yaml|yml|md|sql|sh))\b/g;
  const matches = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = filePattern.exec(text)) !== null) {
    matches.add(m[1]);
  }
  return Array.from(matches).slice(0, 5); // limit to 5 pills
}

interface EditableTask {
  id: string;
  description: string;
  prompt: string;
  agent: ToolName;
  removed: boolean;
  dependsOn: string | null;
}

export function TaskApprovalView() {
  const tasks = useTaskStore((s) => s.tasks);
  const activePlan = useTaskStore((s) => s.activePlan);
  const orchestrationPhase = useTaskStore((s) => s.orchestrationPhase);
  const autoApprove = useUIStore((s) => s.autoApprove);
  const setAutoApprove = useUIStore((s) => s.setAutoApprove);
  const [approving, setApproving] = useState(false);
  const [visible, setVisible] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTaskPrompt, setNewTaskPrompt] = useState('');
  const [newTaskAgent, setNewTaskAgent] = useState<ToolName>('claude');
  const addInputRef = useRef<HTMLTextAreaElement>(null);

  // Get worker tasks that are pending approval
  const workerTasks = useMemo(() => {
    const workers: EditableTask[] = [];
    for (const [id, task] of tasks) {
      if (task.role === 'worker' && task.status === 'pending') {
        workers.push({
          id,
          description: task.description,
          prompt: task.prompt,
          agent: task.toolName,
          removed: false,
          dependsOn: task.dependsOn,
        });
      }
    }
    return workers;
  }, [tasks]);

  const [editedTasks, setEditedTasks] = useState<EditableTask[] | null>(null);
  const displayTasks = editedTasks ?? workerTasks;

  // Sync editedTasks when new worker tasks arrive during approval phase.
  // Without this, only the first task_assigned event populates the list.
  useEffect(() => {
    if (orchestrationPhase === 'awaiting_approval' && workerTasks.length > 0) {
      setEditedTasks(prev => {
        // If no edits yet, or if new tasks arrived that aren't in the edit list
        if (!prev || prev.length < workerTasks.length) {
          // Preserve any user edits on existing tasks, append new ones
          const existingIds = new Set(prev?.map(t => t.id) ?? []);
          const preserved = prev ?? [];
          const newTasks = workerTasks.filter(t => !existingIds.has(t.id));
          return [...preserved, ...newTasks];
        }
        return prev;
      });
    }
  }, [orchestrationPhase, workerTasks]);

  // Animate modal entry
  const isOpen = orchestrationPhase === 'awaiting_approval' && displayTasks.length > 0;
  const [countdown, setCountdown] = useState<number | null>(null);

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => setVisible(true));
      // Start countdown only if auto-approve is enabled
      if (autoApprove) {
        setCountdown(5);
      }
    } else {
      setVisible(false);
      setCountdown(null);
      setEditedTasks(null); // Reset for next session
    }
  }, [isOpen, autoApprove]);

  // Countdown timer — auto-approves when reaching 0
  useEffect(() => {
    if (countdown === null || countdown <= 0) return;
    const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  // Auto-approve when countdown reaches 0
  useEffect(() => {
    if (countdown === 0 && isOpen && !approving) {
      handleApprove();
    }
  }, [countdown, isOpen, approving]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus the add-task textarea when form opens
  useEffect(() => {
    if (showAddForm && addInputRef.current) {
      addInputRef.current.focus();
    }
  }, [showAddForm]);

  const handleAgentChange = useCallback((idx: number, newAgent: ToolName) => {
    setCountdown(null); // Cancel auto-approve on edit
    setEditedTasks(prev => {
      if (!prev) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], agent: newAgent };
      // Also update in task store
      useTaskStore.getState().updateTaskAgent(next[idx].id, newAgent);
      return next;
    });
  }, []);

  const handleToggleRemove = useCallback((idx: number) => {
    setCountdown(null);
    setEditedTasks(prev => {
      if (!prev) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], removed: !next[idx].removed };
      return next;
    });
  }, []);

  const handleMoveUp = useCallback((idx: number) => {
    setCountdown(null);
    if (idx === 0) return;
    setEditedTasks(prev => {
      if (!prev) return prev;
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return next;
    });
  }, []);

  const handleMoveDown = useCallback((idx: number) => {
    setCountdown(null);
    setEditedTasks(prev => {
      if (!prev) return prev;
      if (idx >= prev.length - 1) return prev;
      const next = [...prev];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      return next;
    });
  }, []);

  const handleAddTask = useCallback(() => {
    setCountdown(null);
    if (!newTaskPrompt.trim()) return;
    const newId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const desc = newTaskPrompt.trim();

    // Add to task store
    useTaskStore.getState().addTask({
      taskId: newId,
      prompt: desc,
      toolName: newTaskAgent,
      status: 'pending',
      description: desc.length > 60 ? desc.slice(0, 57) + '...' : desc,
      startedAt: null,
      dependsOn: null,
      role: 'worker',
    });

    // Add to local edited list
    setEditedTasks(prev => [
      ...(prev ?? []),
      { id: newId, description: desc, prompt: desc, agent: newTaskAgent, removed: false, dependsOn: null },
    ]);

    setNewTaskPrompt('');
    setNewTaskAgent('claude');
    setShowAddForm(false);
    toast.success('Sub-task added');
  }, [newTaskPrompt, newTaskAgent]);

  const handleApprove = useCallback(async () => {
    if (!activePlan || approving) return;
    setApproving(true);
    try {
      // Remove tasks that were marked for removal
      const removedIds = displayTasks.filter(t => t.removed).map(t => t.id);
      for (const id of removedIds) {
        useTaskStore.getState().removeTask(id);
      }

      // Build modified task list for backend
      const modifiedTasks = displayTasks
        .filter(t => !t.removed)
        .map(t => ({
          agent: t.agent,
          prompt: t.prompt,
          description: t.description.length > 60 ? t.description.slice(0, 57) + '...' : t.description,
          depends_on: t.dependsOn ? [t.dependsOn] : ([] as string[]),
        }));

      await commands.approveOrchestration(activePlan.task_id, modifiedTasks);
      toast.success('Tasks approved -- execution starting');
    } catch (e) {
      console.error('Approval failed:', e);
      toast.error('Approval failed');
    } finally {
      setApproving(false);
    }
  }, [activePlan, approving, displayTasks]);

  // Dismiss on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Cancel auto-approve countdown and hide overlay
        // (overlay stays mounted but pointer-events: none prevents blocking)
        setCountdown(null);
        setVisible(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const activeCount = displayTasks.filter(t => !t.removed).length;

  // Compute agent distribution summary
  const agentCounts = new Map<ToolName, number>();
  for (const t of displayTasks) {
    if (!t.removed) {
      agentCounts.set(t.agent, (agentCounts.get(t.agent) ?? 0) + 1);
    }
  }
  const agentSummary = Array.from(agentCounts.entries())
    .map(([agent, count]) => `${count}x ${AGENTS[agent].label.split(' ')[0]}`)
    .join(', ');

  // Build dependency lookup: id -> index (1-based)
  const idToIndex = new Map<string, number>();
  displayTasks.forEach((t, i) => idToIndex.set(t.id, i + 1));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Review Sub-Tasks"
      className="fixed inset-0 z-[90] flex items-start justify-center pt-[8vh] transition-[background,backdrop-filter] duration-200 ease-out"
      style={{
        background: visible ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0)',
        backdropFilter: visible ? 'blur(3px)' : 'blur(0px)',
        pointerEvents: visible ? 'auto' : 'none',
      }}
    >
      <div
        className="w-[580px] max-h-[85vh] rounded-[20px] flex flex-col overflow-hidden shadow-[0_20px_60px_rgba(0,0,0,0.7)] transition-[transform,opacity] duration-200 ease-out"
        style={{
          background: C.panel,
          border: `1px solid ${C.borderStrong}`,
          transform: visible ? 'scale(1)' : 'scale(0.95)',
          opacity: visible ? 1 : 0,
        }}
      >
        {/* Header with summary */}
        <div className="pt-5 px-6 pb-4" style={{ borderBottom: `1px solid ${C.border}` }}>
          <div className="flex items-center justify-between">
            <h2 className="m-0 text-base font-bold" style={{ color: C.textPrimary }}>
              Review Sub-Tasks
            </h2>
            {/* Auto-approve toggle */}
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <span className="text-[11px]" style={{ color: C.textMuted }}>Auto-approve</span>
              <button
                type="button"
                onClick={() => setAutoApprove(!autoApprove)}
                className="w-8 h-4 rounded-lg border-none px-0.5 cursor-pointer flex items-center transition-[background] duration-150 ease-in-out"
                style={{ background: autoApprove ? C.accent : C.borderStrong }}
              >
                <div
                  className="w-3 h-3 rounded-full bg-white transition-[margin-left] duration-150 ease-in-out"
                  style={{ marginLeft: autoApprove ? 'auto' : '0' }}
                />
              </button>
            </label>
          </div>

          {/* Summary bar */}
          <div className="mt-2.5 flex items-center gap-2.5">
            <span className="text-xs" style={{ color: C.textSecondary }}>
              {activeCount} task{activeCount !== 1 ? 's' : ''}: {agentSummary}
            </span>
          </div>

          {/* Agent distribution bar */}
          {activeCount > 0 && (
            <div
              className="mt-2 h-1 rounded-sm overflow-hidden flex"
              style={{ background: C.borderStrong }}
            >
              {Array.from(agentCounts.entries()).map(([agent, count]) => (
                <div
                  key={agent}
                  style={{
                    width: `${(count / activeCount) * 100}%`,
                    height: '100%',
                    background: AGENTS[agent].color,
                    transition: 'width 200ms ease',
                  }}
                />
              ))}
            </div>
          )}

          <p className="mt-2 mb-0 text-[11px] leading-4" style={{ color: C.textMuted }}>
            Reorder, reassign agents, add or remove tasks before execution.
          </p>
        </div>

        {/* Task list */}
        <div className="flex-1 overflow-y-auto py-3 px-6">
          {displayTasks.map((task, idx) => {
            const agent = AGENTS[task.agent];
            const filePills = extractFilePills(task.description);
            const depIndex = task.dependsOn ? idToIndex.get(task.dependsOn) : null;

            return (
              <div
                key={task.id}
                className="p-3 py-3 px-3.5 rounded-xl mb-2 transition-all duration-150 ease-in-out"
                style={{
                  background: task.removed ? 'rgba(248,113,113,0.06)' : C.surface,
                  border: `1px solid ${task.removed ? 'rgba(248,113,113,0.2)' : C.border}`,
                  opacity: task.removed ? 0.45 : 1,
                }}
              >
                {/* Top row: reorder + badge + description + controls */}
                <div className="flex items-center gap-2.5">
                  {/* Reorder buttons */}
                  <div className="flex flex-col gap-px shrink-0">
                    <button
                      type="button"
                      onClick={() => handleMoveUp(idx)}
                      disabled={idx === 0}
                      className="w-[18px] h-[14px] rounded-[3px] bg-transparent border-none flex items-center justify-center p-0 transition-colors duration-100 ease-in-out"
                      style={{
                        color: idx === 0 ? C.textMuted + '40' : C.textMuted,
                        cursor: idx === 0 ? 'default' : 'pointer',
                      }}
                      title="Move up"
                    >
                      <ChevronUp size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMoveDown(idx)}
                      disabled={idx === displayTasks.length - 1}
                      className="w-[18px] h-[14px] rounded-[3px] bg-transparent border-none flex items-center justify-center p-0 transition-colors duration-100 ease-in-out"
                      style={{
                        color: idx === displayTasks.length - 1 ? C.textMuted + '40' : C.textMuted,
                        cursor: idx === displayTasks.length - 1 ? 'default' : 'pointer',
                      }}
                      title="Move down"
                    >
                      <ChevronDown size={12} />
                    </button>
                  </div>

                  {/* Agent badge with gradient */}
                  <div
                    className="w-[30px] h-[30px] rounded-lg flex items-center justify-center text-xs font-bold text-white shrink-0"
                    style={{ background: agent.gradient }}
                  >
                    {agent.letter}
                  </div>

                  {/* Task content */}
                  <div className="flex-1 min-w-0">
                    {/* Task number */}
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.04em]" style={{ color: C.textMuted }}>
                        Task {idx + 1} of {displayTasks.length}
                      </span>
                      {depIndex != null && (
                        <span
                          className="text-[9px] font-semibold rounded px-[5px] py-px inline-flex items-center gap-[3px]"
                          style={{
                            color: C.amber,
                            background: C.amberBg,
                            border: `1px solid ${C.amberBorder}`,
                          }}
                        >
                          <GitBranch size={8} />
                          Depends on Task {depIndex}
                        </span>
                      )}
                    </div>
                    {/* Description — editable */}
                    <input
                      type="text"
                      value={task.description}
                      onChange={(e) => {
                        setCountdown(null);
                        setEditedTasks(prev => {
                          if (!prev) return prev;
                          const next = [...prev];
                          next[idx] = { ...next[idx], description: e.target.value };
                          return next;
                        });
                      }}
                      className="text-xs leading-[18px] w-full bg-transparent border-none outline-none p-0"
                      style={{
                        color: task.removed ? C.textMuted : C.textPrimary,
                        textDecoration: task.removed ? 'line-through' : 'none',
                      }}
                      disabled={task.removed}
                    />

                    {/* Full prompt — visible below description */}
                    {!task.removed && task.prompt !== task.description && (
                        <textarea
                          value={task.prompt}
                          onChange={(e) => {
                            setCountdown(null);
                            setEditedTasks(prev => {
                              if (!prev) return prev;
                              const next = [...prev];
                              next[idx] = { ...next[idx], prompt: e.target.value };
                              return next;
                            });
                          }}
                          rows={3}
                          style={{
                            width: '100%',
                            marginTop: 6,
                            padding: '8px 10px',
                            borderRadius: 8,
                            background: C.panel,
                            border: `1px solid ${C.border}`,
                            color: C.textSecondary,
                            fontSize: 11,
                            lineHeight: '16px',
                            fontFamily: 'var(--font-mono)',
                            resize: 'vertical',
                            outline: 'none',
                          }}
                          onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
                          onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
                        />
                    )}
                  </div>

                  {/* Agent selector */}
                  {!task.removed && (
                    <select
                      value={task.agent}
                      onChange={(e) => handleAgentChange(idx, e.target.value as ToolName)}
                      style={{
                        padding: '4px 8px',
                        borderRadius: 8,
                        background: C.surfaceHover,
                        border: `1px solid ${C.border}`,
                        color: C.textSecondary,
                        fontSize: 11,
                        fontFamily: 'Inter, sans-serif',
                        cursor: 'pointer',
                        outline: 'none',
                        flexShrink: 0,
                      }}
                    >
                      {AGENT_OPTIONS.map(a => (
                        <option key={a} value={a}>{AGENTS[a].label}</option>
                      ))}
                    </select>
                  )}

                  {/* Remove toggle */}
                  <button
                    type="button"
                    onClick={() => handleToggleRemove(idx)}
                    className="w-7 h-7 rounded-lg border-none text-sm cursor-pointer flex items-center justify-center shrink-0 font-[Inter,sans-serif] transition-all duration-150 ease-in-out"
                    style={{
                      background: task.removed ? 'rgba(74,222,128,0.1)' : 'rgba(248,113,113,0.1)',
                      color: task.removed ? C.green : C.red,
                    }}
                    title={task.removed ? 'Restore task' : 'Remove task'}
                  >
                    {task.removed ? '\u21B6' : '\u2715'}
                  </button>
                </div>

                {/* File pills (scope indicator) */}
                {filePills.length > 0 && !task.removed && (
                  <div className="flex flex-wrap gap-1 mt-2 pl-[58px]">
                    {filePills.map(file => (
                      <span
                        key={file}
                        className="inline-flex items-center gap-[3px] text-[10px] rounded px-1.5 py-px font-[family-name:var(--font-mono)]"
                        style={{
                          color: C.accentText,
                          background: C.accentSoft,
                          border: `1px solid ${C.accent}25`,
                        }}
                      >
                        <FileCode2 size={9} />
                        {file}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {/* Add Sub-Task section */}
          {showAddForm ? (
            <div
              className="p-3 py-3 px-3.5 rounded-xl mb-2"
              style={{ background: C.surface, border: `1px dashed ${C.accent}50` }}
            >
              <div className="text-[11px] font-semibold mb-2 uppercase tracking-[0.04em]" style={{ color: C.textMuted }}>
                New Sub-Task
              </div>
              <textarea
                ref={addInputRef}
                value={newTaskPrompt}
                onChange={(e) => setNewTaskPrompt(e.target.value)}
                placeholder="Describe what this task should accomplish..."
                rows={3}
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: C.surfaceHover,
                  border: `1px solid ${C.border}`,
                  color: C.textPrimary,
                  fontSize: 12,
                  fontFamily: 'Inter, sans-serif',
                  resize: 'vertical',
                  outline: 'none',
                  lineHeight: '18px',
                  boxSizing: 'border-box',
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.metaKey) handleAddTask();
                  if (e.key === 'Escape') setShowAddForm(false);
                }}
              />
              <div className="flex items-center gap-2 mt-2">
                <select
                  value={newTaskAgent}
                  onChange={(e) => setNewTaskAgent(e.target.value as ToolName)}
                  style={{
                    padding: '5px 8px',
                    borderRadius: 8,
                    background: C.surfaceHover,
                    border: `1px solid ${C.border}`,
                    color: C.textSecondary,
                    fontSize: 11,
                    fontFamily: 'Inter, sans-serif',
                    cursor: 'pointer',
                    outline: 'none',
                  }}
                >
                  {AGENT_OPTIONS.map(a => (
                    <option key={a} value={a}>{AGENTS[a].label}</option>
                  ))}
                </select>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => { setShowAddForm(false); setNewTaskPrompt(''); }}
                  className="py-[5px] px-3.5 rounded-lg bg-transparent text-[11px] font-semibold font-[Inter,sans-serif] cursor-pointer transition-all duration-100 ease-in-out"
                  style={{ border: `1px solid ${C.border}`, color: C.textMuted }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleAddTask}
                  disabled={!newTaskPrompt.trim()}
                  className="py-[5px] px-3.5 rounded-lg border-none text-[11px] font-semibold font-[Inter,sans-serif] transition-all duration-100 ease-in-out"
                  style={{
                    background: newTaskPrompt.trim() ? C.accent : C.borderStrong,
                    color: newTaskPrompt.trim() ? '#fff' : C.textMuted,
                    cursor: newTaskPrompt.trim() ? 'pointer' : 'not-allowed',
                  }}
                >
                  Add
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowAddForm(true)}
              className="w-full py-2.5 px-3.5 rounded-xl bg-transparent text-xs font-medium font-[Inter,sans-serif] cursor-pointer flex items-center justify-center gap-1.5 transition-all duration-150 ease-in-out mb-2"
              style={{ border: `1px dashed ${C.borderStrong}`, color: C.textMuted }}
            >
              <Plus size={14} />
              Add Sub-Task
            </button>
          )}
        </div>

        {/* Footer */}
        <div
          className="py-4 px-6 flex items-center justify-between"
          style={{ borderTop: `1px solid ${C.border}` }}
        >
          <span className="text-xs" style={{ color: C.textMuted }}>
            {activeCount} task{activeCount !== 1 ? 's' : ''} will execute
          </span>
          <button
            type="button"
            disabled={approving || activeCount === 0}
            onClick={handleApprove}
            className="py-2.5 px-7 rounded-xl border-none text-white text-[13px] font-bold font-[Inter,sans-serif] transition-all duration-150 ease-in-out"
            style={{
              background: approving || activeCount === 0 ? C.borderStrong : C.accent,
              cursor: approving || activeCount === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            {approving ? 'Approving...' : countdown !== null && countdown > 0 ? `Auto-starting in ${countdown}s...` : `Approve & Start (${activeCount})`}
          </button>
        </div>
      </div>
    </div>
  );
}
