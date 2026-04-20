/**
 * Turn a backend error string into a two-layer display shape:
 *
 *   - `summary` — short, user-facing sentence the UI puts in a toast /
 *     escalation header. Written in plain sentence case, no trailing
 *     period, no jargon. Safe to show to someone who's never looked at
 *     the Rust source.
 *   - `details` — the raw error (or a cleaned-up tail of it) that goes
 *     into a collapsible "show details" pane / tooltip. Preserves the
 *     verbatim message for debugging without cluttering the default
 *     view.
 *
 * The backend serializes errors in several shapes:
 *   - `AgentError::Display` output, e.g. "agent timed out after 120s",
 *     "agent refused the task: I can't do this", "plan output couldn't
 *     be parsed: missing field `title`", "agent run was cancelled",
 *     "agent process crashed (exit=Some(1), signal=None)", "couldn't
 *     spawn agent: binary not on PATH".
 *   - Lifecycle wrappers, e.g. "planning failed: {AgentError}",
 *     "recording approval failed: {storage err}", "merge failed:
 *     conflict in …".
 *   - `escalate_error_text` — "cancelled", or a passthrough of the
 *     underlying AgentError's `Display`.
 *
 * The mapper is intentionally string-pattern based: the wire format is
 * a bare string (see `run:failed` / `run:merge_conflict`), so we don't
 * have a tagged enum to match on. Prefer a narrow match over guessing
 * — if none of the patterns trigger, we fall through to a generic
 * "the run failed" summary with the raw text as details.
 */
export type AgentErrorDisplay = {
  summary: string;
  /** Verbatim error text (or a cleaned-up remnant). Undefined when the
   *  summary is already self-contained (e.g. "the run was cancelled"). */
  details?: string;
};

/** Lifecycle prefixes we strip before pattern-matching. Ordered by
 *  specificity — most specific first — so "recording approval failed:"
 *  beats a generic "failed:" match. */
const LIFECYCLE_PREFIXES: readonly string[] = [
  'planning failed: ',
  'failed to record plan: ',
  'recording approval failed: ',
  'merge failed: ',
  'worker failed: ',
];

/** Peel off the lifecycle wrapper (if any) to expose the underlying
 *  AgentError / storage error. Returns `[innerText, strippedPrefix]`
 *  where `strippedPrefix` is `undefined` if nothing was peeled. */
function stripPrefix(raw: string): { inner: string; prefix?: string } {
  for (const p of LIFECYCLE_PREFIXES) {
    if (raw.startsWith(p)) {
      return { inner: raw.slice(p.length), prefix: p };
    }
  }
  return { inner: raw };
}

/** Case-insensitive "starts with" — AgentError's Display emits
 *  lowercase, but user-supplied reasons can be anything. */
function startsWithI(s: string, needle: string): boolean {
  return s.toLowerCase().startsWith(needle.toLowerCase());
}

export function formatAgentError(err: string): AgentErrorDisplay {
  const trimmed = err.trim();
  if (trimmed.length === 0) {
    return { summary: 'the run failed' };
  }

  const { inner, prefix } = stripPrefix(trimmed);

  // Cancellation is the most common "not really an error" — don't show
  // a details pane, the summary already says everything.
  if (startsWithI(inner, 'agent run was cancelled') || inner === 'cancelled') {
    return { summary: 'the run was cancelled' };
  }

  if (startsWithI(inner, 'agent timed out after')) {
    return {
      summary: 'the agent timed out',
      details: inner,
    };
  }

  if (startsWithI(inner, 'agent refused the task')) {
    // "agent refused the task: {reason}" — surface the reason in the
    // summary so the user sees it without expanding details.
    const reason = inner.slice('agent refused the task: '.length).trim();
    return {
      summary: reason.length > 0 ? `the agent refused: ${reason}` : 'the agent refused the task',
      details: inner,
    };
  }

  if (startsWithI(inner, "plan output couldn't be parsed")) {
    return {
      summary: "the agent's plan couldn't be parsed",
      details: inner,
    };
  }

  if (startsWithI(inner, 'agent process crashed')) {
    return {
      summary: 'the agent process crashed',
      details: inner,
    };
  }

  if (startsWithI(inner, "couldn't spawn agent")) {
    return {
      summary: "couldn't start the agent",
      details: inner,
    };
  }

  // Lifecycle wrapper matched but the inner error didn't — use the
  // prefix to describe the phase, stash the inner as details.
  if (prefix) {
    // "planning failed: " → "planning failed"
    const phase = prefix.replace(/:\s*$/, '').trim();
    return {
      summary: phase,
      details: inner,
    };
  }

  // Last-resort fallback. Keep the summary generic; put the full
  // original in details so no information is lost.
  return {
    summary: 'the run failed',
    details: trimmed,
  };
}
