//! Shared-notes file.
//!
//! Every run writes context to a single markdown file —
//! `{repo_root}/.whalecode/notes.md` — that workers read before
//! starting their subtask. The master seeds it with an initial
//! context dump; each worker's one-line summary is appended when its
//! subtask completes; when the file grows past a threshold, the
//! master is asked to rewrite it.
//!
//! # Why one file
//!
//! Per-subtask notes would need a lookup step before every worker
//! spawn, and the context benefit of seeing sibling subtasks' work is
//! exactly what a single append-only log gives us cheaply. Markdown
//! is readable if a curious user opens the file — no custom format
//! to decode.
//!
//! # Concurrency
//!
//! Designed single-writer: workers never touch the file directly,
//! they report back through IPC and the orchestrator does the
//! append. The API in this module *enforces* that by holding a
//! `tokio::sync::Mutex` around every mutation — so even if future
//! code paths get sloppy about the "orchestrator-owns-writes"
//! contract, we don't corrupt the file.
//!
//! # Atomic writes
//!
//! Every mutation writes to a sibling `.tmp` file and renames over
//! the target. Same pattern as `SettingsStore`. A crash mid-write
//! leaves the old file intact, not a half-written one.

#![allow(dead_code)] // Orchestrator (Step 8) consumes the rest.

use std::path::{Path, PathBuf};

use thiserror::Error;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::agents::{AgentError, AgentImpl};
use crate::ipc::AgentKind;

/// Directory under `repo_root` that holds all WhaleCode state we want
/// to keep across runs (templates, config, and — here — notes).
pub const NOTES_DIRNAME: &str = ".whalecode";

/// Filename inside [`NOTES_DIRNAME`] that holds the shared notes.
pub const NOTES_FILENAME: &str = "notes.md";

/// When the notes file exceeds this many bytes we ask the master to
/// consolidate. 8 KB is a rough fit for "still cheap to send as
/// context without dominating the prompt budget." Phase 6 will tune
/// this once we have real cost telemetry.
pub const CONSOLIDATE_THRESHOLD_BYTES: u64 = 8 * 1024;

// -- Error taxonomy --------------------------------------------------

#[derive(Debug, Error)]
pub enum NotesError {
    #[error("io error: {cause}")]
    IoError { cause: String },

    #[error("notes file contains invalid UTF-8")]
    InvalidUtf8,

    #[error("consolidation failed: {cause}")]
    ConsolidationFailed { cause: String },

    #[error("notes file does not exist")]
    NotInitialized,

    #[error("subtask `{subtask_id}` already has a summary in the notes")]
    DuplicateSubtaskSummary { subtask_id: String },
}

// -- Types -----------------------------------------------------------

/// Minimum information `init()` needs to seed a fresh notes file.
/// More fields will land alongside the orchestrator — at Step 7 we
/// only need the handful that appear in the initial header.
#[derive(Debug, Clone)]
pub struct RunContext {
    pub run_id: String,
    pub task: String,
    /// Master's first-pass context dump. Arbitrary markdown — we
    /// don't parse it, just embed it verbatim under the
    /// `## Initial context` heading.
    pub initial_notes: String,
}

// -- SharedNotes -----------------------------------------------------

/// Owns the shared-notes file for one run. Construct once per run
/// (via [`SharedNotes::new`]); methods are `&self` so the value can
/// be shared across the orchestrator's async tasks without being
/// wrapped in an `Arc<Mutex<_>>` at the call site.
pub struct SharedNotes {
    path: PathBuf,
    /// Serializes every write. Cheap even under contention — the
    /// critical section is bounded by one file I/O call.
    write_lock: Mutex<()>,
}

impl std::fmt::Debug for SharedNotes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SharedNotes").field("path", &self.path).finish()
    }
}

impl SharedNotes {
    /// Derive the notes path from `repo_root`. Doesn't touch the
    /// filesystem — `init()` handles creation.
    pub fn new(repo_root: &Path) -> Self {
        Self {
            path: repo_root.join(NOTES_DIRNAME).join(NOTES_FILENAME),
            write_lock: Mutex::new(()),
        }
    }

