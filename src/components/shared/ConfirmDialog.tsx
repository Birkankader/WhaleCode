import { useCallback, useEffect, useRef, useState } from 'react';

/* ── Types ─────────────────────────────────────────────── */

interface ConfirmOptions {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface ConfirmDialogProps {
  open: boolean;
  options: ConfirmOptions | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/* ── Hook ──────────────────────────────────────────────── */

export function useConfirmDialog() {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setOptions(opts);
      setOpen(true);
    });
  }, []);

  const handleConfirm = useCallback(() => {
    setOpen(false);
    resolveRef.current?.(true);
    resolveRef.current = null;
  }, []);

  const handleCancel = useCallback(() => {
    setOpen(false);
    resolveRef.current?.(false);
    resolveRef.current = null;
  }, []);

  return {
    confirm,
    ConfirmDialogElement: (
      <ConfirmDialog
        open={open}
        options={options}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    ),
  };
}

/* ── Component ─────────────────────────────────────────── */

function ConfirmDialog({ open, options, onConfirm, onCancel }: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onCancel]);

  // Focus trap
  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  if (!open || !options) return null;

  const isDestructive = options.destructive ?? false;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-[4px]"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="flex flex-col gap-4 p-5 rounded-2xl outline-none w-[380px] bg-wc-panel border border-wc-border-strong shadow-[0_20px_60px_rgba(0,0,0,0.7)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-1.5">
          <h3 className="text-sm font-bold text-wc-text-primary">
            {options.title}
          </h3>
          <p className="text-xs leading-relaxed text-wc-text-secondary">
            {options.description}
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="text-xs font-medium px-4 py-1.5 rounded-lg transition-all bg-wc-surface text-wc-text-secondary border border-wc-border hover:bg-wc-surface-hover"
          >
            {options.cancelLabel || 'Cancel'}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`text-xs font-semibold px-4 py-1.5 rounded-lg transition-all text-white border-none hover:brightness-110 ${
              isDestructive ? 'bg-red-500' : 'bg-wc-accent'
            }`}
          >
            {options.confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
