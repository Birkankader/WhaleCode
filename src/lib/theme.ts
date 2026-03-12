/** Design tokens matching the DesktopApp mockup */
export const C = {
  bg: "#09090f",
  sidebar: "#0c0c14",
  panel: "#0f0f1a",
  surface: "#13131f",
  surfaceHover: "#191926",
  border: "#1c1c2e",
  borderStrong: "#252538",
  accent: "#6366f1",
  accentSoft: "#1e1b4b",
  accentText: "#a5b4fc",
  textPrimary: "#e2e8f0",
  textSecondary: "#8b8fa8",
  textMuted: "#4b4d66",
  green: "#4ade80",
  greenBg: "#052e16",
  greenBorder: "#14532d",
  amber: "#f59e0b",
  amberBg: "#1c1000",
  amberBorder: "#78350f",
  red: "#f87171",
  redBg: "#1f0000",
} as const;

export const STATUS: Record<string, { dot: string; label: string; bg: string; text: string }> = {
  done: { dot: C.green, label: "Done", bg: C.greenBg, text: C.green },
  running: { dot: C.amber, label: "In Progress", bg: C.amberBg, text: C.amber },
  queued: { dot: C.textMuted, label: "Queued", bg: "#0f0f1a", text: C.textSecondary },
  review: { dot: C.accentText, label: "Review", bg: C.accentSoft, text: C.accentText },
  orchestrating: { dot: "#8b5cf6", label: "Orchestrating", bg: C.accentSoft, text: C.accentText },
  idle: { dot: "#4b5563", label: "Idle", bg: "#0f0f1a", text: "#6b7280" },
};

export const LOG_COLOR: Record<string, string> = {
  info: C.textSecondary,
  success: C.green,
  warn: C.amber,
  cmd: C.accentText,
  error: C.red,
};
