import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';

import { describeErrorCategory, sameErrorCategoryKind } from '../../lib/errorCategory';
import type { ErrorCategoryWire } from '../../lib/ipc';
import { useGraphStore } from '../../state/graphStore';
import { Banner } from '../primitives/Banner';

type Variant = 'error' | 'warning';

type Props = {
  /**
   * Visual accent. Phase 2 always renders 'error'; 'warning' is wired now so
   * Phase 3 can surface non-fatal signals without refactoring this component.
   */
  variant?: Variant;
};

export function ErrorBanner({ variant = 'error' }: Props) {
  const currentError = useGraphStore((s) => s.currentError);
  const dismissError = useGraphStore((s) => s.dismissError);
  // Phase 4 Step 5: per-subtask error categories collected from
  // `SubtaskStateChanged(Failed)` payloads. When every entry agrees on
  // `kind` (including the common N=1 case) we derive a category-
  // specific banner headline from the locked copy table; otherwise we
  // fall back to the generic error summary below. The Map identity
  // flips on each update so a useMemo keyed on it is cheap.
  const subtaskErrorCategories = useGraphStore((s) => s.subtaskErrorCategories);
  const categoryDismissed = useGraphStore((s) => s.errorCategoryBannerDismissed);
  // Phase 5 Step 2: one-click remediation for `BaseBranchDirty`.
  const baseBranchDirty = useGraphStore((s) => s.baseBranchDirty);
  const stashInFlight = useGraphStore((s) => s.stashInFlight);
  const stashAndRetryApply = useGraphStore((s) => s.stashAndRetryApply);
  // Phase 5 Step 3: resolver action for merge conflicts.
  const mergeConflict = useGraphStore((s) => s.mergeConflict);
  const setConflictResolverOpen = useGraphStore((s) => s.setConflictResolverOpen);
  const [expanded, setExpanded] = useState(false);

  const unanimousCategory = useMemo(
    () => unanimousKind(subtaskErrorCategories),
    [subtaskErrorCategories],
  );
  // Honor the per-session dismissal latch: once the user clicks X on a
  // category banner, hide it until a new kind lands. `currentError`
  // keeps its own null-means-hidden contract from Phase 2.
  const effectiveCategory = categoryDismissed ? null : unanimousCategory;

  const { summary, details } = deriveSummary(currentError, effectiveCategory);
  const accentFg =
    variant === 'warning'
      ? 'var(--color-status-pending)'
      : 'var(--color-status-failed)';
  // The banner is visible whenever we have something to say — either a
  // free-form error string from the store or at least one classified
  // subtask failure that hasn't been dismissed. Pre-Step-5 backends
  // only populate `currentError`; Step-5+ backends can populate the
  // category map alone. Phase 5 Step 3 adds mergeConflict as a third
  // trigger — surfaces the "Open resolver" action even if the user
  // dismissed the error text.
  const visible =
    currentError !== null ||
    effectiveCategory !== null ||
    mergeConflict !== null;

  // Derive conflict-specific headline when no other signal dominates.
  // `currentError` takes precedence (e.g., BaseBranchDirty → stash UI
  // still has its copy); otherwise `mergeConflict` drives the text so
  // the banner is never empty when the resolver is actionable.
  const effectiveSummary =
    currentError === null && effectiveCategory === null && mergeConflict
      ? mergeConflict.retryAttempt > 0
        ? `Still conflicted on ${mergeConflict.files.length} file${mergeConflict.files.length === 1 ? '' : 's'} (attempt ${mergeConflict.retryAttempt})`
        : `Merge conflict on ${mergeConflict.files.length} file${mergeConflict.files.length === 1 ? '' : 's'}`
      : summary;

  const actions = (
    <>
      {mergeConflict !== null ? (
        <button
          type="button"
          onClick={() => setConflictResolverOpen(true)}
          aria-label="Open conflict resolver"
          data-testid="error-banner-open-resolver"
          className="inline-flex flex-shrink-0 items-center rounded-sm border border-fg-secondary/40 px-2 py-0.5 text-meta font-medium text-fg-primary hover:border-fg-primary"
          style={{ color: accentFg }}
        >
          Open resolver
        </button>
      ) : null}
      {baseBranchDirty !== null ? (
        <button
          type="button"
          onClick={() => {
            // Don't await — the store sets `stashInFlight` before
            // the IPC fires, which flips our disabled state. The
            // promise resolves when the backend emits
            // `StashCreated` (clears baseBranchDirty) or rejects
            // (surfaced via currentError by the store).
            void stashAndRetryApply();
          }}
          disabled={stashInFlight === 'stash-and-retry'}
          aria-label="Stash and retry apply"
          data-testid="error-banner-stash-retry"
          className="inline-flex flex-shrink-0 items-center rounded-sm border border-fg-secondary/40 px-2 py-0.5 text-meta font-medium text-fg-primary hover:border-fg-primary disabled:cursor-wait disabled:opacity-60"
          style={{ color: accentFg }}
        >
          {stashInFlight === 'stash-and-retry'
            ? 'Stashing…'
            : 'Stash & retry apply'}
        </button>
      ) : null}
    </>
  );

  return (
    <Banner
      variant={variant}
      visible={visible}
      testId="error-banner"
      role="alert"
      ariaLive="assertive"
      dataAttrs={{ 'category-kind': effectiveCategory?.kind }}
      onDismiss={() => {
        setExpanded(false);
        dismissError();
      }}
      dismissLabel="Dismiss error"
      actions={actions}
    >
      <span className="text-body" data-testid="error-banner-summary">
        {effectiveSummary}
      </span>
      {details ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex w-fit items-center gap-1 text-meta text-fg-secondary hover:text-fg-primary"
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>{expanded ? 'Hide details' : 'Show details'}</span>
        </button>
      ) : null}
      {details && expanded ? (
        <pre
          className="max-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded-sm bg-bg-subtle px-2 py-1.5 text-meta text-fg-secondary"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {details}
        </pre>
      ) : null}
    </Banner>
  );
}