    /// Where the notes file lives. Useful for logging and for the
    /// orchestrator to pass to workers as `--add-dir` scope.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Initialize the notes file for a new run, overwriting any
    /// existing content. Starting a new run is the "clean slate"
    /// moment — if prior notes mattered the caller should have
    /// archived them.
    pub async fn init(&self, run: &RunContext) -> Result<(), NotesError> {
        let _guard = self.write_lock.lock().await;
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| NotesError::IoError {
                    cause: format!("creating {}: {e}", parent.display()),
                })?;
        }
        let body = render_header(run);
        write_atomic(&self.path, &body).await
    }

    pub async fn read(&self) -> Result<String, NotesError> {
        match tokio::fs::read(&self.path).await {
            Ok(bytes) => String::from_utf8(bytes).map_err(|_| NotesError::InvalidUtf8),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Err(NotesError::NotInitialized)
            }
            Err(e) => Err(NotesError::IoError {
                cause: format!("reading {}: {e}", self.path.display()),
            }),
        }
    }

    pub fn size_bytes(&self) -> Result<u64, NotesError> {
        match std::fs::metadata(&self.path) {
            Ok(m) => Ok(m.len()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Err(NotesError::NotInitialized)
            }
            Err(e) => Err(NotesError::IoError {
                cause: format!("stat {}: {e}", self.path.display()),
            }),
        }
    }

    /// Append a worker's completion summary. Fails with
    /// [`NotesError::DuplicateSubtaskSummary`] if this subtask_id
    /// already has a section — defensive check against double-write
    /// paths, since each subtask runs once.
    pub async fn append_subtask_summary(
        &self,
        subtask_id: &str,
        subtask_title: &str,
        worker: AgentKind,
        summary: &str,
    ) -> Result<(), NotesError> {
        let _guard = self.write_lock.lock().await;

        let mut current = read_bytes(&self.path).await?;
        let marker = subtask_marker(subtask_id);
        if current.contains(&marker) {
            return Err(NotesError::DuplicateSubtaskSummary {
                subtask_id: subtask_id.to_string(),
            });
        }
        if !current.ends_with('\n') {
            current.push('\n');
        }
        current.push('\n');
        current.push_str(&render_subtask_section(
            subtask_id,
            subtask_title,
            worker,
            summary,
        ));
        write_atomic(&self.path, &current).await
    }

    /// Ask the master to rewrite the notes more concisely. Replaces
    /// the whole file with the master's response on success; on
    /// failure the file is untouched and the error is surfaced.
    ///
    /// Cancellation is *not* wired through here — consolidation runs
    /// at an orchestrator-chosen safe point between subtask
    /// dispatches, and the master's cancel token comes from the
    /// orchestrator. For now we pass a fresh uncancelled token since
    /// the orchestrator hasn't landed yet; Step 8 will thread its
    /// run-scoped token through.
    pub async fn consolidate(&self, master: &dyn AgentImpl) -> Result<(), NotesError> {
        let current = self.read().await?;
        let prompt = consolidation_prompt(&current);

        let new_body = master
            .summarize(&prompt, CancellationToken::new())
            .await
            .map_err(|e: AgentError| NotesError::ConsolidationFailed {
                cause: format!("{e}"),
            })?;

        let cleaned = new_body.trim();
        if cleaned.is_empty() {
            // The master gave us nothing useful. Leave the file
            // alone — an empty notes file is strictly worse than a
            // big one.
            return Err(NotesError::ConsolidationFailed {
                cause: "master returned an empty consolidation".to_string(),
            });
        }

        let _guard = self.write_lock.lock().await;
        let mut final_body = cleaned.to_string();
        if !final_body.ends_with('\n') {
            final_body.push('\n');
        }
        write_atomic(&self.path, &final_body).await
    }

    /// Delete the notes file. Idempotent: missing-file is not an
    /// error. The `.whalecode/` dir is left in place — it may hold
    /// templates or other state that outlives the run.
    pub async fn clear(&self) -> Result<(), NotesError> {
        let _guard = self.write_lock.lock().await;
        match tokio::fs::remove_file(&self.path).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(NotesError::IoError {
                cause: format!("removing {}: {e}", self.path.display()),
            }),
        }
    }
}

