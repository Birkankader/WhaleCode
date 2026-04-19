//! Master-agent planning prompt templates.
//!
//! Each template is `include_str!`'d at compile time so we don't pay
//! for disk I/O at runtime and so a typo in a filename fails the
//! build. The `.md` extension is cosmetic — they're plain text — but
//! it tells editors to syntax-highlight the examples inside.
//!
//! Templates use the `{{var}}` substitution syntax defined in
//! `super::process::render_template`. The variable set for the
//! initial-plan templates is: `task`, `directory_tree`, `claude_md`,
//! `agents_md`, `gemini_md`, `recent_commits`, `available_workers`.
//!
//! The Phase-3 replan templates use a different variable set keyed to
//! failure forensics: `original_task`, `failed_title`, `failed_why`,
//! `attempt_errors`, `worker_log_tail`, `completed_summaries`,
//! `attempt_counter`, `available_workers`. The JSON output shape is
//! identical to the initial-plan shape so `plan_parser::parse_and_validate`
//! can validate either.
//!
//! Separate files per adapter because each CLI has its own
//! personality — Claude follows instructions tersely, Codex benefits
//! from a more explicit format spec, and Gemini needs reminders not
//! to trail prose after the fenced block. Shared wording lives inline;
//! don't introduce a `common.md` until we have a third repetition.

pub const MASTER_CLAUDE: &str = include_str!("master_claude.md");
pub const MASTER_CODEX: &str = include_str!("master_codex.md");
pub const MASTER_GEMINI: &str = include_str!("master_gemini.md");

pub const REPLAN_CLAUDE: &str = include_str!("replan_claude.md");
pub const REPLAN_CODEX: &str = include_str!("replan_codex.md");
pub const REPLAN_GEMINI: &str = include_str!("replan_gemini.md");
