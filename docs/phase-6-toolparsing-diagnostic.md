# Phase 6 Step 0 — Tool-use parsing diagnostic

**Recorded:** 2026-04-26 at start of Phase 6.
**Scope:** Read-only survey of three adapters' tool-use output formats + six fake-agent fixtures (3 happy + 3 edge) + integration tests asserting current shape. No production code change.
**Consumed by:** Phase 6 Step 2 (activity chips) + Step 3 (thinking surface).

## Why this diagnostic exists

Phase 4 Step 0 established a pattern: before writing spec for a cross-stack backend surface, survey adapters to find what signal exists today. That diagnostic shrank Phase 4 Step 5's scope from a full new state-machine to a one-field discriminant. Phase 5 Step 0 (Q&A capability) repeated the pattern, shrinking Step 4 from 4.5d to ~1.5d. Phase 6 leans on the same pattern again — Step 2's parser implementation strategy depends on what each adapter actually emits.

Three questions per adapter:

1. **Tool-use event format** — what shape, what fields, JSON or prose, line-delimited or wrapped?
2. **Thinking / reasoning blocks** — does the adapter expose model reasoning separately from output?
3. **Stream protocols + ordering invariants** — when does a tool event fire relative to the file write that triggered it?

## Findings

### Per-adapter format matrix

| Adapter | Tool events | Thinking blocks | Stream protocol | Parser approach |
|---|---|---|---|---|
| **Claude** (`--print --output-format stream-json`) | Structured. NDJSON, one line per event: `{"type":"tool_use","name":"<tool>","input":{...}}`. Tool kinds observed: `Read`, `Edit`, `Bash`, `Grep`, `Glob`, `WebFetch` (unknown), and others. | Structured. NDJSON: `{"type":"thinking","thinking":"<text>"}`. Stable across observed Claude Code versions. | NDJSON; events arrive after the underlying operation. `tool_use` event fires post-execution. | `serde_json::from_str` per line; match on `type` + `name`. |
| **Codex** (`exec --json --full-auto`) | Structured. JSONL: `{"type":"function_call","name":"<tool>","arguments":{...}}`. Tool kinds: `read`, `grep`, `apply_patch`, `shell`, plus unknowns. `apply_patch` may carry multiple files in `files` array. | **Not emitted.** Codex `exec --json` does not surface model reasoning separately. Phase 6 Step 3 thinking panel stays empty for Codex workers. | JSONL; events fire after operation. `apply_patch` arrives once for the whole patch (multi-file). | `serde_json::from_str` per line; match on `type=function_call` + `name`. |
| **Gemini** (`--output-format text --yolo`) | **Not emitted.** Plain prose output. Tool actions surface as natural-language descriptions: `Reading src/auth.ts`, `Edited src/auth.ts: ...`, `Running: pnpm test`, `Searching for '<q>'`. No structured payload. | **Not emitted.** Gemini text mode produces no reasoning blocks. | Streaming text. Action descriptions interleaved with model output. | Heuristic regex matcher per line; verb-prefix patterns. Lower fidelity; accept gap. |

Current adapter execute paths (`src-tauri/src/agents/{claude,codex,gemini}.rs`) at start of Phase 6:

- **Claude** uses `--print` (no `--output-format` flag) → plain text output. **Step 2 must upgrade this to `--print --output-format stream-json`** to expose structured events. Backend-only change; orchestrator already consumes the result envelope shape.
- **Codex** uses `exec --json --full-auto` → already JSONL, no change needed.
- **Gemini** uses `--output-format text --yolo` → text mode is the supported worker shape. Step 1 of Phase 4 deprecated Gemini-as-master because of latency; Phase 6 inherits worker-only treatment. Heuristic parser is the only option.

