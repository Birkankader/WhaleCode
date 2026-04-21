/**
 * One-shot consent modal shown the first time the user flips
 * `autoApprove` on. After the user confirms, `SettingsPanel` persists
 * both `autoApprove: true` and `autoApproveConsentGiven: true`, so
 * subsequent toggles skip this modal entirely. The flag is never
 * un-set — turning auto-approve off doesn't re-arm the consent gate
 * because the user already read and agreed to the warnings once.
 *
 * The modal is deliberately keyboard-trap-free: Escape cancels, outside
 * click cancels, the primary button confirms. No focus-stealing beyond
 * the initial cancel-default focus so screen readers can orient
 * themselves.
 */

import { useEffect } from 'react';

import { Button } from '../primitives/Button';

type Props = {
  onConfirm: () => void;
  onCancel: () => void;
};

export function AutoApproveConsentModal({ onConfirm, onCancel }: Props) {
  useEffect(() => {
    // Give Escape precedence over the SettingsPanel's own Escape
    // handler by stopping propagation; the panel's effect already
    // bails when `consentOpen` is true, but this keeps the modal
    // self-contained.
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => {
        // Outside-click cancels. Clicks originating inside the dialog
        // are stopped on the child onMouseDown below.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="auto-approve-consent-title"
        aria-describedby="auto-approve-consent-body"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex w-[420px] max-w-[92vw] flex-col gap-4 rounded-md border border-border-default bg-bg-elevated p-6 shadow-xl"
      >
        <h2
          id="auto-approve-consent-title"
          className="text-body font-medium text-fg-primary"
        >
          Enable auto-approve?
        </h2>
        <div
          id="auto-approve-consent-body"
          className="flex flex-col gap-2 text-meta text-fg-secondary"
        >
          <p>
            The approval bar will be skipped for initial plans and
            master replans — workers start immediately once the plan
            is generated.
          </p>
          <p>
            Layer 3 human escalations still require your input, and
            applying changes to your repo still needs an explicit
            click.
          </p>
          <p className="text-fg-tertiary">
            Heads up: safety gates (file-write, shell-command
            filtering) are not yet implemented. Review the plan
            carefully the first few runs.
          </p>
        </div>
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} autoFocus>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Enable auto-approve
          </Button>
        </div>
      </div>
    </div>
  );
}
