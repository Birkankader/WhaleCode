import { useState, useMemo } from 'react';
import { Plus, Trash2, Play, Bookmark } from 'lucide-react';
import { toast } from 'sonner';
import { useTemplateStore, type TaskTemplate } from '@/stores/templateStore';
import { useUIStore } from '@/stores/uiStore';
import { useTaskStore, type ToolName } from '@/stores/taskStore';
import { useTaskDispatch } from '@/hooks/useTaskDispatch';
import { AGENTS } from '@/lib/agents';

/* ── Component ─────────────────────────────────────────── */

interface TaskTemplatesProps {
  onClose: () => void;
}

export function TaskTemplates({ onClose }: TaskTemplatesProps) {
  const templates = useTemplateStore((s) => s.templates);
  const addTemplate = useTemplateStore((s) => s.addTemplate);
  const removeTemplate = useTemplateStore((s) => s.removeTemplate);
  const incrementUsage = useTemplateStore((s) => s.incrementUsage);
  const projectDir = useUIStore((s) => s.projectDir);
  const { dispatchTask } = useTaskDispatch();

  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [newAgent, setNewAgent] = useState<ToolName>('claude');
  const [running, setRunning] = useState<string | null>(null);

  const sorted = useMemo(() =>
    [...templates].sort((a, b) => b.usageCount - a.usageCount || b.createdAt - a.createdAt),
    [templates],
  );

  const handleAdd = () => {
    if (!newName.trim() || !newPrompt.trim()) return;
    addTemplate(newName.trim(), newPrompt.trim(), newAgent);
    setNewName('');
    setNewPrompt('');
    setShowAdd(false);
    toast.success('Template saved');
  };

  const handleRun = async (tpl: TaskTemplate) => {
    if (!projectDir || running) return;
    setRunning(tpl.id);
    try {
      incrementUsage(tpl.id);
      const taskId = await dispatchTask(tpl.prompt, projectDir, tpl.agent as ToolName);
      if (taskId) {
        const ts = useTaskStore.getState();
        const task = ts.tasks.get(taskId);
        if (task) {
          const newTasks = new Map(ts.tasks);
          newTasks.set(task.taskId, { ...task, role: 'worker' });
          useTaskStore.setState({ tasks: newTasks });
        }
        toast.success(`"${tpl.name}" dispatched`);
        onClose();
      }
    } catch (e) {
      toast.error('Failed to run template', { description: String(e) });
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-wc-border shrink-0">
        <div className="flex items-center gap-2">
          <Bookmark size={14} className="text-wc-accent-text" />
          <h3 className="text-sm font-semibold text-wc-text-primary m-0">Task Templates</h3>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-wc-accent-soft text-wc-accent-text hover:bg-wc-accent/20 transition-colors"
        >
          <Plus size={12} />
          New
        </button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="px-5 py-3 border-b border-wc-border bg-wc-surface/50 space-y-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Template name..."
            className="w-full text-xs px-3 py-2 rounded-lg bg-wc-bg border border-wc-border text-wc-text-primary outline-none"
            autoFocus
          />
          <textarea
            value={newPrompt}
            onChange={(e) => setNewPrompt(e.target.value)}
            placeholder="Task prompt..."
            rows={3}
            className="w-full text-xs px-3 py-2 rounded-lg bg-wc-bg border border-wc-border text-wc-text-primary outline-none resize-none"
          />
          <div className="flex items-center gap-2">
            <select
              value={newAgent}
              onChange={(e) => setNewAgent(e.target.value as ToolName)}
              className="text-xs px-2 py-1.5 rounded-lg bg-wc-bg border border-wc-border text-wc-text-primary outline-none"
            >
              <option value="claude">Claude</option>
              <option value="gemini">Gemini</option>
              <option value="codex">Codex</option>
            </select>
            <div className="flex-1" />
            <button
              onClick={() => setShowAdd(false)}
              className="text-xs text-wc-text-muted hover:text-wc-text-secondary px-3 py-1.5"
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={!newName.trim() || !newPrompt.trim()}
              className="text-xs font-semibold px-4 py-1.5 rounded-lg bg-wc-accent text-white disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </div>
      )}

      {/* Template list */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-wc-text-muted">
            No templates yet.
            <br />
            <span className="text-xs">Save frequently used prompts for quick re-use.</span>
          </div>
        ) : (
          sorted.map((tpl) => (
            <div
              key={tpl.id}
              className="flex items-start gap-3 px-5 py-3 border-b border-wc-border hover:bg-wc-surface-hover transition-colors group"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-semibold text-wc-text-primary truncate">{tpl.name}</span>
                  <span className="text-[10px] px-1.5 py-px rounded bg-wc-surface border border-wc-border text-wc-text-muted shrink-0">
                    {AGENTS[tpl.agent as ToolName]?.label ?? tpl.agent}
                  </span>
                  {tpl.usageCount > 0 && (
                    <span className="text-[9px] text-wc-text-muted shrink-0">
                      used {tpl.usageCount}×
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-wc-text-muted line-clamp-2 m-0">{tpl.prompt}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => handleRun(tpl)}
                  disabled={!projectDir || running === tpl.id}
                  className="flex items-center justify-center size-7 rounded-lg text-wc-green hover:bg-wc-green-bg transition-colors disabled:opacity-40"
                  title="Run template"
                >
                  <Play size={12} />
                </button>
                <button
                  onClick={() => { removeTemplate(tpl.id); toast.info('Template removed'); }}
                  className="flex items-center justify-center size-7 rounded-lg text-wc-text-muted hover:text-wc-red hover:bg-wc-red-bg transition-colors"
                  title="Delete template"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
