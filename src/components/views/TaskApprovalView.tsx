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
  const developerMode = useUIStore((s) => s.developerMode);
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

  // Sync when workerTasks change (initial load)
  if (editedTasks === null && workerTasks.length > 0) {
    setEditedTasks([...workerTasks]);
  }

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

      // Command auto-generated at runtime by tauri-specta
      await (commands as Record<string, Function>).approveOrchestration(activePlan.task_id, modifiedTasks);
      toast.success('Tasks approved -- execution starting');
    } catch (e) {
      console.error('Approval failed:', e);
      toast.error('Approval failed');
    } finally {
      setApproving(false);
    }
  }, [activePlan, approving, displayTasks]);

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
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '8vh',
        background: visible ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0)',
        backdropFilter: visible ? 'blur(3px)' : 'blur(0px)',
        transition: 'background 200ms ease-out, backdrop-filter 200ms ease-out',
      }}
    >
      <div
        style={{
          width: 580,
          maxHeight: '85vh',
          borderRadius: 20,
          background: C.panel,
          border: `1px solid ${C.borderStrong}`,
          boxShadow: '0 20px 60px rgba(0,0,0,0.7)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          transform: visible ? 'scale(1)' : 'scale(0.95)',
          opacity: visible ? 1 : 0,
          transition: 'transform 200ms ease-out, opacity 200ms ease-out',
        }}
      >
        {/* Header with summary */}
        <div style={{ padding: '20px 24px 16px', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: C.textPrimary }}>
              Review Sub-Tasks
            </h2>
            {/* Auto-approve toggle */}
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <span style={{ fontSize: 11, color: C.textMuted }}>Auto-approve</span>
              <button
                type="button"
                onClick={() => setAutoApprove(!autoApprove)}
                style={{
                  width: 32,
                  height: 16,
                  borderRadius: 8,
                  background: autoApprove ? C.accent : C.borderStrong,
                  border: 'none',
                  padding: '0 2px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  transition: 'background 150ms ease',
                }}
              >
                <div
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 6,
                    background: '#fff',
                    transition: 'margin-left 150ms ease',
                    marginLeft: autoApprove ? 'auto' : '0',
                  }}
                />
              </button>
            </label>
          </div>

          {/* Summary bar */}
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12, color: C.textSecondary }}>
              {activeCount} task{activeCount !== 1 ? 's' : ''}: {agentSummary}
            </span>
          </div>

          {/* Agent distribution bar */}
          {activeCount > 0 && (
            <div
              style={{
                marginTop: 8,
                height: 4,
                borderRadius: 2,
                overflow: 'hidden',
                display: 'flex',
                background: C.borderStrong,
              }}
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

          <p style={{ margin: '8px 0 0', fontSize: 11, color: C.textMuted, lineHeight: '16px' }}>
            Reorder, reassign agents, add or remove tasks before execution.
          </p>
        </div>

        {/* Task list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 24px' }}>
          {displayTasks.map((task, idx) => {
            const agent = AGENTS[task.agent];
            const filePills = extractFilePills(task.description);
            const depIndex = task.dependsOn ? idToIndex.get(task.dependsOn) : null;

            return (
              <div
                key={task.id}
                style={{
                  padding: '12px 14px',
                  borderRadius: 12,
                  background: task.removed ? 'rgba(248,113,113,0.06)' : C.surface,
                  border: `1px solid ${task.removed ? 'rgba(248,113,113,0.2)' : C.border}`,
                  marginBottom: 8,
                  opacity: task.removed ? 0.45 : 1,
                  transition: 'all 150ms ease',
                }}
              >
                {/* Top row: reorder + badge + description + controls */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {/* Reorder buttons */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={() => handleMoveUp(idx)}
                      disabled={idx === 0}
                      style={{
                        width: 18,
                        height: 14,
                        borderRadius: 3,
                        background: 'transparent',
                        border: 'none',
                        color: idx === 0 ? C.textMuted + '40' : C.textMuted,
                        cursor: idx === 0 ? 'default' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 0,
                        transition: 'color 100ms ease',
                      }}
                      title="Move up"
                    >
                      <ChevronUp size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMoveDown(idx)}
                      disabled={idx === displayTasks.length - 1}
                      style={{
                        width: 18,
                        height: 14,
                        borderRadius: 3,
                        background: 'transparent',
                        border: 'none',
                        color: idx === displayTasks.length - 1 ? C.textMuted + '40' : C.textMuted,
                        cursor: idx === displayTasks.length - 1 ? 'default' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 0,
                        transition: 'color 100ms ease',
                      }}
                      title="Move down"
                    >
                      <ChevronDown size={12} />
                    </button>
                  </div>

                  {/* Agent badge with gradient */}
                  <div
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      background: agent.gradient,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      fontWeight: 700,
                      color: '#fff',
                      flexShrink: 0,
                    }}
                  >
                    {agent.letter}
                  </div>

                  {/* Task content */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Task number */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        Task {idx + 1} of {displayTasks.length}
                      </span>
                      {depIndex != null && (
                        <span
                          style={{
                            fontSize: 9,
                            fontWeight: 600,
                            color: C.amber,
                            background: C.amberBg,
                            border: `1px solid ${C.amberBorder}`,
                            borderRadius: 4,
                            padding: '1px 5px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 3,
                          }}
                        >
                          <GitBranch size={8} />
                          Depends on Task {depIndex}
                        </span>
                      )}
                    </div>
                    {/* Description */}
                    <div
                      style={{
                        fontSize: 12,
                        color: task.removed ? C.textMuted : C.textPrimary,
                        lineHeight: '18px',
                        textDecoration: task.removed ? 'line-through' : 'none',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {task.description}
                    </div>

                    {/* Full prompt — visible below description */}
                    {!task.removed && task.prompt !== task.description && (
                      developerMode ? (
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
                      ) : (
                        <div
                          style={{
                            marginTop: 6,
                            padding: '6px 10px',
                            borderRadius: 8,
                            background: C.panel,
                            border: `1px solid ${C.border}`,
                            fontSize: 11,
                            lineHeight: '16px',
                            color: C.textSecondary,
                            fontFamily: 'var(--font-mono)',
                            maxHeight: 80,
                            overflow: 'auto',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                          }}
                        >
                          {task.prompt}
                        </div>
                      )
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
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 8,
                      background: task.removed ? 'rgba(74,222,128,0.1)' : 'rgba(248,113,113,0.1)',
                      border: 'none',
                      color: task.removed ? C.green : C.red,
                      fontSize: 14,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      fontFamily: 'Inter, sans-serif',
                      transition: 'all 150ms ease',
                    }}
                    title={task.removed ? 'Restore task' : 'Remove task'}
                  >
                    {task.removed ? '\u21B6' : '\u2715'}
                  </button>
                </div>

                {/* File pills (scope indicator) */}
                {filePills.length > 0 && !task.removed && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8, paddingLeft: 58 }}>
                    {filePills.map(file => (
                      <span
                        key={file}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 3,
                          fontSize: 10,
                          color: C.accentText,
                          background: C.accentSoft,
                          border: `1px solid ${C.accent}25`,
                          borderRadius: 4,
                          padding: '1px 6px',
                          fontFamily: 'var(--font-mono)',
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
              style={{
                padding: '12px 14px',
                borderRadius: 12,
                background: C.surface,
                border: `1px dashed ${C.accent}50`,
                marginBottom: 8,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 600, color: C.textMuted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
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
                <div style={{ flex: 1 }} />
                <button
                  type="button"
                  onClick={() => { setShowAddForm(false); setNewTaskPrompt(''); }}
                  style={{
                    padding: '5px 14px',
                    borderRadius: 8,
                    background: 'transparent',
                    border: `1px solid ${C.border}`,
                    color: C.textMuted,
                    fontSize: 11,
                    fontWeight: 600,
                    fontFamily: 'Inter, sans-serif',
                    cursor: 'pointer',
                    transition: 'all 100ms ease',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleAddTask}
                  disabled={!newTaskPrompt.trim()}
                  style={{
                    padding: '5px 14px',
                    borderRadius: 8,
                    background: newTaskPrompt.trim() ? C.accent : C.borderStrong,
                    border: 'none',
                    color: newTaskPrompt.trim() ? '#fff' : C.textMuted,
                    fontSize: 11,
                    fontWeight: 600,
                    fontFamily: 'Inter, sans-serif',
                    cursor: newTaskPrompt.trim() ? 'pointer' : 'not-allowed',
                    transition: 'all 100ms ease',
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
              style={{
                width: '100%',
                padding: '10px 14px',
                borderRadius: 12,
                background: 'transparent',
                border: `1px dashed ${C.borderStrong}`,
                color: C.textMuted,
                fontSize: 12,
                fontWeight: 500,
                fontFamily: 'Inter, sans-serif',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                transition: 'all 150ms ease',
                marginBottom: 8,
              }}
            >
              <Plus size={14} />
              Add Sub-Task
            </button>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '16px 24px',
            borderTop: `1px solid ${C.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ fontSize: 12, color: C.textMuted }}>
            {activeCount} task{activeCount !== 1 ? 's' : ''} will execute
          </span>
          <button
            type="button"
            disabled={approving || activeCount === 0}
            onClick={handleApprove}
            style={{
              padding: '10px 28px',
              borderRadius: 12,
              background: approving || activeCount === 0 ? C.borderStrong : C.accent,
              border: 'none',
              color: '#fff',
              fontSize: 13,
              fontWeight: 700,
              fontFamily: 'Inter, sans-serif',
              cursor: approving || activeCount === 0 ? 'not-allowed' : 'pointer',
              transition: 'all 150ms ease',
            }}
          >
            {approving ? 'Approving...' : countdown !== null && countdown > 0 ? `Auto-starting in ${countdown}s...` : `Approve & Start (${activeCount})`}
          </button>
        </div>
      </div>
    </div>
  );
}
