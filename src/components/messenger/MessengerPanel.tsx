import { useEffect, useRef } from 'react';
import { useMessengerStore, initMessengerListener } from '../../stores/messengerStore';
import type { MessengerMessage } from '../../stores/messengerStore';

const SOURCE_COLORS: Record<string, string> = {
  System: 'text-zinc-400',
  claude: 'text-violet-400',
  gemini: 'text-blue-400',
  codex: 'text-emerald-400',
};

const TYPE_ICONS: Record<string, string> = {
  OrchestrationStarted: '●',
  TaskAssigned: '→',
  TaskCompleted: '✓',
  TaskFailed: '✗',
  AgentSummary: '◆',
  MasterDecision: '★',
  DecompositionResult: '◇',
  ReviewResult: '◈',
};

function getSourceLabel(source: MessengerMessage['source']): string {
  return source.type === 'System' ? 'System' : source.name;
}

function getSourceColor(source: MessengerMessage['source']): string {
  const name = source.type === 'System' ? 'System' : source.name;
  return SOURCE_COLORS[name] ?? 'text-zinc-400';
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function MessengerPanel() {
  const messages = useMessengerStore((s) => s.messages);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    initMessengerListener();
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
        No orchestration messages yet. Start a multi-agent task to see activity here.
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex flex-col h-full overflow-y-auto p-4 space-y-3">
      {messages.map((msg) => (
        <div key={msg.id} className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-600">{formatTime(msg.timestamp)}</span>
            <span className={`text-xs font-medium ${getSourceColor(msg.source)}`}>
              {TYPE_ICONS[msg.messageType] ?? '●'} {getSourceLabel(msg.source)}
            </span>
          </div>
          <div className="pl-4 text-sm text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed">
            {msg.content}
          </div>
        </div>
      ))}
    </div>
  );
}
