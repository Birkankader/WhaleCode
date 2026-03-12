import { useState, useCallback, useRef, useEffect } from 'react';
import { Send, Terminal, X } from 'lucide-react';
import { commands } from '../../bindings';
import { OutputConsole } from './OutputConsole';
import { Button } from '../ui/button';
import type { ToolName } from '../../stores/taskStore';

const AGENT_COLORS: Record<ToolName, string> = {
  claude: 'text-violet-400',
  gemini: 'text-blue-400',
  codex: 'text-emerald-400',
};

interface DeveloperTerminalProps {
  processId: string;
  agentName: ToolName;
  onClose: () => void;
}

export function DeveloperTerminal({ processId, agentName, onClose }: DeveloperTerminalProps) {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    setSending(true);
    try {
      await commands.sendToProcess(processId, text);
      setHistory((prev) => [...prev, text]);
      setHistoryIndex(-1);
      setInput('');
    } catch (err) {
      console.error('Failed to send to process:', err);
    } finally {
      setSending(false);
    }
  }, [input, processId, sending]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (history.length > 0) {
          const newIndex = historyIndex < history.length - 1 ? historyIndex + 1 : historyIndex;
          setHistoryIndex(newIndex);
          setInput(history[history.length - 1 - newIndex] || '');
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIndex > 0) {
          const newIndex = historyIndex - 1;
          setHistoryIndex(newIndex);
          setInput(history[history.length - 1 - newIndex] || '');
        } else {
          setHistoryIndex(-1);
          setInput('');
        }
      }
    },
    [handleSend, history, historyIndex],
  );

  return (
    <div className="flex flex-col h-full border border-white/10 rounded-lg overflow-hidden bg-black/60">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-black/40 border-b border-white/5">
        <div className="flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5 text-zinc-500" />
          <span className={`text-xs font-medium ${AGENT_COLORS[agentName]}`}>
            {agentName.charAt(0).toUpperCase() + agentName.slice(1)} Dev Terminal
          </span>
          <span className="text-[10px] text-zinc-600 font-mono">
            {processId.slice(0, 8)}
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-zinc-600 hover:text-zinc-300 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Terminal output */}
      <div className="flex-1 min-h-0">
        <OutputConsole processId={processId} />
      </div>

      {/* Input */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-t border-white/5 bg-black/40">
        <span className="text-xs text-zinc-600 font-mono shrink-0">$</span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send command to agent..."
          className="flex-1 text-xs font-mono bg-transparent text-zinc-200 placeholder:text-zinc-700 focus:outline-none"
          disabled={sending}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSend}
          disabled={!input.trim() || sending}
          className="h-6 px-2 text-zinc-500 hover:text-zinc-300"
        >
          <Send className="w-3 h-3" />
        </Button>
      </div>
    </div>
  );
}
