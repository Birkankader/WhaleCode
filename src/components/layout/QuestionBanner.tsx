import { useState, useCallback } from 'react';
import { Send, SkipForward } from 'lucide-react';
import { toast } from 'sonner';
import { AGENTS } from '@/lib/agents';
import { humanizeError } from '@/lib/humanizeError';
import { commands } from '@/bindings';
import { useTaskStore, type ToolName } from '@/stores/taskStore';
import type { PendingQuestion } from '@/stores/taskStore';

interface QuestionBannerProps {
  pendingQuestion: PendingQuestion;
}

/**
 * Banner shown when an agent asks a question during orchestration.
 * Provides answer input + skip button. Self-contained state management.
 */
export function QuestionBanner({ pendingQuestion }: QuestionBannerProps) {
  const [questionAnswer, setQuestionAnswer] = useState('');
  const [answerSubmitting, setAnswerSubmitting] = useState(false);

  const agentKey = (['claude', 'gemini', 'codex'] as ToolName[]).find(
    (k) => pendingQuestion.sourceAgent.toLowerCase().includes(k),
  ) ?? 'claude';
  const agentInfo = AGENTS[agentKey];

  const handleAnswerQuestion = useCallback(async (answer: string) => {
    if (!pendingQuestion || answerSubmitting) return;
    setAnswerSubmitting(true);
    try {
      const result = await commands.answerUserQuestion(pendingQuestion.planId, answer);
      if (result.status === 'error') {
        toast.error('Failed to send answer', { description: humanizeError(result.error) });
      } else {
        useTaskStore.getState().setPendingQuestion(null);
        setQuestionAnswer('');
        useTaskStore.getState().addOrchestrationLog({
          agent: (pendingQuestion.sourceAgent as ToolName) || 'claude',
          level: 'info',
          message: `User answered: ${answer || '(skipped)'}`,
        });
      }
    } catch (e) {
      toast.error('Failed to send answer', { description: humanizeError(e) });
    } finally {
      setAnswerSubmitting(false);
    }
  }, [pendingQuestion, answerSubmitting]);

  return (
    <div className="shrink-0 border-b border-wc-amber/25 bg-[#0c0c1a]">
      <div className="flex flex-col gap-2.5 px-5 py-3.5">
        {/* Question header */}
        <div className="flex items-start gap-2.5">
          <div
            className="size-7 rounded-lg flex items-center justify-center text-xs font-bold text-white shrink-0 mt-px"
            style={{ background: agentInfo.gradient }}
          >
            {agentInfo.letter}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-wc-amber-bg text-wc-amber">
                Question
              </span>
              <span className="text-[11px] text-wc-text-muted">
                from {agentInfo.label}
              </span>
            </div>
            <div className="text-[13px] leading-5 text-wc-text-primary break-words">
              {pendingQuestion.content}
            </div>
          </div>
        </div>

        {/* Answer input */}
        <div className="flex items-center gap-2 ml-[38px]">
          <input
            type="text"
            value={questionAnswer}
            onChange={(e) => setQuestionAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && questionAnswer.trim()) {
                void handleAnswerQuestion(questionAnswer.trim());
              }
            }}
            placeholder="Type your answer..."
            className="flex-1 px-3 py-2 rounded-[10px] bg-wc-surface border border-wc-border-strong text-wc-text-primary text-xs font-[Inter,sans-serif] outline-none disabled:opacity-50"
            disabled={answerSubmitting}
            autoFocus
          />
          <button
            type="button"
            onClick={() => void handleAnswerQuestion(questionAnswer.trim())}
            disabled={!questionAnswer.trim() || answerSubmitting}
            className={`flex items-center gap-1.5 px-3.5 py-[7px] rounded-[10px] text-xs font-semibold font-[Inter,sans-serif] border-none transition-all ${
              questionAnswer.trim()
                ? 'bg-wc-accent text-white cursor-pointer'
                : 'bg-wc-border-strong text-wc-text-muted cursor-default'
            } ${answerSubmitting ? 'opacity-50' : ''}`}
          >
            <Send size={12} />
            {answerSubmitting ? 'Sending...' : 'Send'}
          </button>
          <button
            type="button"
            onClick={() => void handleAnswerQuestion('')}
            disabled={answerSubmitting}
            className={`flex items-center gap-1.5 px-3 py-[7px] rounded-[10px] bg-wc-surface text-wc-text-secondary text-xs font-semibold font-[Inter,sans-serif] border border-wc-border cursor-pointer transition-all ${answerSubmitting ? 'opacity-50' : ''}`}
          >
            <SkipForward size={12} />
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
