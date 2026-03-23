import { toast } from 'sonner';
import { useTaskStore, type TaskEntry } from '@/stores/taskStore';

const UNDO_TIMEOUT_MS = 5000;

/**
 * Remove a task with undo support.
 * Shows a toast with an "Undo" button that restores the task within 5 seconds.
 */
export function removeTaskWithUndo(taskId: string, label?: string) {
  const store = useTaskStore.getState();
  const task = store.tasks.get(taskId);
  if (!task) {
    store.removeTask(taskId);
    return;
  }

  // Save a snapshot before removing
  const snapshot: TaskEntry = { ...task };
  store.removeTask(taskId);

  const displayLabel = label || snapshot.description || 'Task';

  toast.info(`"${displayLabel}" removed`, {
    duration: UNDO_TIMEOUT_MS,
    action: {
      label: 'Undo',
      onClick: () => {
        // Restore the task from snapshot
        useTaskStore.getState().addTask(snapshot);
      },
    },
  });
}
