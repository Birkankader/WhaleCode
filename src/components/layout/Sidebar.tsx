import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { Settings, Command, LayoutGrid, Terminal, Kanban, BarChart3 } from 'lucide-react';
import { ApiKeySettings } from '../settings/ApiKeySettings';
import { Button } from '../ui/button';

export function Sidebar() {
  const [showSettings, setShowSettings] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const navItems = [
    { path: '/', label: 'Orchestrator', icon: Terminal },
    { path: '/kanban', label: 'Kanban', icon: Kanban },
    { path: '/usage', label: 'Usage', icon: BarChart3 },
    { path: '/worktrees', label: 'Worktrees', icon: LayoutGrid },
  ];

  return (
    <aside
      data-testid="sidebar"
      className="w-64 h-full flex flex-col bg-transparent text-zinc-300 relative z-20"
    >
      <div className="px-6 py-8 flex items-center gap-3">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 shadow-lg shadow-violet-500/20">
          <Command className="w-4 h-4 text-white" />
        </div>
        <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-zinc-100 to-zinc-400 tracking-tight">WhaleCode</h1>
      </div>

      <nav className="flex-1 px-4 space-y-1 mt-4">
        {navItems.map(({ path, label, icon: Icon }) => (
          <Button
            key={path}
            variant="ghost"
            onClick={() => navigate(path)}
            className={`w-full justify-start gap-3 rounded-xl transition-all ${
              location.pathname === path
                ? 'bg-white/10 text-zinc-100 shadow-sm'
                : 'bg-transparent text-zinc-400 hover:text-zinc-200 hover:bg-white/5'
            }`}
          >
            <Icon className={`w-4 h-4 ${location.pathname === path ? 'text-violet-400' : ''}`} />
            <span className="font-medium">{label}</span>
          </Button>
        ))}
      </nav>

      {/* Settings button at bottom */}
      <div className="px-4 pb-6 mt-auto">
        <Button
          variant="ghost"
          className="w-full justify-start gap-3 text-zinc-400 hover:text-zinc-200 hover:bg-white/5 rounded-xl transition-all"
          onClick={() => setShowSettings(!showSettings)}
        >
          <Settings className="w-4 h-4" />
          <span className="font-medium">Settings</span>
        </Button>
      </div>

      {/* Settings modal overlay */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm transition-all">
          <div className="bg-zinc-950 border border-white/10 rounded-2xl shadow-2xl shadow-black/50 overflow-hidden transform scale-100 animate-in fade-in zoom-in duration-200">
            <ApiKeySettings onClose={() => setShowSettings(false)} />
          </div>
        </div>
      )}
    </aside>
  );
}
