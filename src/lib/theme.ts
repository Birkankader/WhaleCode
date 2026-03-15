/**
 * Design tokens — resolved from CSS custom properties.
 * The canonical values live in index.css (--color-wc-*).
 * This object provides JS access for the few places that still need it.
 *
 * PREFER Tailwind classes (bg-wc-accent, text-wc-text-primary, etc.) over C.* in new code.
 * @deprecated Use Tailwind wc-* classes directly. This exists for gradual migration.
 */
export const C = {
  bg: "var(--color-wc-bg)",
  sidebar: "var(--color-wc-sidebar)",
  panel: "var(--color-wc-panel)",
  surface: "var(--color-wc-surface)",
  surfaceHover: "var(--color-wc-surface-hover)",
  border: "var(--color-wc-border)",
  borderStrong: "var(--color-wc-border-strong)",
  accent: "var(--color-wc-accent)",
  accentSoft: "var(--color-wc-accent-soft)",
  accentText: "var(--color-wc-accent-text)",
  textPrimary: "var(--color-wc-text-primary)",
  textSecondary: "var(--color-wc-text-secondary)",
  textMuted: "var(--color-wc-text-muted)",
  green: "var(--color-wc-green)",
  greenBg: "var(--color-wc-green-bg)",
  greenBorder: "var(--color-wc-green-border)",
  amber: "var(--color-wc-amber)",
  amberBg: "var(--color-wc-amber-bg)",
  amberBorder: "var(--color-wc-amber-border)",
  red: "var(--color-wc-red)",
  redBg: "var(--color-wc-red-bg)",
} as const;

export const STATUS: Record<string, { dot: string; label: string; bg: string; text: string }> = {
  done: { dot: C.green, label: "Done", bg: C.greenBg, text: C.green },
  running: { dot: C.amber, label: "In Progress", bg: C.amberBg, text: C.amber },
  queued: { dot: C.textMuted, label: "Queued", bg: C.panel, text: C.textSecondary },
  review: { dot: C.accentText, label: "Review", bg: C.accentSoft, text: C.accentText },
  orchestrating: { dot: C.accent, label: "Orchestrating", bg: C.accentSoft, text: C.accentText },
  failed: { dot: C.red, label: "Failed", bg: C.redBg, text: C.red },
  blocked: { dot: C.red, label: "Blocked", bg: C.redBg, text: C.red },
  retrying: { dot: C.amber, label: "Retrying", bg: C.amberBg, text: C.amber },
  idle: { dot: C.textMuted, label: "Idle", bg: C.panel, text: C.textSecondary },
};

export const LOG_COLOR: Record<string, string> = {
  info: C.textSecondary,
  success: C.green,
  warn: C.amber,
  cmd: C.accentText,
  error: C.red,
};
