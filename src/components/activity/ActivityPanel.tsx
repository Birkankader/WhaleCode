import { useMemo, useState } from 'react';
import {
  Activity,
  Bot,
  CheckCircle2,
  CircleDot,
  PauseCircle,
  Send,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { commands } from '../../bindings';
import {
  emitLocalProcessMessage,
  useProcessStore,
  type ProcessInfo,
  type ProcessStatus,
} from '../../hooks/useProcess';
import { useMessengerStore } from '../../stores/messengerStore';
import { useTaskStore } from '../../stores/taskStore';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function inferAgentLabel(process: ProcessInfo): string {
  if (process.cmd.startsWith('claude:')) return 'Claude';
  if (process.cmd.startsWith('gemini:')) return 'Gemini';
  if (process.cmd.startsWith('codex:')) return 'Codex';
  if (process.cmd.startsWith('orchestration:')) return 'Master';
  return 'Process';
}

function processTone(status: ProcessStatus): {
  dot: string;
  badge: string;
  label: string;
  Icon: typeof CircleDot;
} {
  switch (status) {
    case 'running':
      return {
        dot: 'bg-amber-400 animate-pulse',
        badge: 'bg-amber-500/12 text-amber-200 border-amber-500/20',
        label: 'Running',
        Icon: CircleDot,
      };
    case 'paused':
      return {
        dot: 'bg-slate-400',
        badge: 'bg-slate-500/12 text-slate-200 border-slate-500/20',
        label: 'Paused',
        Icon: PauseCircle,
      };
    case 'completed':
      return {
        dot: 'bg-emerald-400',
        badge: 'bg-emerald-500/12 text-emerald-200 border-emerald-500/20',
        label: 'Completed',
        Icon: CheckCircle2,
      };
    case 'failed':
      return {
        dot: 'bg-rose-400',
        badge: 'bg-rose-500/12 text-rose-200 border-rose-500/20',
        label: 'Failed',
        Icon: XCircle,
      };
  }
}

function messageTypeLabel(type: string): string {
  switch (type) {
    case 'OrchestrationStarted':
      return 'Started';
    case 'TaskAssigned':
      return 'Assigned';
    case 'TaskCompleted':
      return 'Completed';
    case 'TaskFailed':
      return 'Failed';
    case 'DecompositionResult':
      return 'Plan';
    case 'ReviewResult':
      return 'Review';
    case 'QuestionForUser':
      return 'Question';
    case 'UserAnswer':
      return 'Answer';
    case 'ContextBackup':
      return 'Backup';
    case 'ContextRestore':
      return 'Restore';
    default:
      return type;
  }
}

function sourceTone(source: { type: 'System' } | { type: 'Agent'; name: string }): string {
  if (source.type === 'System') return 'text-slate-300';
  if (source.name === 'claude') return 'text-violet-300';
  if (source.name === 'gemini') return 'text-sky-300';
  if (source.name === 'codex') return 'text-emerald-300';
  return 'text-slate-300';
}

interface ActivityPanelProps {
  className?: string;
}

export function ActivityPanel({ className = '' }: ActivityPanelProps) {
  const processes = useProcessStore((s) => s.processes);
  const messages = useMessengerStore((s) => s.messages);
  const activePlan = useTaskStore((s) => s.activePlan);
  const pendingQuestion = useTaskStore((s) => s.pendingQuestion);
  const setPendingQuestion = useTaskStore((s) => s.setPendingQuestion);
  const [answer, setAnswer] = useState('');

  const processEntries = useMemo(
    () => Array.from(processes.values()).sort((a, b) => b.startedAt - a.startedAt),
    [processes],
  );

  const relevantMessages = useMemo(() => {
    const list = activePlan
      ? messages.filter((message) => message.planId === activePlan.task_id)
      : messages;
    return list.slice(-18).reverse();
  }, [activePlan, messages]);

  const handleAnswer = async () => {
    if (!pendingQuestion || !answer.trim()) return;
    await commands.answerUserQuestion(pendingQuestion.planId, answer.trim());
    if (activePlan?.master_process_id) {
      emitLocalProcessMessage(activePlan.master_process_id, `$ ${answer.trim()}`);
    }
    setPendingQuestion(null);
    setAnswer('');
  };

  return (
    <aside className={`flex min-h-0 flex-col gap-4 ${className}`}>
      <section className="rounded-[28px] border border-white/8 bg-[#111320]/86 shadow-[0_24px_80px_rgba(3,6,20,0.45)] backdrop-blur-xl">
        <div className="flex items-center justify-between border-b border-white/6 px-5 py-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-indigo-300/80">
              Live Activity
            </div>
            <div className="mt-1 text-sm font-semibold text-slate-100">
              Background agent health
            </div>
          </div>
          <div className="flex size-9 items-center justify-center rounded-2xl bg-indigo-500/14 text-indigo-200">
            <Activity className="size-4" />
          </div>
        </div>

        <div className="space-y-3 px-4 py-4">
          {processEntries.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-5 text-sm text-slate-400">
              When a task starts, this rail will show the agent connection, latest output line, and background run state.
            </div>
          ) : (
            processEntries.map((process) => {
              const tone = processTone(process.status);
              const Icon = tone.Icon;
              return (
                <div
                  key={process.taskId}
                  className="rounded-2xl border border-white/6 bg-[#0b0d16]/78 px-4 py-3"
                >
                  <div className="flex items-start gap-3">
                    <div className={`mt-1 size-2.5 rounded-full ${tone.dot}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-slate-100">
                          {inferAgentLabel(process)}
                        </span>
                        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${tone.badge}`}>
                          <Icon className="size-3" />
                          {tone.label}
                        </span>
                      </div>
                      <div className="mt-1 truncate text-xs text-slate-400">
                        {process.cmd}
                      </div>
                      <div className="mt-3 rounded-2xl border border-white/6 bg-white/[0.03] px-3 py-2.5 text-xs leading-5 text-slate-200">
                        {process.lastOutputPreview}
                      </div>
                      <div className="mt-2 text-[11px] text-slate-500">
                        Last event {formatTime(process.lastEventAt)}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {pendingQuestion && (
        <section className="rounded-[28px] border border-amber-400/20 bg-[linear-gradient(180deg,rgba(56,38,12,0.65),rgba(17,19,32,0.92))] shadow-[0_20px_60px_rgba(56,38,12,0.35)] backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-amber-400/12 px-5 py-4">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-200/80">
                User Input
              </div>
              <div className="mt-1 text-sm font-semibold text-amber-50">
                {pendingQuestion.sourceAgent} is waiting for your reply
              </div>
            </div>
            <div className="flex size-9 items-center justify-center rounded-2xl bg-amber-400/12 text-amber-100">
              <Sparkles className="size-4" />
            </div>
          </div>

          <div className="space-y-3 px-4 py-4">
            <p className="text-sm leading-6 text-amber-50/90">
              {pendingQuestion.content}
            </p>
            <div className="flex gap-2">
              <Input
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void handleAnswer();
                  }
                }}
                className="h-10 border-white/10 bg-black/20 text-amber-50 placeholder:text-amber-50/45"
                placeholder="Write your answer..."
                autoFocus
              />
              <Button
                onClick={() => void handleAnswer()}
                className="h-10 rounded-2xl bg-amber-400 px-4 text-slate-950 hover:bg-amber-300"
              >
                <Send className="size-4" />
                Send
              </Button>
            </div>
          </div>
        </section>
      )}

      <section className="flex min-h-0 flex-1 flex-col rounded-[28px] border border-white/8 bg-[#111320]/86 shadow-[0_24px_80px_rgba(3,6,20,0.45)] backdrop-blur-xl">
        <div className="flex items-center justify-between border-b border-white/6 px-5 py-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-indigo-300/80">
              Timeline
            </div>
            <div className="mt-1 text-sm font-semibold text-slate-100">
              Orchestration events
            </div>
          </div>
          <div className="flex size-9 items-center justify-center rounded-2xl bg-white/[0.04] text-slate-200">
            <Bot className="size-4" />
          </div>
        </div>

        <div className="min-h-0 space-y-3 overflow-y-auto px-4 py-4">
          {relevantMessages.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-5 text-sm text-slate-400">
              Orchestration events such as task assignment, review, and follow-up requests will stream here.
            </div>
          ) : (
            relevantMessages.map((message) => (
              <div
                key={message.id}
                className="rounded-2xl border border-white/6 bg-[#0b0d16]/78 px-4 py-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-semibold ${sourceTone(message.source)}`}>
                      {message.source.type === 'System' ? 'System' : message.source.name}
                    </span>
                    <span className="rounded-full border border-white/8 bg-white/[0.03] px-2 py-0.5 text-[10px] font-medium text-slate-400">
                      {messageTypeLabel(message.messageType)}
                    </span>
                  </div>
                  <span className="text-[11px] text-slate-500">
                    {formatTime(message.timestamp)}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-200">
                  {message.content}
                </p>
              </div>
            ))
          )}
        </div>
      </section>
    </aside>
  );
}
