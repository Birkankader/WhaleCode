/**
 * Inline settings panel used by the TopBar gear affordance.
 *
 * Scope is deliberately narrow: the three Phase 3 Step 7 knobs
 * (auto-approve toggle, per-run subtask ceiling, preferred editor) plus
 * the consent-modal gate. Everything else (binary paths, telemetry,
 * etc.) lives in the fuller settings page Phase 6 will build.
 *
 * First-time activation gates through `AutoApproveConsentModal`: the
 * toggle's actual IPC write only happens after the modal resolves,
 * so clicking Cancel leaves both the toggle and the persisted flag
 * in their pre-click state. That's why the `checked` state here
 * reflects the *persisted* settings, not a local pending value.
 *
 * Draft sync: the numeric/editor inputs are local drafts committed on
 * blur. The outer `SettingsPanel` wrapper keys the inner body on the
 * persisted values so a backend re-emit re-seeds the drafts by
 * remount — no passive prop→state sync effect, matching the
 * convention in `InlineTextEdit.tsx`.
 */

import { useEffect, useRef, useState } from 'react';

import { type Settings } from '../../lib/ipc';
import { useRepoStore } from '../../state/repoStore';
import { AutoApproveConsentModal } from './AutoApproveConsentModal';

type Props = {
  /** Close handler; invoked when the user clicks outside or presses Escape. */
  onClose: () => void;
};

export function SettingsPanel({ onClose }: Props) {
  const settings = useRepoStore((s) => s.settings);
  if (!settings) return null;
  // Key on the persisted values we mirror into drafts. A backend re-emit
  // with a new ceiling or editor remounts the body, which re-runs the
  // lazy `useState` init with the fresh values. The user's in-progress
  // edit is lost in that case — which is fine, re-emits while the
  // panel is open are only possible via another client, not a UI the
  // user has focus in.
  const key = `${settings.maxSubtasksPerAutoApprovedRun}:${settings.editor ?? ''}`;
  return <SettingsBody key={key} settings={settings} onClose={onClose} />;
}

function SettingsBody({
  settings,
  onClose,
}: {
  settings: Settings;
  onClose: () => void;
}) {
  const updateSettings = useRepoStore((s) => s.updateSettings);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const [consentOpen, setConsentOpen] = useState(false);
  const [maxDraft, setMaxDraft] = useState<string>(
    String(settings.maxSubtasksPerAutoApprovedRun),
  );
  const [editorDraft, setEditorDraft] = useState<string>(settings.editor ?? '');
  const [saveError, setSaveError] = useState<string | null>(null);

  // Close on outside click or Escape. The panel lives in a portal-less
  // inline position so we filter clicks by ref containment.
  useEffect(() => {
    function onPointer(e: MouseEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      // Don't close while the modal is open — clicks on it shouldn't
      // fall through to close the panel.
      if (consentOpen) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !consentOpen) onClose();
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, consentOpen]);

  async function persist(
    patch: Parameters<typeof updateSettings>[0],
  ): Promise<void> {
    setSaveError(null);
    try {
      await updateSettings(patch);
    } catch (err) {
      setSaveError(String(err));
    }
  }

  function handleToggleAutoApprove() {
    if (settings.autoApprove) {
      // Turning off is direct — no consent needed.
      void persist({ autoApprove: false });
      return;
    }
    if (!settings.autoApproveConsentGiven) {
      // First activation ever: gate through the modal. Persistence
      // happens inside `handleConsentConfirm`.
      setConsentOpen(true);
      return;
    }
    void persist({ autoApprove: true });
  }

  function handleConsentConfirm() {
    setConsentOpen(false);
    void persist({ autoApprove: true, autoApproveConsentGiven: true });
  }

  function handleConsentCancel() {
    setConsentOpen(false);
  }

  function handleMaxBlur() {
    const parsed = Number.parseInt(maxDraft, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      // Revert to the persisted value on bad input instead of silently
      // persisting garbage.
      setMaxDraft(String(settings.maxSubtasksPerAutoApprovedRun));
      setSaveError('Ceiling must be a positive integer.');
      return;
    }
    if (parsed === settings.maxSubtasksPerAutoApprovedRun) return;
    void persist({ maxSubtasksPerAutoApprovedRun: parsed });
  }

  function handleEditorBlur() {
    const trimmed = editorDraft.trim();
    const current = settings.editor ?? '';
    if (trimmed === current) return;
    void persist({ editor: trimmed === '' ? null : trimmed });
  }

  return (
    <>
      <div
        ref={panelRef}
        role="dialog"
        aria-label="Settings"
        className="absolute right-0 top-full z-20 mt-1 flex min-w-[280px] flex-col gap-3 rounded-md border border-border-default bg-bg-elevated p-3 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <label
            htmlFor="auto-approve-toggle"
            className="flex-1 cursor-pointer select-none text-meta text-fg-primary"
          >
            Auto-approve plans
          </label>
          <button
            id="auto-approve-toggle"
            type="button"
            role="switch"
            aria-checked={settings.autoApprove}
            aria-label="Auto-approve plans"
            onClick={handleToggleAutoApprove}
            className="relative h-5 w-9 rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-agent-master)]"
            style={{
              background: settings.autoApprove
                ? 'var(--color-agent-master)'
                : 'var(--color-bg-subtle)',
            }}
          >
            <span
              className="absolute top-0.5 left-0.5 block size-4 rounded-full bg-bg-primary transition-transform"
              style={{
                transform: settings.autoApprove ? 'translateX(16px)' : 'none',
              }}
            />
          </button>
        </div>

        {settings.autoApprove ? (
          <div className="flex items-center justify-between gap-3">
            <label
              htmlFor="auto-approve-max"
              className="text-meta text-fg-secondary"
            >
              Max subtasks per run
            </label>
            <input
              id="auto-approve-max"
              type="number"
              min={1}
              value={maxDraft}
              onChange={(e) => setMaxDraft(e.target.value)}
              onBlur={handleMaxBlur}
              className="w-20 rounded-sm border border-border-default bg-bg-primary px-2 py-1 text-meta text-fg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-agent-master)]"
            />
          </div>
        ) : null}

        <div className="flex flex-col gap-1">
          <label htmlFor="editor-binary" className="text-meta text-fg-secondary">
            Editor (Layer 3 escalation)
          </label>
          <input
            id="editor-binary"
            type="text"
            placeholder="code, nvim, subl…"
            value={editorDraft}
            onChange={(e) => setEditorDraft(e.target.value)}
            onBlur={handleEditorBlur}
            className="rounded-sm border border-border-default bg-bg-primary px-2 py-1 text-meta text-fg-primary placeholder:text-fg-tertiary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-agent-master)]"
          />
        </div>

        {saveError ? (
          <span role="alert" className="text-hint text-[var(--color-status-failed)]">
            {saveError}
          </span>
        ) : null}
      </div>

      {consentOpen ? (
        <AutoApproveConsentModal
          onConfirm={handleConsentConfirm}
          onCancel={handleConsentCancel}
        />
      ) : null}
    </>
  );
}
