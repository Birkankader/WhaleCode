import { memo, useCallback, useEffect, useRef } from 'react';
import { Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { C } from '@/lib/theme';
import { useTaskStore, type OrchestrationPhase } from '@/stores/taskStore';
import { useElapsedTime, formatElapsed } from '@/hooks/useElapsedTime';
import { commands } from '@/bindings';

/* ── Stage definitions ─────────────────────────────────── */

interface Stage {
  key: string;
  label: string;
  phases: OrchestrationPhase[]; // phases that make this stage "active"
}

const STAGES: Stage[] = [
  { key: 'decompose', label: 'Decompose', phases: ['decomposing'] },
  { key: 'approve', label: 'Approve', phases: ['awaiting_approval'] },
  { key: 'execute', label: 'Execute', phases: ['executing'] },
  { key: 'review', label: 'Review', phases: ['reviewing'] },
  { key: 'done', label: 'Done', phases: ['completed'] },
];

/** Map orchestrationPhase to active stage index (0-based), or -1 for idle */
function getActiveIndex(phase: OrchestrationPhase): number {
  if (phase === 'idle') return -1;
  if (phase === 'failed') return -1; // handled separately
  return STAGES.findIndex((s) => s.phases.includes(phase));
}

/** Find the stage index where failure occurred (the last completed + 1, or first active) */
function getFailedIndex(phase: OrchestrationPhase, prevPhaseRef: React.MutableRefObject<OrchestrationPhase>): number {
  if (phase !== 'failed') return -1;
  const prev = prevPhaseRef.current;
  const prevIndex = getActiveIndex(prev);
  return prevIndex >= 0 ? prevIndex : 0;
}

/* ── Component ─────────────────────────────────────────── */

export const StagePipeline = memo(function StagePipeline() {
  const phase = useTaskStore((s) => s.orchestrationPhase);
  const prevPhaseRef = useRef<OrchestrationPhase>('idle');

  // Track the previous non-failed phase
  useEffect(() => {
    if (phase !== 'failed') {
      prevPhaseRef.current = phase;
    }
  }, [phase]);

  const activeIndex = getActiveIndex(phase);
  const failedIndex = getFailedIndex(phase, prevPhaseRef);
  const isFailed = phase === 'failed';

  // Elapsed timer runs when there's an active (non-idle, non-completed, non-failed) stage
  const hasActiveStage = activeIndex >= 0 && phase !== 'completed';
  const elapsed = useElapsedTime(hasActiveStage);

  // Decomposing banner state (merged inline)
  const orchestrationPlan = useTaskStore((s) => s.orchestrationPlan);
  const activePlan = useTaskStore((s) => s.activePlan);
  const masterAgent = orchestrationPlan?.masterAgent ?? 'claude';

  const handleCancel = useCallback(async () => {
    const taskId = activePlan?.task_id;
    if (!taskId) {
      toast.error('No active task to cancel');
      return;
    }
    try {
      const result = await commands.cancelProcess(taskId);
      if (result.status === 'error') {
        toast.error('Cancel failed', { description: String(result.error) });
      } else {
        toast.success('Orchestration cancelled');
        useTaskStore.getState().setOrchestrationPhase('failed');
        useTaskStore.getState().addOrchestrationLog({
          agent: masterAgent,
          level: 'warn',
          message: 'Orchestration cancelled by user',
        });
      }
    } catch (e) {
      toast.error('Cancel failed', { description: String(e) });
    }
  }, [activePlan, masterAgent]);

  if (phase === 'idle') return null;

  return (
    <div
      className="flex items-center justify-center gap-0 px-5 py-2 border-b flex-shrink-0"
      style={{
        borderColor: C.border,
        background: C.bg,
        minHeight: 44,
      }}
    >
      {STAGES.map((stage, i) => {
        const isActive = i === activeIndex && !isFailed;
        const isCompleted = isFailed
          ? i < failedIndex
          : phase === 'completed'
            ? true
            : i < activeIndex;
        const isStageFailed = isFailed && i === failedIndex;
        const isDecomposing = stage.key === 'decompose' && isActive;

        return (
          <div key={stage.key} className="flex items-center">
            {/* Connector line (not before first) */}
            {i > 0 && (
              <div
                style={{
                  width: 28,
                  height: 2,
                  borderRadius: 1,
                  background: isCompleted
                    ? C.green
                    : isActive
                      ? C.accent
                      : isStageFailed
                        ? C.red
                        : C.borderStrong,
                  transition: 'background 300ms ease',
                  flexShrink: 0,
                }}
              />
            )}

            {/* Stage node */}
            <div className="flex items-center gap-1.5 relative">
              <div
                className={[
                  isActive ? 'stage-pulse' : '',
                  isDecomposing ? 'decomposing-shimmer' : '',
                ].filter(Boolean).join(' ')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: isDecomposing ? '4px 12px' : '4px 10px',
                  borderRadius: 999,
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: 'Inter, sans-serif',
                  whiteSpace: 'nowrap',
                  transition: 'all 300ms ease',
                  position: 'relative',
                  overflow: isDecomposing ? 'hidden' : undefined,
                  background: isActive
                    ? C.accentSoft
                    : isCompleted
                      ? C.greenBg
                      : isStageFailed
                        ? C.redBg
                        : 'transparent',
                  color: isActive
                    ? C.accentText
                    : isCompleted
                      ? C.green
                      : isStageFailed
                        ? C.red
                        : C.textMuted,
                  border: `1px solid ${
                    isActive
                      ? `${C.accent}50`
                      : isCompleted
                        ? C.greenBorder
                        : isStageFailed
                          ? '#ef444460'
                          : C.border
                  }`,
                }}
              >
                {/* Icon */}
                {isCompleted && (
                  <Check size={12} strokeWidth={3} />
                )}
                {isStageFailed && (
                  <X size={12} strokeWidth={3} />
                )}
                {isActive && (
                  <span
                    className="stage-dot-pulse"
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: C.accent,
                      flexShrink: 0,
                    }}
                  />
                )}

                {/* Label — enriched when decomposing */}
                {isDecomposing ? (
                  <>
                    <span>Analyzing</span>
                    <span style={{ color: C.textSecondary, fontSize: 11 }}>
                      <span className="decomposing-dot" style={{ animationDelay: '0ms' }}>.</span>
                      <span className="decomposing-dot" style={{ animationDelay: '200ms' }}>.</span>
                      <span className="decomposing-dot" style={{ animationDelay: '400ms' }}>.</span>
                    </span>
                  </>
                ) : (
                  <span>{stage.label}</span>
                )}

                {/* Elapsed time (only on active stage) */}
                {isActive && elapsed > 0 && (
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 500,
                      color: C.textSecondary,
                      marginLeft: 2,
                    }}
                  >
                    {formatElapsed(elapsed)}
                  </span>
                )}

                {/* Inline cancel button (decomposing only) */}
                {isDecomposing && (
                  <button
                    onClick={handleCancel}
                    className="flex items-center justify-center flex-shrink-0 transition-colors"
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: '50%',
                      background: 'transparent',
                      border: 'none',
                      color: C.textMuted,
                      cursor: 'pointer',
                      marginLeft: 2,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = C.redBg;
                      e.currentTarget.style.color = C.red;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent';
                      e.currentTarget.style.color = C.textMuted;
                    }}
                  >
                    <X size={10} strokeWidth={2.5} />
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
});
