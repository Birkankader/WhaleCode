//! Master-agent planning prompt templates.
//!
//! Each template is `include_str!`'d at compile time so we don't pay
//! for disk I/O at runtime and so a typo in a filename fails the
//! build. The `.md` extension is cosmetic — they're plain text — but
//! it tells editors to syntax-highlight the examples inside.
//!
//! Templates use the `{{var}}` substitution syntax defined in
//! `super::process::render_template`. The variable set is the same
//! across all three: `task`, `directory_tree`, `claude_md`,
//! `agents_md`, `gemini_md`, `recent_commits`, `available_workers`.
//!
//! Separate files per adapter because each CLI has its own
//! personality — Claude follows instructions tersely, Codex benefits
//! from a more explicit format spec, and Gemini needs reminders not
//! to trail prose after the fenced block. Shared wording lives inline;
//! don't introduce a `common.md` until we have a third repetition.

pub const MASTER_CLAUDE: &str = include_str!("master_claude.md");
pub const MASTER_CODEX: &str = include_str!("master_codex.md");
pub const MASTER_GEMINI: &str = include_str!("master_gemini.md");
