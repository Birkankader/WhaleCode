import { AnimatePresence, motion } from 'framer-motion';
import { useShallow } from 'zustand/shallow';

import { isSelectable, useAgentStore } from '../../state/agentStore';
import { useGraphStore } from '../../state/graphStore';
import type { AgentKind } from '../../lib/ipc';
import { Button } from '../primitives/Button';

const AGENT_ORDER: readonly AgentKind[] = ['claude', 'codex', 'gemini'];

/**
 * Pick a sensible default worker for a newly-added subtask:
 * 1. the master's recommended master (they're often the strongest local CLI),
 *    if that agent is installed and available;
 * 2. otherwise the first available agent in canonical order.
 *
 * Falls back to `claude` if nothing is detected — the backend will reject the
 * add if the agent isn't actually available, and the error will surface via
 * `currentError`. That's cleaner than crashing or hiding the button.
 */
function defaultWorkerAgent(
  detection: ReturnType<typeof useAgentStore.getState>['detection'],
): AgentKind {
  if (!detection) return 'claude';
  const recommended = detection.recommendedMaster;
  if (recommended && isSelectable(detection[recommended])) return recommended;
  for (const agent of AGENT_ORDER) {
    if (isSelectable(detection[agent])) return agent;
  }
  return 'claude';
}

export function ApprovalBar() {
  const { status, proposedCount, selectedCount } = useGraphStore(
    useShallow((s) => ({
      status: s.status,
      proposedCount: s.subtasks.length,
      selectedCount: s.selectedSubtaskIds.size,
    })),
  );
  const detection = useAgentStore((s) => s.detection);

  const visible = status === 'awaiting_approval';

  const onAddSubtask = async () => {
    const agent = defaultWorkerAgent(detection);
    try {
      await useGraphStore.getState().addSubtask({
        title: '',
        why: null,
        assignedWorker: agent,
      });
      // On success the backend emits run:subtasks_proposed with the new row;
      // the store sets `lastAddedSubtaskId` which the freshly-mounted
      // WorkerNode reads to auto-enter edit mode on its title.
    } catch {
      // addSubtask already populated currentError — ErrorBanner surfaces it.
    }
  };

  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          key="approval-bar"
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="absolute inset-x-0 bottom-0 flex h-14 items-center justify-between bg-bg-elevated px-4"
          style={{ borderTop: '1px solid var(--color-agent-master)' }}
          role="region"
          aria-label="Approval bar"
        >
          <div className="flex items-center gap-2">
            <span
              className="block size-1.5 rounded-full"
              style={{ background: 'var(--color-agent-master)' }}
              aria-hidden
            />
            <span className="text-meta text-fg-primary">
              Master proposes {proposedCount} subtask{proposedCount === 1 ? '' : 's'}. Approve to
              start.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onAddSubtask}>
              + Add subtask
            </Button>
            <Button variant="ghost" onClick={() => useGraphStore.getState().rejectAll()}>
              Reject all
            </Button>
            <Button
              variant="secondary"
              disabled={selectedCount === 0}
              onClick={() => {
                const ids = Array.from(useGraphStore.getState().selectedSubtaskIds);
                useGraphStore.getState().approveSubtasks(ids);
              }}
            >
              Approve selected
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const ids = useGraphStore.getState().subtasks.map((s) => s.id);
                useGraphStore.getState().approveSubtasks(ids);
              }}
            >
              Approve all
            </Button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
