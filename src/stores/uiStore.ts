import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type AppView = 'kanban' | 'terminal' | 'usage' | 'review' | 'done' | 'settings' | 'git' | 'code';

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

  // Project
  sessionName: string;
  setSessionName: (name: string) => void;
  projectDir: string;
  setProjectDir: (dir: string) => void;

  // Settings
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  autoMerge: boolean;
  setAutoMerge: (enabled: boolean) => void;
  codeReview: boolean;
  setCodeReview: (enabled: boolean) => void;
  developerMode: boolean;
  setDeveloperMode: (enabled: boolean) => void;
  showQuickTask: boolean;
  setShowQuickTask: (show: boolean) => void;
  autoApprove: boolean;
  setAutoApprove: (enabled: boolean) => void;
}

export const useUIStore = create<UIState>()(persist((set) => ({
  // Navigation
  activeView: 'kanban',
  setActiveView: (view) => set({ activeView: view }),
  showSetup: false,
  setShowSetup: (show) => set({ showSetup: show }),
  selectedTaskId: null,
  setSelectedTaskId: (id) => set({ selectedTaskId: id }),
  showReviewBanner: false,
  setShowReviewBanner: (show) => set({ showReviewBanner: show }),

  // Project
  sessionName: '',
  setSessionName: (name) => set({ sessionName: name }),
  projectDir: '',
  setProjectDir: (dir) => set({ projectDir: dir }),

  // Settings
  sidebarCollapsed: false,
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  autoMerge: false,
  setAutoMerge: (enabled) => set({ autoMerge: enabled }),
  codeReview: true,
  setCodeReview: (enabled) => set({ codeReview: enabled }),
  developerMode: false,
  setDeveloperMode: (enabled) => set({ developerMode: enabled }),
  showQuickTask: false,
  setShowQuickTask: (show) => set({ showQuickTask: show }),
  autoApprove: false,
  setAutoApprove: (enabled) => set({ autoApprove: enabled }),
}), {
  name: 'whalecode-ui',
  partialize: (state) => ({
    projectDir: state.projectDir,
    sessionName: state.sessionName,
    sidebarCollapsed: state.sidebarCollapsed,
    autoMerge: state.autoMerge,
    codeReview: state.codeReview,
    developerMode: state.developerMode,
    autoApprove: state.autoApprove,
  }),
}));