// -- Rendering -------------------------------------------------------
//
// Header and section layout live here so `append_subtask_summary`'s
// duplicate-detection can look for the same marker string a section
// writer produced.

fn render_header(run: &RunContext) -> String {
    format!(
        "# Task: {task}\n# Run: {run_id}\n\n## Initial context (master)\n\n{initial}\n",
        task = run.task,
        run_id = run.run_id,
        initial = run.initial_notes.trim_end(),
    )
}

fn subtask_marker(subtask_id: &str) -> String {
    // The `[{subtask_id}]` substring is what uniquely identifies a
    // subtask section. Matching on the whole heading line would be
    // safer but the caller doesn't know the title format; the id
    // alone is enough because subtask IDs are globally unique.
    format!("[{subtask_id}]")
}

fn render_subtask_section(
    subtask_id: &str,
    subtask_title: &str,
    worker: AgentKind,
    summary: &str,
) -> String {
    let worker_label = match worker {
        AgentKind::Claude => "claude",
        AgentKind::Codex => "codex",
        AgentKind::Gemini => "gemini",
    };
    format!(
        "## Subtask: {title} [{id}] ({worker})\n\n{summary}\n",
        title = subtask_title,
        id = subtask_id,
        worker = worker_label,
        summary = summary.trim_end(),
    )
}

fn consolidation_prompt(current: &str) -> String {
    format!(
        "The following is a shared-notes file from an in-progress \
         multi-agent coding run. It has grown large. Produce a \
         consolidated version that preserves essential context (the \
         task, decisions, constraints, and a brief summary of work \
         done so far) but trims redundancy and verbose per-subtask \
         logs.\n\n\
         Output ONLY the new notes content. No preamble, no fences, \
         no trailing commentary. The output will be written to the \
         file verbatim.\n\n\
         --- CURRENT NOTES ---\n{current}\n--- END ---\n"
    )
}

// -- File I/O helpers ------------------------------------------------

async fn read_bytes(path: &Path) -> Result<String, NotesError> {
    match tokio::fs::read(path).await {
        Ok(bytes) => String::from_utf8(bytes).map_err(|_| NotesError::InvalidUtf8),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(NotesError::NotInitialized),
        Err(e) => Err(NotesError::IoError {
            cause: format!("reading {}: {e}", path.display()),
        }),
    }
}

/// Write `body` to `path` atomically. Writes to `{path}.tmp`, fsyncs,
/// then `rename()`s over the target. On any failure the original file
/// (if any) is left intact.
async fn write_atomic(path: &Path, body: &str) -> Result<(), NotesError> {
    let tmp = {
        let mut p = path.to_path_buf();
        let fname = p
            .file_name()
            .map(|n| n.to_os_string())
            .unwrap_or_default();
        let mut tmp_name = fname;
        tmp_name.push(".tmp");
        p.set_file_name(tmp_name);
        p
    };

    {
        let mut f = tokio::fs::File::create(&tmp)
            .await
            .map_err(|e| NotesError::IoError {
                cause: format!("creating {}: {e}", tmp.display()),
            })?;
        f.write_all(body.as_bytes())
            .await
            .map_err(|e| NotesError::IoError {
                cause: format!("writing {}: {e}", tmp.display()),
            })?;
        f.flush().await.map_err(|e| NotesError::IoError {
            cause: format!("flushing {}: {e}", tmp.display()),
        })?;
        // Dropping closes the handle. On macOS/Linux rename across
        // the same fs is atomic even without an explicit fsync.
    }

    tokio::fs::rename(&tmp, path).await.map_err(|e| {
        // Clean up the tmp file so we don't leave litter around.
        let _ = std::fs::remove_file(&tmp);
        NotesError::IoError {
            cause: format!("renaming {} → {}: {e}", tmp.display(), path.display()),
        }
    })
}

#[cfg(test)]
mod tests;
