//! Tauri IPC layer: typed wire contract between the React frontend and the
//! Rust backend. Commands are invoked from the frontend; events flow the
//! other way. The shapes here are mirrored by hand in `src/lib/ipc.ts`
//! (Zod schemas) — keep the two in sync when editing either side.
//!
//! Phase 2 step 1: the commands are stubs. They log the call, emit any
//! obvious events (e.g. `run:status_changed`), and return placeholder data.
//! Real orchestration lands in step 8.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub mod commands;
pub mod events;

pub type RunId = String;
pub type SubtaskId = String;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum AgentKind {
    Claude,
    Codex,
    Gemini,
}

impl AgentKind {
    /// Whether this agent is eligible to act as the master (planner /
    /// replanner). Gemini is worker-only until upstream latency
    /// improves — see `docs/KNOWN_ISSUES.md` "Gemini CLI is too slow
    /// to use as master" for the Phase 3.5 benchmark that led here
    /// and Phase 4 Step 1 for the decision to restrict it.
    pub fn supports_master(&self) -> bool {
        match self {
            AgentKind::Claude | AgentKind::Codex => true,
            AgentKind::Gemini => false,
        }
    }

    /// Whether this agent can be dispatched as a worker on a
    /// subtask. Currently every supported CLI qualifies; this is
    /// here as the symmetric counterpart to [`Self::supports_master`]
    /// so call sites read intent-forward and future additions have a
    /// single predicate to flip.
    #[allow(dead_code)] // symmetric pair with supports_master; picks up callers in later phases
    pub fn supports_worker(&self) -> bool {
        matches!(self, AgentKind::Claude | AgentKind::Codex | AgentKind::Gemini)
    }
}

