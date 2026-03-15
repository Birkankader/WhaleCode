import { memo, useCallback } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { C } from '@/lib/theme';
import { AGENTS } from '@/lib/agents';
import { useTaskStore } from '@/stores/taskStore';
import { commands } from '@/bindings';
import { useElapsedTime, formatElapsed } from '@/hooks/useElapsedTime';

/* ── Component ─────────────────────────────────────────── */

export const DecomposingBanner = memo(function DecomposingBanner() {
  const phase = useTaskStore((s) => s.orchestrationPhase);
  const orchestrationPlan = useTaskStore((s) => s.orchestrationPlan);
  const activePlan = useTaskStore((s) => s.activePlan);
  const elapsed = useElapsedTime(phase === 'decomposing');

  const masterAgent = orchestrationPlan?.masterAgent ?? 'claude';
  const agent = AGENTS[masterAgent];

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

  if (phase !== 'decomposing') return null;

  return (
    <div
      className="decomposing-banner flex-shrink-0"
      style={{
        position: 'relative',
        overflow: 'hidden',
        borderBottom: `1px solid ${C.border}`,
      }}
    >
      {/* Shimmer background layer */}
      <div
        className="decomposing-shimmer"
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0.6,
          pointerEvents: 'none',
        }}
      />

      {/* Gradient border glow along bottom edge */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 1,
          background: `linear-gradient(90deg, transparent, ${agent.color}60, ${agent.color}30, transparent)`,
          pointerEvents: 'none',
        }}
      />

      {/* Content */}
      <div
        className="flex items-center gap-4 px-5 py-3 relative"
        style={{
          background: `linear-gradient(135deg, ${C.panel} 0%, ${C.bg} 100%)`,
          zIndex: 1,
        }}
      >
        {/* Agent icon */}
        <div
          className="flex items-center justify-center flex-shrink-0"
          style={{
            width: 32,
            height: 32,
            borderRadius: 10,
            background: agent.gradient,
            boxShadow: `0 0 16px ${agent.color}30`,
            fontSize: 14,
            fontWeight: 700,
            color: '#fff',
          }}
        >
          {agent.letter}
        </div>

        {/* Text content */}
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: C.textPrimary,
                fontFamily: 'Inter, sans-serif',
              }}
            >
              Analyzing your task
            </span>
            {/* Animated dots */}
            <span className="decomposing-dots" style={{ color: C.textSecondary, fontSize: 13 }}>
              <span className="decomposing-dot" style={{ animationDelay: '0ms' }}>.</span>
              <span className="decomposing-dot" style={{ animationDelay: '200ms' }}>.</span>
              <span className="decomposing-dot" style={{ animationDelay: '400ms' }}>.</span>
            </span>
          </div>
          <span
            style={{
              fontSize: 11,
              color: C.textSecondary,
              fontFamily: 'Inter, sans-serif',
            }}
          >
            {agent.label} is breaking down the task into sub-tasks
          </span>
        </div>

        {/* Timer */}
        <div
          className="flex items-center gap-1.5 flex-shrink-0"
          style={{
            padding: '3px 10px',
            borderRadius: 999,
            background: C.surface,
            border: `1px solid ${C.border}`,
            fontSize: 11,
            fontWeight: 600,
            fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
            color: C.textSecondary,
            minWidth: 48,
            justifyContent: 'center',
          }}
        >
          {formatElapsed(elapsed)}
        </div>

        {/* Cancel button */}
        <button
          onClick={handleCancel}
          className="flex items-center gap-1.5 flex-shrink-0 transition-all"
          style={{
            padding: '5px 12px',
            borderRadius: 8,
            background: 'transparent',
            border: `1px solid ${C.borderStrong}`,
            color: C.textSecondary,
            fontSize: 11,
            fontWeight: 600,
            fontFamily: 'Inter, sans-serif',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = C.redBg;
            e.currentTarget.style.borderColor = '#ef444460';
            e.currentTarget.style.color = C.red;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.borderColor = C.borderStrong;
            e.currentTarget.style.color = C.textSecondary;
          }}
        >
          <X size={12} />
          Cancel
        </button>
      </div>
    </div>
  );
});
