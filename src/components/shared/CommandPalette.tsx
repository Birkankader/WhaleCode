import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Search } from 'lucide-react';
import { useUIStore, type AppView } from '@/stores/uiStore';
import { useTaskStore, type ToolName } from '@/stores/taskStore';

/* ── Command types ─────────────────────────────────────── */

interface Command {
  id: string;
  label: string;
  section: string;
  shortcut?: string;
  icon?: string;
  action: () => void;
}

/* ── Component ─────────────────────────────────────────── */

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const setActiveView = useUIStore((s) => s.setActiveView);
  const setShowSetup = useUIStore((s) => s.setShowSetup);
  const setShowQuickTask = useUIStore((s) => s.setShowQuickTask);
  const setDeveloperMode = useUIStore((s) => s.setDeveloperMode);
  const developerMode = useUIStore((s) => s.developerMode);
  const setAutoApprove = useUIStore((s) => s.setAutoApprove);
  const autoApprove = useUIStore((s) => s.autoApprove);
  const setAutoMerge = useUIStore((s) => s.setAutoMerge);
  const autoMerge = useUIStore((s) => s.autoMerge);
  const tasks = useTaskStore((s) => s.tasks);

  // Build command list
  const commands: Command[] = useMemo(() => {
    const cmds: Command[] = [];

    // Navigation
    const views: [AppView, string, string][] = [
      ['kanban', 'Board', '⌘1'],
      ['terminal', 'Terminal', '⌘2'],
      ['usage', 'Usage', '⌘3'],
      ['git', 'Git', ''],
      ['code', 'Code', ''],
      ['review', 'Review', ''],
      ['settings', 'Settings', ''],
    ];
    for (const [key, label, shortcut] of views) {
      cmds.push({
        id: `nav-${key}`,
        label: `Go to ${label}`,
        section: 'Navigation',
        shortcut,
        icon: '→',
        action: () => { setActiveView(key); onClose(); },
      });
    }

    // Actions
    cmds.push({
      id: 'new-orchestration',
      label: 'New Orchestration',
      section: 'Actions',
      icon: '🎵',
      action: () => { setShowSetup(true); onClose(); },
    });
    cmds.push({
      id: 'quick-task',
      label: 'Quick Task',
      section: 'Actions',
      shortcut: '⌘K',
      icon: '+',
      action: () => { setShowQuickTask(true); onClose(); },
    });

    // Toggles
    cmds.push({
      id: 'toggle-dev',
      label: `${developerMode ? 'Disable' : 'Enable'} Developer Mode`,
      section: 'Settings',
      icon: '⚙',
      action: () => { setDeveloperMode(!developerMode); onClose(); },
    });
    cmds.push({
      id: 'toggle-auto-approve',
      label: `${autoApprove ? 'Disable' : 'Enable'} Auto-Approve`,
      section: 'Settings',
      icon: '⚙',
      action: () => { setAutoApprove(!autoApprove); onClose(); },
    });
    cmds.push({
      id: 'toggle-auto-merge',
      label: `${autoMerge ? 'Disable' : 'Enable'} Auto-Merge`,
      section: 'Settings',
      icon: '⚙',
      action: () => { setAutoMerge(!autoMerge); onClose(); },
    });

    // Tasks — jump to specific task
    for (const [, task] of tasks) {
      cmds.push({
        id: `task-${task.taskId}`,
        label: task.description || task.prompt.slice(0, 60),
        section: 'Tasks',
        icon: task.status === 'running' ? '🔄' : task.status === 'completed' ? '✓' : task.status === 'failed' ? '✕' : '○',
        action: () => {
          setActiveView('kanban');
          useUIStore.getState().setSelectedTaskId(task.taskId);
          onClose();
        },
      });
    }

    return cmds;
  }, [setActiveView, setShowSetup, setShowQuickTask, setDeveloperMode, developerMode, setAutoApprove, autoApprove, setAutoMerge, autoMerge, tasks, onClose]);

  // Filter commands by query
  const filtered = useMemo(() => {
    if (!query.trim()) return commands;
    const q = query.toLowerCase();
    return commands.filter((cmd) =>
      cmd.label.toLowerCase().includes(q) ||
      cmd.section.toLowerCase().includes(q)
    );
  }, [commands, query]);

  // Group by section
  const grouped = useMemo(() => {
    const map = new Map<string, Command[]>();
    for (const cmd of filtered) {
      if (!map.has(cmd.section)) map.set(cmd.section, []);
      map.get(cmd.section)!.push(cmd);
    }
    return map;
  }, [filtered]);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Clamp selected index
  useEffect(() => {
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selectedIndex]);

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const executeSelected = useCallback(() => {
    if (filtered[selectedIndex]) {
      filtered[selectedIndex].action();
    }
  }, [filtered, selectedIndex]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        executeSelected();
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  }, [filtered.length, executeSelected, onClose]);

  if (!open) return null;

  let flatIndex = 0;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]"
      style={{ background: 'rgba(5,5,12,0.7)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="w-[520px] max-h-[420px] flex flex-col rounded-2xl border border-wc-border-strong bg-wc-panel shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-wc-border">
          <Search size={16} className="text-wc-text-muted shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            className="flex-1 bg-transparent text-sm text-wc-text-primary outline-none placeholder:text-wc-text-muted"
            autoFocus
          />
          <kbd className="text-[10px] text-wc-text-muted bg-wc-surface px-1.5 py-0.5 rounded border border-wc-border">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-wc-text-muted">
              No commands found
            </div>
          ) : (
            Array.from(grouped.entries()).map(([section, cmds]) => (
              <div key={section}>
                <div className="px-4 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-wc-text-muted">
                  {section}
                </div>
                {cmds.map((cmd) => {
                  const idx = flatIndex++;
                  const isSelected = idx === selectedIndex;
                  return (
                    <button
                      key={cmd.id}
                      data-index={idx}
                      onClick={cmd.action}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      className={`w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors ${
                        isSelected
                          ? 'bg-wc-accent-soft text-wc-accent-text'
                          : 'text-wc-text-primary hover:bg-wc-surface-hover'
                      }`}
                    >
                      <span className="w-5 text-center text-xs shrink-0 opacity-60">
                        {cmd.icon}
                      </span>
                      <span className="flex-1 truncate">{cmd.label}</span>
                      {cmd.shortcut && (
                        <kbd className="text-[10px] text-wc-text-muted bg-wc-surface px-1.5 py-0.5 rounded border border-wc-border">
                          {cmd.shortcut}
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