/// One-shot notice surfaced to the frontend at boot when a settings
/// migration rewrote the user's stored preference. Today the only
/// producer is the Phase 4 Step 1 "Gemini worker-only" migration
/// (master agent was `gemini` → flipped to the default master);
/// later phases can add variants by extending [`MigrationKind`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationNotice {
    pub kind: MigrationKind,
    /// Human-readable sentence for the banner. The Rust side owns
    /// the copy so the frontend doesn't have to localise variant
    /// keys — it just renders the string.
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MigrationKind {
    /// User had `masterAgent: "gemini"` in their settings. Phase 4
    /// Step 1 made Gemini worker-only, so the stored value was
    /// replaced with the built-in default (`AgentKind::Claude`) on
    /// the next boot.
    GeminiMasterDemoted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum AgentStatus {
    Available {
        version: String,
        #[serde(rename = "binaryPath")]
        binary_path: PathBuf,
    },
    Broken {
        #[serde(rename = "binaryPath")]
        binary_path: PathBuf,
        error: String,
    },
    NotInstalled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetectionResult {
    pub claude: AgentStatus,
    pub codex: AgentStatus,
    pub gemini: AgentStatus,
    pub recommended_master: Option<AgentKind>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RunStatus {
    Idle,
    Planning,
    AwaitingApproval,
    Running,
    Merging,
    Done,
    Rejected,
    Failed,
    Cancelled,
    /// Phase 3 Step 5: Layer-3 human escalation is active. The lifecycle
    /// task is parked on a resolution channel (see
    /// [`crate::orchestration::lifecycle::Layer3Decision`]) while the UI
    /// surfaces the "open in editor / skip / replan again / abort"
    /// choices. This is a non-terminal state — resolution moves the run
    /// back to `Running` (Fixed/Skipped/ReplanRequested) or forward to
    /// `Cancelled`/`Failed` (Aborted/crash recovery). `list_active_runs`
    /// includes it so a crash during escalation is swept on reboot.
    AwaitingHumanFix,
}

// SubtaskState / SubtaskData / FileDiff / RunSummary are scaffolding for the
// orchestrator (step 8). They travel across IPC event payloads; the command
// stubs in step 1 don't construct them yet.
//
// Phase 3 adds `Retrying` — the transient state a subtask enters between
// Layer-1 failure and its second attempt. No frontend bridge behaviour
// until Step 3a wires `START_RETRY` / `RETRY_SUCCESS` / `RETRY_FAIL` in
// `eventsForSubtaskState`; for now the variant is declared and the store
// treats it as a no-op.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SubtaskState {
    Proposed,
    Waiting,
    Running,
    Retrying,
    Done,
    Failed,
    Skipped,
    /// Phase 5 Step 1: user-initiated per-worker stop. Terminal,
    /// user-intent (distinct from orchestrator-intent `Failed` /
    /// `Skipped`). Dispatcher skips Layer 1 retry, Layer 2 replan, and
    /// Layer 3 escalation entirely for subtasks that land here via the
    /// `manual_cancel` flag set on the runtime row. Dependents cascade
    /// to `Skipped` via the same path `Failed` takes.
    Cancelled,
    /// Phase 5 Step 4: worker emitted a question (heuristic: last
    /// non-empty stdout chunk ends in `?`) and is paused pending the
    /// user's answer. Transient, non-terminal — answer restarts the
    /// worker with the user's reply appended to the prompt; skip /
    /// timeout finalize with the current output as Done. Dispatch is
    /// gated while in this state (no new work scheduled), but the
    /// subtask row is still considered "in progress" for the run's
    /// "all terminal" exit predicate.
    AwaitingInput,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtaskData {
    pub id: SubtaskId,
    pub title: String,
    pub why: Option<String>,
    pub assigned_worker: AgentKind,
    pub dependencies: Vec<SubtaskId>,
    /// Subtask ids this one replaces. Empty for freshly-planned
    /// subtasks; populated (usually with one id) when the master
    /// produced this subtask as part of a Layer-2 replan. The
    /// frontend uses it to render the "replaces #N" badge on the
    /// replacement node. Serialized as `[]` when empty so the Zod
    /// schema can default without needing `#[serde(skip)]`.
    #[serde(default)]
    pub replaces: Vec<SubtaskId>,
    /// How many replans have already fired in this subtask's lineage.
    /// `0` for a freshly-planned subtask; up to
    /// [`crate::orchestration::lifecycle::REPLAN_LINEAGE_CAP`] for a
    /// replacement. The frontend uses it to hide the "Try replan
    /// again" button once the budget is exhausted (Commit 2b of
    /// Phase 3 Step 5). Absent on the wire in older runs so it
    /// defaults to 0 rather than requiring migration.
    #[serde(default)]
    pub replan_count: u32,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    /// Change classification. Phase 4 Step 6: added so the frontend
    /// can distinguish add / modify / delete / rename / binary
    /// variants in the inline diff preview without re-parsing the
    /// unified-diff header. Mirrors the discriminated shape of
    /// `worktree::FileDiff` but with `String` paths (the worktree
    /// type uses `PathBuf`, which doesn't round-trip through JSON
    /// losslessly on non-UTF8 systems; on wire we've already
    /// lossy-converted in `worktree_to_ipc_diff`).
    pub status: DiffStatus,
    pub additions: u32,
    pub deletions: u32,
    /// Unified diff patch body ready to feed into a syntax
    /// highlighter. Phase 4 Step 6: added so the inline preview in
    /// `DiffPopover` can render real hunks instead of just a +N/-M
    /// stat line. Empty for `Binary` files (we never computed a
    /// patch) and for Phase-3.5-era events the frontend falls back
    /// to the stat-only rendering when the field is empty.
    pub unified_diff: String,
}

/// Wire-level classification of a changed file. `#[serde(tag = "kind"
/// , rename_all = "kebab-case")]` keeps the JSON shape aligned with
/// the other `kind`-tagged unions the frontend consumes
/// (`ErrorCategoryWire`, `DiffStatus` on the internal worktree type).
/// `Renamed` carries the previous path so the UI can render a
/// "`old` → `new`" header row.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DiffStatus {
    Added,
    Modified,
    Deleted,
    Renamed {
        #[serde(rename = "from")]
        from: String,
    },
    Binary,
}

/// What the frontend sees on `run:completed`. Intentionally lean:
/// Phase 6 adds cost tracking, Phase 3 will add retry stats.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: RunId,
    /// Subtasks that actually ran (approved minus cascade-skipped).
    pub subtask_count: u32,
    /// Unique file paths touched by the merged result.
    pub files_changed: u32,
    /// Wall-clock `finished_at - started_at` in whole seconds.
    pub duration_secs: u64,
    /// One commit per merged subtask (from `MergeResult::commits_created`).
    pub commits_created: u32,
}

/// Partial update for a proposed subtask. Every field is independently
/// optional — absent / JSON `null` on the wire means "leave this field
/// alone". For [`Self::why`], `Some(s)` where `s` is empty is treated
/// as "clear to `None`" by the orchestrator; this matches the Phase 3
/// edit-row UI, which has a single textbox that turns empty on
/// clearing.
///
/// Phase 3 Q1 deferral: dependencies are not exposed here. The
/// original subtask keeps whatever dep list the master assigned;
/// user edits cannot reshape the DAG.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubtaskPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub why: Option<String>,
    #[serde(default)]
    pub assigned_worker: Option<AgentKind>,
}

/// Full definition for a user-added subtask. The orchestrator
/// allocates the id server-side (so the frontend doesn't have to
/// coin ULIDs) and returns it alongside the re-emitted plan.
///
/// Same Phase 3 Q1 deferral as [`SubtaskPatch`]: no dependencies —
/// a user-added subtask is always a leaf in the DAG.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubtaskDraft {
    pub title: String,
    #[serde(default)]
    pub why: Option<String>,
    pub assigned_worker: AgentKind,
}

/// One entry in the boot-time recovery report: a run that was
/// non-terminal when the app last exited. The backend marks it
/// `Failed` and sweeps worktrees before populating this; the
/// frontend reads it once on startup to show a heads-up banner.
/// Intentionally minimal — `task` and `repo_path` are enough to
/// identify which run the user lost.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    pub task: String,
    pub repo_path: String,
}

/// Returned by the `skip_subtask` IPC command. The escalated subtask
/// plus every downstream subtask the BFS determined was Waiting or
/// Proposed and transitively depended on it has been flipped to
/// `Skipped`. The frontend uses `skipped_count` to render a
/// confirmation toast ("Skipped 3 subtasks") without a second round-
/// trip.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkipResult {
    /// Number of subtasks transitioned to `Skipped` — including the
    /// escalated one itself. A lone leaf escalation returns `1`.
    pub skipped_count: u32,
    /// The full list of subtask ids that were skipped. Order is the
    /// BFS traversal order starting from the escalated subtask.
    pub skipped_ids: Vec<SubtaskId>,
}