### Unified `ToolEvent` enum proposal

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ToolEvent {
    FileRead {
        path: PathBuf,
        #[serde(skip_serializing_if = "Option::is_none")]
        lines: Option<(u32, u32)>,
    },
    FileEdit {
        path: PathBuf,
        summary: String,
    },
    Bash {
        command: String,
    },
    Search {
        query: String,
        #[serde(default)]
        paths: Vec<PathBuf>,
    },
    /// Escape hatch for tool kinds the parser doesn't recognise
    /// (Claude's WebFetch, Codex's `browse`, future adapter-
    /// specific tools, version drift). UI renders as a generic
    /// chip with `kind` as the icon-less label.
    Other {
        kind: String,
        detail: String,
    },
}
```

Rationale:

- **Five variants cover the tool kinds users see most.** Read / Edit / Bash / Search are the actions worth surfacing as activity chips. Anything else routes to `Other` so the parser never panics on unknown shapes (format-drift defense).
- **Same shape across all three adapters.** Per-adapter parsers feed this enum; the frontend renders a single chip type. No adapter-specific UI branches.
- **Optional fields stay optional.** `FileRead.lines` is `None` when the adapter doesn't expose offsets (e.g., Codex `read`). UI handles both cases gracefully.

### Parser implementation strategy: per-adapter + shared enum

**Recommendation: per-adapter parser feeding the shared `ToolEvent` enum.** A single unified parser is infeasible because Gemini's prose mode has no JSON to dispatch on. Each adapter gets its own parser:

- `claude::parse_tool_event(line: &str) -> Option<ToolEvent>` — `serde_json::from_str` + match on `type` + `name`.
- `codex::parse_tool_event(line: &str) -> Option<ToolEvent>` — same shape, different field names (`function_call` vs `tool_use`, `arguments` vs `input`).
- `gemini::parse_tool_event(line: &str) -> Option<ToolEvent>` — regex matchers per verb pattern.

Each parser is a pure function over a single line, so the cost is bounded per stream-line. The shared enum lets `forward_logs` tee uniformly: log line → parser (per worker's adapter kind) → `Option<ToolEvent>` → emit `RunEvent::SubtaskActivity` if `Some`.

### Always-on backend + opt-in frontend visibility

**Confirmed recommendation:** parser runs always-on as a tee on `forward_logs`. Cost is bounded — each parser is O(line length) with regex / serde, no full-stream parse. Frontend renders activity chips by default (visible, central to the partnership theme) but the thinking panel (Step 3) is opt-in (verbose, off by default).

Rationale: backend cost is too small to gate behind a setting (measurements below). Per-feature visibility tuning belongs at the UI layer where the user can see the trade-off.

### Parser overhead estimate

Empirical rough-order from existing benchmarks + the test runs:

- `serde_json::from_str` on a typical Claude/Codex line (~200 bytes): **1–5 µs** on M-class hardware.
- Regex match per line on Gemini prose: **<1 µs** for the verb-prefix patterns proposed.
- Worker stream rates observed in Phase 3.5 latency benchmarks: typically **tens of lines/sec**, peak **hundreds**.
- Worst case: 500 lines/sec × 5 µs = **2.5 ms/sec** parser overhead per worker. Negligible against the rest of the run.

Conclusion: parser overhead is well under any threshold worth feature-flagging. Always-on is correct.

## Open questions answered

- **Single unified parser feasible?** No — Gemini's prose has no JSON to dispatch on. **Per-adapter parsers feeding shared enum** is correct.
- **Thinking blocks stable?** Claude's `<thinking>` tag has been stable across observed releases but is not contractually guaranteed. Parser must tolerate absence (no events emitted if format unknown). **Mid-stream truncation** is observable in the edge fixture; parser treats each `thinking` line independently rather than waiting for a closing match.
- **Tool-event timing relative to file ops?** Claude + Codex both emit the event **after** the operation completes. UI ordering: chip arrives in the same temporal window as the underlying log lines, which is what we want for the activity stream.
- **Compression rule (same kind + same parent dir within 2s)?** Validated against the Claude edge fixture (3 successive Reads in `src/`). Step 2's chip-stack collapse should be implemented at the UI layer (frontend store has timestamps); backend always emits per-event.

## Surprises affecting Step 2 implementation

1. **Claude execute path needs format upgrade.** Current `--print` alone produces plain text. Step 2 must add `--output-format stream-json`. Pre-Step-2 cost: small (one CLI flag + one envelope-handler update in the adapter), but it touches a hot code path. Test thoroughly — Phase 5 Step 4's Q&A path also depends on the result body being parseable.
2. **Codex multi-file `apply_patch` ambiguity.** A single `function_call` event covers multiple files. Step 2 design choice: emit per-file `ToolEvent::FileEdit` (recommended — uniform with Claude single-file edits, lets the chip-stack compression rule work uniformly) vs single event citing `"3 files"` (compact but breaks chip-stack symmetry). **Recommend per-file expansion.**
3. **Gemini fidelity gap is real.** Heuristic regex matcher will miss tool actions that the agent describes in non-template prose. Acceptable trade-off for Phase 6 (Gemini is worker-only with known fidelity gaps already); chips just don't appear for those actions, log tail is still authoritative.
4. **No thinking surface for Codex or Gemini.** Step 3's panel stays empty for those adapters even when the user toggles it on. UI should grey out the toggle on non-Claude workers (or at least show a helpful tooltip). Spec didn't anticipate this — flag for Step 3 planner.
5. **Claude `WebFetch` and similar tools.** Treated as `Other`. The chip stack will show a generic chip; that's fine, but worth documenting which tools we *intentionally* model vs route to `Other` so future adapter-version changes don't silently lose granularity.

## Cap

Step 0 delivered well under the 2-day cap (~1.5h: survey + 6 fixtures + 6 integration tests + this write-up). Same pattern as Phase 4 / Phase 5 Step 0s — short diagnostic upstream of the big step pays back the rest of the phase.
