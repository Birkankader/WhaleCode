import { create } from 'zustand';

interface UIState {
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  autoMerge: boolean;
  setAutoMerge: (enabled: boolean) => void;
  developerMode: boolean;
  setDeveloperMode: (enabled: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarCollapsed: false,
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  autoMerge: false,
  setAutoMerge: (enabled) => set({ autoMerge: enabled }),
  developerMode: false,
  setDeveloperMode: (enabled) => set({ developerMode: enabled }),
}));
