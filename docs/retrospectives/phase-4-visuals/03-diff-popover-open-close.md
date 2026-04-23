# Visual obs 03 — diff popover open / close

**Recorded:** 2026-04-23 against a reference repo with a 3-file plan (one TS, one Rust, one Markdown).

## What to watch

- Cold-load (first open of session): popover shell paints instantly (file-name rows + `+N/−M` stat), `DiffBody` lazy chunk resolves in ~40-80ms on an M-class laptop, Shiki WASM/grammar fetch adds another ~80-120ms for the first language, each subsequent file reusing the cached grammar renders in ~10ms.
- Warm-cache (subsequent opens same session): popover opens with content already tokenised, no perceivable delay.
- Virtual-scroll: 10k-line synthetic fixture exercised via `DiffPopover.test.tsx` benchmark; interactive scroll stays at 60fps on the dev build.

## Observations

1. **Main bundle budget held.** Shiki + `@tanstack/virtual` split cleanly into async chunks (`core-*.js`, `tsx-*.js`, `rust-*.js`, etc.). Main bundle delta measured against Phase 3.5 baseline: +2.44 kB raw / +0.98 kB gzipped. Under the 5 kB budget.
2. **-U10 context flag** on the Rust side (Step 6 follow-up fix) means a single one-line change now shows the surrounding 10 lines. Previously -U3 felt cramped in review.
3. **Header chevron rotation** on expand/collapse is the only motion — no other decorative animation. Matches design-system discipline.
4. **Popover portal** — diff popover is not portaled (unlike WorktreeActions). It lives in the chip's local stacking context. Observed OK on single-row plans; flagged for Phase 5 if larger plans expose clipping.

## Regressions: none.
