import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface TaskTemplate {
  id: string;
  name: string;
  prompt: string;
  agent: string;
  createdAt: number;
  usageCount: number;
}

interface TemplateState {
  templates: TaskTemplate[];
  addTemplate: (name: string, prompt: string, agent: string) => void;
  removeTemplate: (id: string) => void;
  incrementUsage: (id: string) => void;
}

export const useTemplateStore = create<TemplateState>()(persist(
  (set) => ({
    templates: [],

    addTemplate: (name, prompt, agent) => {
      set((state) => ({
        templates: [
          ...state.templates,
          {
            id: `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name,
            prompt,
            agent,
            createdAt: Date.now(),
            usageCount: 0,
          },
        ],
      }));
    },

    removeTemplate: (id) => {
      set((state) => ({
        templates: state.templates.filter((t) => t.id !== id),
      }));
    },

    incrementUsage: (id) => {
      set((state) => ({
        templates: state.templates.map((t) =>
          t.id === id ? { ...t, usageCount: t.usageCount + 1 } : t,
        ),
      }));
    },
  }),
  { name: 'whalecode-templates' },
));
