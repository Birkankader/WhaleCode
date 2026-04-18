import { AnimatePresence, motion } from 'framer-motion';
import { useShallow } from 'zustand/shallow';

import { useGraphStore } from '../../state/graphStore';
import { Button } from '../primitives/Button';

export function ApprovalBar() {
  const { status, proposedCount, selectedCount } = useGraphStore(
    useShallow((s) => ({
      status: s.status,
      proposedCount: s.subtasks.length,
      selectedCount: s.selectedSubtaskIds.size,
    })),
  );

  const visible = status === 'awaiting_approval';

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
