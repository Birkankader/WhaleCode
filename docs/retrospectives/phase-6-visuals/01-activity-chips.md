# Visual obs 01 — activity chips on worker cards (Step 2)

## What to watch

- Submit a multi-worker task on a Claude / Codex / Gemini mix.
- Watch each running worker card for the chip stack above the
  log tail as the agent works.
- Verify per-adapter parsing fidelity, compression on
  same-kind / same-dir bursts, the 5-visible / 50-stored cap,
  and a11y `aria-label`s.

## Observations

- **Claude worker (`--print --output-format stream-json`).**
  NDJSON tool-use events surface as typed chips in real time:
  `Read src/auth.ts` → `FileRead`, `Edit src/auth.ts: …` →
  `FileEdit`, `Bash $"pnpm test"` → `Bash`, `Grep "TODO"` →
  `Search`. Icons match (file, edit, terminal, search). Order
  matches log lines because the parser tees `forward_logs` —
  log line first, chip emit second, no reorder.
- **Codex worker (`exec --json --full-auto`).** JSONL
  `function_call` events parse cleanly. The `apply_patch` event
  carrying multiple files in `files[]` expands to one `FileEdit`
  chip per file, so a 4-file patch produces four chips back-to-
  back. Compression (`FileEdit` × 4 in same dir within 2s)
  collapses them to a single `Editing 4 files in src/auth/` chip.
  No raw `apply_patch` chip leaks through.
- **Gemini worker (`--output-format text --yolo`).** Heuristic
  regex matcher catches the verb-prefix patterns documented in
  Step 0 (`Reading X`, `Edited X: …`, `Running: <cmd>`,
  `Searching for '<q>'`). Fidelity gap is real — when Gemini
  switches to a colon-prefix variant the parser falls through
  and no chip emits. Log line still shows. Acceptable per Step 0
  recommendation (heuristic-only, route unknowns to silence).
- **Stack rendering.** Latest 5 chips visible, horizontal layout
  above log tail, fade-in on enter, no fade-out (kept simple per
  spec). Older chips push left, the 6th drops out without
  animation. Mid-ellipsis truncation kicks in around 40 chars
  (`src/…/long-deeply-nested-name.ts`).
- **Memory cap.** The 100-event integration flood test
  (`activityCompression` + `graphStore` integration suite)
  asserts the store holds exactly 50 most recent. Visual matches —
  scrolling back through dev tools store snapshot shows oldest
  events have rotated off without panic or stutter.
- **A11y.** Each chip's `aria-label` reads "Reading file
  src/auth.ts" / "Running shell command pnpm test" / etc. — full
  context, screen-reader friendly. Verified via VoiceOver pass on
  one running card.

Regressions: none. Log tail rendering unchanged from Phase 4.
