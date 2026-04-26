//! Phase 6 Step 2 — unified `ToolEvent` enum + per-adapter parsers.
//!
//! Each adapter funnels its tool-use output through a small parser
//! that returns zero or more `ToolEvent`s per stream line. The enum
//! is the single shared shape the dispatcher emits via
//! `RunEvent::SubtaskActivity` and the frontend renders as activity
//! chips on running worker cards.
//!
//! Three per-adapter parsers (single unified parser is infeasible —
//! Gemini emits prose with no JSON to dispatch on; see Step 0
//! diagnostic):
//!   `claude::parse_tool_events`  — stream-json NDJSON
//!   `codex::parse_tool_events`   — exec --json JSONL
//!   `gemini::parse_tool_events`  — prose verb-prefix regex matchers
//!
//! Cost: <2.5 ms/sec per worker at peak rates measured in Phase 3.5.
//! Always-on backend tee on `forward_logs` per the diagnostic's
//! recommendation.

#![allow(dead_code)] // Production wire-up lands as part of Step 2.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Phase 6 Step 2 — what the worker is doing right now, structured
/// for the activity chip surface. Five variants cover the tool kinds
/// users see most; `Other` is the escape hatch for unmodeled tools
/// (Claude `WebFetch`, Codex `browse`, future adapter-specific tools,
/// version drift). Wire shape is `{"kind":"<kebab>", …extra}`,
/// matching the Phase 4 Step 5 `ErrorCategoryWire` discriminant
/// pattern so the frontend's Zod parser handles it consistently.
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
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        paths: Vec<PathBuf>,
    },
    /// Unmodeled tools and parse fallthroughs. UI renders a generic
    /// chip without an icon-style hint. `tool_name` is the original
    /// tool name from the adapter (`WebFetch`, `browse`, etc.) —
    /// renamed from `kind` because serde's discriminator already
    /// claims the `kind` field on the wire. `detail` is a short
    /// human-readable summary the parser extracted (often the first
    /// few fields of the `input` / `arguments` payload).
    Other {
        tool_name: String,
        detail: String,
    },
}

impl ToolEvent {
    /// Optional accessor — returns the path the event references if
    /// any. Used by the frontend's chip-compression rule (same kind
    /// + same parent dir within a window).
    pub fn primary_path(&self) -> Option<&std::path::Path> {
        match self {
            ToolEvent::FileRead { path, .. } | ToolEvent::FileEdit { path, .. } => Some(path),
            _ => None,
        }
    }
}
