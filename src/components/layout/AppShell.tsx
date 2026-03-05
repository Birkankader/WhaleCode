import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { useUIStore } from '../../stores/uiStore';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);

  return (
    <div data-testid="app-shell" className="flex h-screen bg-zinc-950 text-zinc-100">
      {!sidebarCollapsed && <Sidebar />}
      <main data-testid="main-content" className="flex-1 min-w-0 overflow-hidden">
        {children}
      </main>
    </div>
  );
}
