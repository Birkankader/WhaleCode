import { useState, useCallback } from 'react';
import { Check, Plus, Trash2, Edit3, RotateCcw } from 'lucide-react';
import { Button } from '../ui/button';
import type { ToolName } from '../../stores/taskStore';

export interface ApprovalTask {
  id: string;
  description: string;
  prompt: string;
  assignedAgent: ToolName;
}

const AGENT_COLORS: Record<ToolName, { bg: string; border: string; text: string; label: string }> = {
  claude: { bg: 'bg-violet-500/10', border: 'border-violet-500/30', text: 'text-violet-400', label: 'Claude' },
  gemini: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', text: 'text-blue-400', label: 'Gemini' },
  codex: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400', label: 'Codex' },
};

interface TaskApprovalProps {
  tasks: ApprovalTask[];
  availableAgents: ToolName[];
  masterAgent: ToolName;
  originalPrompt: string;
  onApprove: (tasks: ApprovalTask[]) => void;
  onReject: (feedback: string) => void;
}

export function TaskApproval({
  tasks: initialTasks,
  availableAgents,
  masterAgent,
  originalPrompt,
  onApprove,
  onReject,
}: TaskApprovalProps) {
  const [tasks, setTasks] = useState<ApprovalTask[]>(initialTasks);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [rejectFeedback, setRejectFeedback] = useState('');
  const [showReject, setShowReject] = useState(false);

  const handleAgentChange = useCallback((taskId: string, newAgent: ToolName) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, assignedAgent: newAgent } : t)),
    );
  }, []);

  const handleDelete = useCallback((taskId: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
  }, []);

  const handleAdd = useCallback(() => {
    const newId = `user-${Date.now()}`;
    const defaultAgent = availableAgents.find((a) => a !== masterAgent) ?? availableAgents[0];
    setTasks((prev) => [
      ...prev,
      { id: newId, description: 'New task', prompt: '', assignedAgent: defaultAgent },
    ]);
    setEditingId(newId);
    setEditText('New task');
  }, [availableAgents, masterAgent]);

  const startEditing = useCallback((task: ApprovalTask) => {
    setEditingId(task.id);
    setEditText(task.description);
  }, []);

  const finishEditing = useCallback(() => {
    if (editingId && editText.trim()) {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === editingId ? { ...t, description: editText.trim(), prompt: editText.trim() } : t,
        ),
      );
    }
    setEditingId(null);
    setEditText('');
  }, [editingId, editText]);

  const handleReject = useCallback(() => {
    if (rejectFeedback.trim()) {
      onReject(rejectFeedback.trim());
    }
  }, [rejectFeedback, onReject]);

  return (
    <div className="flex flex-col h-full bg-black/20">
      {/* Header */}
      <div className="shrink-0 px-6 py-4 border-b border-white/5 bg-black/30">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-zinc-200">Task Decomposition Review</h2>
          <span className="text-xs text-zinc-500">
            Master: <span className={AGENT_COLORS[masterAgent].text}>{AGENT_COLORS[masterAgent].label}</span>
          </span>
        </div>
        <p className="text-xs text-zinc-500 line-clamp-2">
          Prompt: "{originalPrompt}"
        </p>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {tasks.map((task, index) => {
          const colors = AGENT_COLORS[task.assignedAgent];
          const isEditing = editingId === task.id;

          return (
            <div
              key={task.id}
              className={`flex items-start gap-3 p-3 rounded-lg border ${colors.border} ${colors.bg} transition-all`}
            >
              <span className="text-xs text-zinc-600 font-mono mt-0.5 shrink-0 w-5">
                {index + 1}.
              </span>

              <div className="flex-1 min-w-0">
                {isEditing ? (
                  <input
                    type="text"
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={finishEditing}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') finishEditing();
                      if (e.key === 'Escape') { setEditingId(null); setEditText(''); }
                    }}
                    autoFocus
                    className="w-full text-xs text-zinc-200 bg-black/40 border border-white/10 rounded px-2 py-1 focus:outline-none focus:border-violet-500/50"
                  />
                ) : (
                  <p className="text-xs text-zinc-200 leading-relaxed">{task.description}</p>
                )}
              </div>

              {/* Agent selector */}
              <select
                value={task.assignedAgent}
                onChange={(e) => handleAgentChange(task.id, e.target.value as ToolName)}
                className={`text-[10px] font-medium px-2 py-1 rounded border ${colors.border} ${colors.text} bg-black/40 cursor-pointer shrink-0`}
              >
                {availableAgents.map((agent) => (
                  <option key={agent} value={agent}>
                    {AGENT_COLORS[agent].label}{agent === masterAgent ? ' (master)' : ''}
                  </option>
                ))}
              </select>

              {/* Edit button */}
              <button
                onClick={() => startEditing(task)}
                className="text-zinc-600 hover:text-zinc-300 transition-colors shrink-0"
                title="Edit task"
              >
                <Edit3 className="w-3.5 h-3.5" />
              </button>

              {/* Delete button */}
              <button
                onClick={() => handleDelete(task.id)}
                className="text-zinc-600 hover:text-red-400 transition-colors shrink-0"
                title="Remove task"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}

        {/* Add task button */}
        <button
          onClick={handleAdd}
          className="flex items-center gap-2 w-full p-3 rounded-lg border border-dashed border-white/10 text-zinc-500 hover:text-zinc-300 hover:border-white/20 transition-all"
        >
          <Plus className="w-3.5 h-3.5" />
          <span className="text-xs">Add task</span>
        </button>
      </div>

      {/* Rejection feedback */}
      {showReject && (
        <div className="shrink-0 px-6 py-3 border-t border-white/5 bg-red-950/20">
          <p className="text-xs text-red-400 mb-2">Tell the master agent what to change:</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={rejectFeedback}
              onChange={(e) => setRejectFeedback(e.target.value)}
              placeholder="e.g., Split task 2 into smaller pieces..."
              className="flex-1 text-xs bg-black/40 border border-red-500/30 text-zinc-200 rounded px-3 py-1.5 focus:outline-none focus:border-red-500/50"
              onKeyDown={(e) => { if (e.key === 'Enter') handleReject(); }}
              autoFocus
            />
            <Button
              size="sm"
              onClick={handleReject}
              disabled={!rejectFeedback.trim()}
              className="bg-red-600/80 text-white hover:bg-red-500 text-xs h-7"
            >
              Send
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowReject(false)}
              className="text-xs h-7 border-white/10"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Action bar */}
      <div className="shrink-0 flex items-center justify-between px-6 py-3 border-t border-white/5 bg-black/30">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span>{tasks.length} tasks</span>
          <span className="text-zinc-700">|</span>
          <span>
            {availableAgents.filter((a) => a !== masterAgent).map((a) => AGENT_COLORS[a].label).join(', ')}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowReject(!showReject)}
            className="border-red-500/30 text-red-400 hover:bg-red-500/10 text-xs h-8"
          >
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
            Re-decompose
          </Button>
          <Button
            size="sm"
            onClick={() => onApprove(tasks)}
            disabled={tasks.length === 0}
            className="bg-green-600 text-white hover:bg-green-500 shadow-lg shadow-green-500/20 text-xs h-8"
          >
            <Check className="w-3.5 h-3.5 mr-1.5" />
            Approve & Execute ({tasks.length} tasks)
          </Button>
        </div>
      </div>
    </div>
  );
}
