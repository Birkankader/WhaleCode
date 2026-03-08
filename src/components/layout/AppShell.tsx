import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { useUIStore } from '../../stores/uiStore';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);

  return (
    <div
      data-testid="app-shell"
      className="flex h-screen bg-[#050505] text-zinc-100 font-sans selection:bg-violet-500/30 overflow-hidden relative"
    >
      {/* Premium ambient background gradient */}
      <div className="absolute top-0 left-0 right-0 h-[500px] w-full bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(120,80,255,0.15),rgba(255,255,255,0))] pointer-events-none" />

      <div className="z-10 flex h-full w-full">
        {!sidebarCollapsed && <Sidebar />}
        <main data-testid="main-content" className="flex-1 min-w-0 flex flex-col p-4 pl-0">
          <div className="flex-1 rounded-2xl border border-white/10 bg-black/40 backdrop-blur-2xl shadow-2xl overflow-hidden flex flex-col relative">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
