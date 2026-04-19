import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

/**
 * Minimal keyboard-navigable dropdown. Used for worker-selection on proposed
 * subtask nodes; generic enough to reuse for any enumeration.
 *
 * Keyboard:
 * - ArrowDown / ArrowUp: move highlight
 * - Home / End: first / last option
 * - Enter / Space: commit highlighted option
 * - Escape: close without committing
 * - Tab: close + let browser move focus
 *
 * Lives inside a React Flow node, so trigger + menu wear `nodrag nopan` to
 * defeat pan-on-drag. Menu is absolutely positioned below the trigger; caller
 * is responsible for giving the enclosing container enough room.
 */
export type DropdownOption<T extends string> = {
  value: T;
  label: ReactNode;
  /** Hint shown to the right of the label in the menu, e.g. "cyan chip". */
  hint?: ReactNode;
};

export type DropdownProps<T extends string> = {
  value: T;
  options: readonly DropdownOption<T>[];
  onChange: (next: T) => void;
  renderTrigger: (args: {
    value: T;
    open: boolean;
    toggle: () => void;
    triggerRef: React.RefObject<HTMLButtonElement | null>;
  }) => ReactNode;
  ariaLabel: string;
};

export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  renderTrigger,
  ariaLabel,
}: DropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(() =>
    Math.max(0, options.findIndex((o) => o.value === value)),
  );

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  const listboxId = useId();

  const close = useCallback(() => {
    setOpen(false);
    // Return focus to the trigger so keyboard users don't lose their place.
    triggerRef.current?.focus();
  }, []);

  const commit = useCallback(
    (next: T) => {
      if (next !== value) onChange(next);
      setOpen(false);
      // Same focus-return behavior — matches native <select>.
      triggerRef.current?.focus();
    },
    [onChange, value],
  );

  const toggle = useCallback(() => {
    setOpen((o) => {
      if (!o) {
        // Re-anchor highlight to current value each time we open.
        const idx = options.findIndex((o) => o.value === value);
        setHighlight(idx >= 0 ? idx : 0);
      }
      return !o;
    });
  }, [options, value]);

  // Close on outside click. We listen on pointerdown so the menu disappears
  // before the click lands on whatever the user is trying to interact with.
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

  // Focus the menu when it opens so arrow keys land here, not on the trigger.
  useLayoutEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open]);

  const onMenuKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Tab') {
      // Let the browser handle focus progression; just close.
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (h + 1) % options.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h - 1 + options.length) % options.length);
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      setHighlight(0);
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      setHighlight(options.length - 1);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const opt = options[highlight];
      if (opt) commit(opt.value);
    }
  };

  return (
    <div className="nodrag nopan relative inline-block">
      {renderTrigger({ value, open, toggle, triggerRef })}
      {open ? (
        <ul
          ref={menuRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={`${listboxId}-${options[highlight]?.value ?? ''}`}
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
          className="nodrag nopan absolute z-50 mt-1 min-w-[140px] list-none overflow-hidden rounded-md border text-meta shadow-lg outline-none"
          style={{
            background: 'var(--color-bg-elevated)',
            borderColor: 'var(--color-border-default)',
            padding: 4,
          }}
        >
          {options.map((opt, idx) => {
            const active = opt.value === value;
            const highlighted = idx === highlight;
            const style: CSSProperties = {
              background: highlighted ? 'var(--color-bg-subtle)' : 'transparent',
              color: 'var(--color-fg-primary)',
            };
            return (
              <li
                key={opt.value}
                id={`${listboxId}-${opt.value}`}
                role="option"
                aria-selected={active}
                onClick={() => commit(opt.value)}
                onMouseEnter={() => setHighlight(idx)}
                className="flex cursor-pointer items-center justify-between rounded-sm px-2 py-1"
                style={style}
              >
                <span>{opt.label}</span>
                {opt.hint ? (
                  <span className="ml-2 text-hint text-fg-tertiary">{opt.hint}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