/**
 * Split a raw error string into the first line (summary) and the rest (details).
 * Single-line errors have no details; multi-line errors keep the tail in a
 * collapsed mono block. Keeping this as pure text avoids needing a structured
 * error type before Phase 3 defines one.
 */
function splitError(err: string | null): { summary: string; details: string | null } {
  if (err === null) return { summary: '', details: null };
  const idx = err.indexOf('\n');
  if (idx === -1) return { summary: err, details: null };
  return {
    summary: err.slice(0, idx).trimEnd(),
    details: err.slice(idx + 1).trimEnd() || null,
  };
}

/**
 * Compose the banner's headline and detail body.
 *
 * Precedence rules (Phase 4 Step 5):
 *   1. If every failed subtask reports the same `ErrorCategoryWire`
 *      kind, the headline is the locked per-category copy. Any
 *      free-form `currentError` text becomes the collapsed detail
 *      body so nothing the backend produced is lost.
 *   2. Otherwise (no categories, or conflicting kinds), fall back to
 *      `splitError(currentError)` — pre-Step-5 behavior.
 *
 * Keeping this pure and outside the component keeps the render path
 * trivial and lets tests exercise the derivation without mounting.
 */
function deriveSummary(
  currentError: string | null,
  unanimous: ErrorCategoryWire | null,
): { summary: string; details: string | null } {
  if (unanimous !== null) {
    const headline = describeErrorCategory(unanimous);
    // The free-form `currentError` still carries useful stderr /
    // reason text — push it to the expandable detail body verbatim
    // so power users can read it without clicking into the node.
    const detail = currentError && currentError.trim().length > 0 ? currentError : null;
    return { summary: headline, details: detail };
  }
  return splitError(currentError);
}

/**
 * Reduce a category map to a single representative variant if — and
 * only if — every entry agrees on `kind`. The empty map, and any map
 * whose entries disagree, both return `null`. Timeout variants compare
 * structurally on `kind` only (two subtasks that both timed out at
 * different deadlines still collapse to one banner; the
 * representative's `afterSecs` is used for the copy).
 *
 * Exported-in-module only; the banner is the single consumer.
 */
function unanimousKind(map: Map<string, ErrorCategoryWire>): ErrorCategoryWire | null {
  let rep: ErrorCategoryWire | null = null;
  for (const cat of map.values()) {
    if (rep === null) {
      rep = cat;
      continue;
    }
    if (!sameErrorCategoryKind(rep, cat)) return null;
  }
  return rep;
}
