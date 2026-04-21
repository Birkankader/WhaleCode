/**
 * Phase 4 Step 4 — worktree inspection affordances on a worker card.
 *
 * Renders a folder-icon button on inspectable worker cards (done /
 * failed / human_escalation / cancelled). Clicking opens a small menu
 * with three actions:
 *   - **Reveal in file manager** → `revealWorktree` IPC. Success toast
 *     on launch, error toast if no file manager resolved.
 *   - **Copy path** → `getSubtaskWorktreePath` + `navigator.clipboard`.
 *     Success toast ("Path copied") on write, error toast when either
 *     the lookup rejects or the clipboard write throws (iframed / HTTP
 *     contexts).
 *   - **Open terminal at path** → `openTerminalAt` IPC. The command
 *     never rejects on "no terminal found"; a `clipboard-only` method
 *     prompts a local clipboard-write fallback + toast pointing the
 *     user to the now-copied path.
 *
 * Security: the path is never round-tripped as a frontend-controlled
 * argument. All three IPC calls take `(runId, subtaskId)` and the Rust
 * side owns the lookup → the UI cannot be tricked into revealing an
 * arbitrary path by tampering with props. Copy path does hold the
 * string briefly in-memory for `clipboard.writeText` but that's a user-
 * initiated side effect.
 *
 * Visibility gating: callers (`WorkerNode`) decide whether to mount this
 * component based on subtask state. The backend defends in depth —
 * `subtask_worktree_path_for_inspection` rejects pre-start states — so
 * a rendering slip surfaces as a toasted error, not an information leak.
 */

import { Folder } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import {
  getSubtaskWorktreePath,
  openTerminalAt,
  revealWorktree,
} from '../../lib/ipc';
import { useGraphStore } from '../../state/graphStore';
import { useToastStore } from '../../state/toastStore';

type Props = {
  /** Subtask id this menu inspects. */
  subtaskId: string;
};

type ActionKey = 'reveal' | 'copy' | 'terminal';

type ActionDef = {
  key: ActionKey;
  label: string;
};

const ACTIONS: readonly ActionDef[] = [
  { key: 'reveal', label: 'Reveal in file manager' },
  { key: 'copy', label: 'Copy path' },
  { key: 'terminal', label: 'Open terminal here' },
];

export function WorktreeActions({ subtaskId }: Props) {
  const runId = useGraphStore((s) => s.runId);
  const show = useToastStore((s) => s.show);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ActionKey | null>(null);
  const [highlight, setHighlight] = useState(0);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const listboxId = useId();

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const toggle = useCallback(() => {
    setOpen((o) => {
      if (!o) setHighlight(0);
      return !o;
    });
  }, []);

  // Outside-click dismiss. Same pointerdown pattern Dropdown uses —
  // the menu vanishes before the click lands on whatever the user
  // actually meant to target.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useLayoutEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open]);

  const runAction = useCallback(
    async (key: ActionKey) => {
      if (!runId) {
        // Store `runId` may be null between runs; the WorkerNode should
        // already have been unmounted, but defend anyway.
        show({ kind: 'error', message: 'No active run.' });
        return;
      }
      setBusy(key);
      try {
        if (key === 'reveal') {
          await revealWorktree(runId, subtaskId);
          show({ kind: 'success', message: 'Opened in file manager.' });
        } else if (key === 'copy') {
          const path = await getSubtaskWorktreePath(runId, subtaskId);
          await navigator.clipboard.writeText(path);
          show({ kind: 'success', message: 'Path copied to clipboard.' });
        } else if (key === 'terminal') {
          const res = await openTerminalAt(runId, subtaskId);
          if (res.method === 'spawned') {
            show({ kind: 'success', message: 'Opened terminal.' });
          } else {
            // No terminal emulator resolved — fall back to clipboard so
            // the user has something usable. If the clipboard write
            // itself fails (permissions, non-HTTPS iframe), surface an
            // error so the user knows both tiers missed.
            try {
              await navigator.clipboard.writeText(res.path);
              show({
                kind: 'info',
                message: 'No terminal detected — path copied instead.',
              });
            } catch {
              show({
                kind: 'error',
                message: 'No terminal detected and clipboard write failed.',
                autoDismissMs: null,
              });
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        show({ kind: 'error', message: msg, autoDismissMs: null });
      } finally {
        setBusy(null);
        close();
      }
    },
    [runId, subtaskId, show, close],
  );

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (h + 1) % ACTIONS.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h - 1 + ACTIONS.length) % ACTIONS.length);
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      setHighlight(0);
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      setHighlight(ACTIONS.length - 1);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const opt = ACTIONS[highlight];
      if (opt) void runAction(opt.key);
    }
  };

  return (
    <div
      className="nodrag nopan relative inline-block"
      // Stop bubbling so card-body click (expand toggle / selection
      // toggle) doesn't fire when the user is operating the menu.
      onClick={(e) => e.stopPropagation()}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label="Worktree actions"
        disabled={busy !== null}
        className="inline-flex size-6 items-center justify-center rounded-sm text-fg-tertiary hover:bg-bg-subtle hover:text-fg-primary disabled:cursor-not-allowed disabled:opacity-50"
        data-testid={`worktree-actions-trigger-${subtaskId}`}
      >
        <Folder size={12} />
      </button>
      {open ? (
        <ul
          ref={menuRef}
          id={listboxId}
          role="menu"
          aria-label="Worktree actions menu"
          aria-activedescendant={`${listboxId}-${ACTIONS[highlight]?.key ?? ''}`}
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
          className="nodrag nopan absolute right-0 z-50 mt-1 min-w-[180px] list-none overflow-hidden rounded-md border text-meta shadow-lg outline-none"
          style={{
            background: 'var(--color-bg-elevated)',
            borderColor: 'var(--color-border-default)',
            padding: 4,
          }}
          data-testid={`worktree-actions-menu-${subtaskId}`}
        >
          {ACTIONS.map((opt, idx) => {
            const highlighted = idx === highlight;
            const style: CSSProperties = {
              background: highlighted ? 'var(--color-bg-subtle)' : 'transparent',
              color: 'var(--color-fg-primary)',
            };
            return (
              <li
                key={opt.key}
                id={`${listboxId}-${opt.key}`}
                role="menuitem"
                aria-disabled={busy !== null}
                onClick={() => void runAction(opt.key)}
                onMouseEnter={() => setHighlight(idx)}
                className="flex cursor-pointer items-center rounded-sm px-2 py-1"
                style={style}
                data-testid={`worktree-actions-item-${opt.key}-${subtaskId}`}
              >
                <span>{opt.label}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
