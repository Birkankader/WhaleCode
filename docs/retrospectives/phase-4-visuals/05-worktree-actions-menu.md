# Visual obs 05 — worktree actions menu

**Recorded:** 2026-04-23 on macOS, reference repo, Terminal.app default.

## What to watch

- Trigger: folder icon in the footer of done / failed / human_escalation / cancelled cards.
- Menu: portaled to `document.body` via `createPortal`; fixed-position `top/left` computed from trigger viewport rect in a `useLayoutEffect` pre-paint. Flips above the trigger when `spaceBelow < MENU_H_EST + gap`.
- Keyboard: ArrowUp / ArrowDown / Home / End / Enter / Space / Escape / Tab all honoured.
- Actions: Reveal in file manager → `revealWorktree` IPC; Copy path → `getSubtaskWorktreePath` + `navigator.clipboard.writeText`; Open terminal → `openTerminalAt` IPC.
- Fallback: when no terminal resolved (`method === 'clipboard-only'`), path is copied to clipboard with an info toast "No terminal detected — path copied instead."

## Observations

1. **Portal z-index fix.** Pre-portaling (before Step 6 fix commit `787ed01`), a merge card one row below overlapped the menu because the React Flow transform created a stacking context. Portaling to `document.body` escaped it. Verified menu items are now clickable over the merge card.
2. **Keyboard nav** works without hover. Tab into the footer, Enter opens, Arrow Down moves highlight, Enter activates. Escape returns focus to the trigger.
3. **Security guard** — argv-structured Command API, no `sh -c` interpolation. Manual check of `open_terminal_at` for macOS forces `open -a Terminal <path>` with `path` as a separate argv arg.
4. **Toast stack** persists error toasts (clipboard failure, no-terminal-and-clipboard-failed) with `autoDismissMs: null` so the user can act on them.

## Regressions: none after the portal fix.
