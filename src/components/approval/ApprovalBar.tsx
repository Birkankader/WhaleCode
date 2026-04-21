import { AnimatePresence, motion } from 'framer-motion';
import { useShallow } from 'zustand/shallow';

import { isSelectable, useAgentStore } from '../../state/agentStore';
import { useGraphStore } from '../../state/graphStore';
import type { AgentKind } from '../../lib/ipc';
import { Button } from '../primitives/Button';

const AGENT_ORDER: readonly AgentKind[] = ['claude', 'codex', 'gemini'];

/**
 * Placeholder title for a freshly user-added subtask. The backend rejects
 * empty titles at `add_subtask`, so sending `''` never produces a new
 * card — the IPC errors before `lastAddedSubtaskId` is set and the user
 * sees only a confusing "Title is required" banner with nowhere to type.
 * Sending a visible placeholder makes the backend accept, the
 * `run:subtasks_proposed` event re-emits, the new WorkerNode mounts with
 * `lastAddedSubtaskId` set, and its title InlineTextEdit auto-enters
 * edit mode with the placeholder pre-selected — so the user's first
 * keystroke replaces it.
 */
const DEFAULT_NEW_SUBTASK_TITLE = 'Untitled subtask';

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
  const { status, proposedCount, selectedCount, isReplan } = useGraphStore(
    useShallow((s) => {
      // Replan mode: at least one subtask in the plan carries a
      // non-empty `replaces`, which only the master's Layer-2 replan
      // populates. Strictly stronger signal than any transient store
      // flag — it's derived from the plan itself, so out-of-order
      // events can't desync it.
      const isReplan = s.subtasks.some((st) => st.replaces.length > 0);
      // In replan mode the prior run's done / failed subtasks are
      // still in `s.subtasks`; only the replacements are currently
      // awaiting approval. Count by node-machine state so the copy
      // matches what the user sees. Falls back to the full list length
      // for the initial approval (every actor just landed in
      // `proposed`, so the counts match).
      const proposedCount = isReplan
        ? s.subtasks.reduce((n, st) => {
            const snap = s.nodeSnapshots.get(st.id)?.value;
            return snap === 'proposed' ? n + 1 : n;
          }, 0)
        : s.subtasks.length;
      return {
        status: s.status,
        proposedCount,
        selectedCount: s.selectedSubtaskIds.size,
        isReplan,
      };
    }),
  );
  const detection = useAgentStore((s) => s.detection);

  const visible = status === 'awaiting_approval';

  const onAddSubtask = async () => {
    const agent = defaultWorkerAgent(detection);
    try {
      await useGraphStore.getState().addSubtask({
        title: DEFAULT_NEW_SUBTASK_TITLE,
        why: null,
        assignedWorker: agent,
      });
      // On success the backend emits run:subtasks_proposed with the new row;
      // the store sets `lastAddedSubtaskId` which the freshly-mounted
      // WorkerNode reads to auto-enter edit mode on its title. The title
      // input pre-selects the placeholder (see InlineTextEdit focus effect)
      // so typing immediately replaces it.
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
              {isReplan
                ? `Master proposes ${proposedCount} replacement subtask${proposedCount === 1 ? '' : 's'}. Approve to continue.`
                : `Master proposes ${proposedCount} subtask${proposedCount === 1 ? '' : 's'}. Approve to start.`}
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
