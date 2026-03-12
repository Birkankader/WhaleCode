import { create } from 'zustand';

export type AppView = 'kanban' | 'terminal' | 'usage' | 'review' | 'done' | 'settings';

interface UIState {
  // Navigation
  activeView: AppView;
  setActiveView: (view: AppView) => void;
  showSetup: boolean;
  setShowSetup: (show: boolean) => void;
  selectedTaskId: string | null;
  setSelectedTaskId: (id: string | null) => void;
  showReviewBanner: boolean;
  setShowReviewBanner: (show: boolean) => void;

  // Settings
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  autoMerge: boolean;
  setAutoMerge: (enabled: boolean) => void;
  autoPr: boolean;
  setAutoPr: (enabled: boolean) => void;
  codeReview: boolean;
  setCodeReview: (enabled: boolean) => void;
  developerMode: boolean;
  setDeveloperMode: (enabled: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  // Navigation
  activeView: 'kanban',
  setActiveView: (view) => set({ activeView: view }),
  showSetup: false,
  setShowSetup: (show) => set({ showSetup: show }),
  selectedTaskId: null,
  setSelectedTaskId: (id) => set({ selectedTaskId: id }),
  showReviewBanner: false,
  setShowReviewBanner: (show) => set({ showReviewBanner: show }),

  // Settings
  sidebarCollapsed: false,
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  autoMerge: false,
  setAutoMerge: (enabled) => set({ autoMerge: enabled }),
  autoPr: true,
  setAutoPr: (enabled) => set({ autoPr: enabled }),
  codeReview: true,
  setCodeReview: (enabled) => set({ codeReview: enabled }),
  developerMode: false,
  setDeveloperMode: (enabled) => set({ developerMode: enabled }),
}));
