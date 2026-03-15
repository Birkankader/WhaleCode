import { memo, useEffect, useRef } from 'react';
import { Check, X } from 'lucide-react';
import { C } from '@/lib/theme';
import { useTaskStore, type OrchestrationPhase } from '@/stores/taskStore';
import { useElapsedTime, formatElapsed } from '@/hooks/useElapsedTime';

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
                className={isActive ? 'stage-pulse' : ''}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 10px',
                  borderRadius: 999,
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: 'Inter, sans-serif',
                  whiteSpace: 'nowrap',
                  transition: 'all 300ms ease',
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

                {/* Label */}
                <span>{stage.label}</span>

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
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
});
