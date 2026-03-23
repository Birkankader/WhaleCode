import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import { useTaskStore } from './taskStore';

export interface MessengerMessage {
  id: string;
  timestamp: number;
  source: { type: 'System' } | { type: 'Agent'; name: string };
  content: string;
  messageType: string;
  planId: string;
}

interface MessengerState {
  messages: MessengerMessage[];
  addMessage: (msg: MessengerMessage) => void;
  clearMessages: () => void;
  getMessagesForPlan: (planId: string) => MessengerMessage[];
}

export const useMessengerStore = create<MessengerState>((set, get) => ({
  messages: [],

  addMessage: (msg) => {
    set((state) => {
      const messages = [...state.messages, msg];
      // Keep last 500 messages to prevent unbounded growth
      return { messages: messages.length > 500 ? messages.slice(-500) : messages };
    });
  },

  clearMessages: () => set({ messages: [] }),

  getMessagesForPlan: (planId) => {
    return get().messages.filter((m) => m.planId === planId);
  },
}));

// Initialize Tauri event listener
let listenerInitialized = false;
let unlistenFn: (() => void) | null = null;
let listenerUnavailable = false;

export async function initMessengerListener() {
  if (listenerInitialized || listenerUnavailable) return;
  listenerInitialized = true;

  try {
    unlistenFn = await listen<Record<string, unknown>>('messenger-event', (event) => {
      const raw = event.payload;
      // Normalize source from Rust enum format
      let source: MessengerMessage['source'];
      if (typeof raw.source === 'string' && raw.source === 'System') {
        source = { type: 'System' };
      } else if (raw.source && typeof raw.source === 'object' && 'Agent' in (raw.source as Record<string, unknown>)) {
        source = { type: 'Agent', name: (raw.source as { Agent: string }).Agent };
      } else {
        source = { type: 'System' };
      }

      const normalized: MessengerMessage = {
        id: typeof raw.id === 'string' ? raw.id : String(raw.id ?? ''),
        timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : Date.now(),
        source,
        content: typeof raw.content === 'string' ? raw.content : String(raw.content ?? ''),
        messageType: typeof raw.message_type === 'string' ? raw.message_type : 'unknown',
        planId: typeof raw.plan_id === 'string' ? raw.plan_id : '',
      };
      useMessengerStore.getState().addMessage(normalized);

      if (normalized.messageType === 'QuestionForUser') {
        useTaskStore.getState().setPendingQuestion({
          questionId: normalized.id,
          sourceAgent: typeof normalized.source === 'object' && 'name' in normalized.source
            ? normalized.source.name : 'master',
          content: normalized.content,
          planId: normalized.planId,
        });
      }
    });
  } catch (e) {
    console.error('Failed to initialize messenger listener:', e);
    listenerInitialized = false;
    listenerUnavailable = true;
  }
}

export function cleanupMessengerListener() {
  unlistenFn?.();
  unlistenFn = null;
  listenerInitialized = false;
}
