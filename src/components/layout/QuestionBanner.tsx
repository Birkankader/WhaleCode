import { useState, useCallback } from 'react';
import { Send, SkipForward } from 'lucide-react';
import { toast } from 'sonner';
import { C } from '@/lib/theme';
import { AGENTS } from '@/lib/agents';
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
        toast.error('Failed to send answer', { description: String(result.error) });
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
      toast.error('Failed to send answer', { description: String(e) });
    } finally {
      setAnswerSubmitting(false);
    }
  }, [pendingQuestion, answerSubmitting]);

  return (
    <div
      className="flex-shrink-0 border-b"
      style={{
        background: '#0c0c1a',
        borderColor: C.amber + '40',
      }}
    >
      <div
        style={{
          padding: '14px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {/* Question header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              background: agentInfo.gradient,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 12,
              fontWeight: 700,
              color: '#fff',
              flexShrink: 0,
              marginTop: 1,
            }}
          >
            {agentInfo.letter}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: C.amberBg,
                  color: C.amber,
                }}
              >
                Question
              </span>
              <span style={{ fontSize: 11, color: C.textMuted }}>
                from {agentInfo.label}
              </span>
            </div>
            <div
              style={{
                fontSize: 13,
                lineHeight: '20px',
                color: C.textPrimary,
                wordBreak: 'break-word',
              }}
            >
              {pendingQuestion.content}
            </div>
          </div>
        </div>

        {/* Answer input */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 38 }}>
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
            style={{
              flex: 1,
              padding: '8px 12px',
              borderRadius: 10,
              background: C.surface,
              border: `1px solid ${C.borderStrong}`,
              color: C.textPrimary,
              fontSize: 12,
              fontFamily: 'Inter, sans-serif',
              outline: 'none',
            }}
            disabled={answerSubmitting}
            autoFocus
          />
          <button
            type="button"
            onClick={() => void handleAnswerQuestion(questionAnswer.trim())}
            disabled={!questionAnswer.trim() || answerSubmitting}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '7px 14px',
              borderRadius: 10,
              background: questionAnswer.trim() ? C.accent : C.borderStrong,
              color: questionAnswer.trim() ? '#fff' : C.textMuted,
              fontSize: 12,
              fontWeight: 600,
              fontFamily: 'Inter, sans-serif',
              border: 'none',
              cursor: questionAnswer.trim() ? 'pointer' : 'default',
              opacity: answerSubmitting ? 0.5 : 1,
              transition: 'all 150ms ease',
            }}
          >
            <Send size={12} />
            {answerSubmitting ? 'Sending...' : 'Send'}
          </button>
          <button
            type="button"
            onClick={() => void handleAnswerQuestion('')}
            disabled={answerSubmitting}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '7px 12px',
              borderRadius: 10,
              background: C.surface,
              color: C.textSecondary,
              fontSize: 12,
              fontWeight: 600,
              fontFamily: 'Inter, sans-serif',
              border: `1px solid ${C.border}`,
              cursor: 'pointer',
              opacity: answerSubmitting ? 0.5 : 1,
              transition: 'all 150ms ease',
            }}
          >
            <SkipForward size={12} />
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
