# Privacy Policy — WhaleCode

**Last updated:** March 2026

## Data Collection

WhaleCode is a local-first desktop application. We do **not** collect, transmit, or store any user data on external servers.

## Local Data Storage

- **API Keys**: Stored securely in your macOS Keychain. Never transmitted except directly to the respective AI service (Anthropic, Google, OpenAI).
- **Session History**: Stored in a local SQLite database within the app's data directory.
- **Settings & Preferences**: Stored in browser localStorage within the app sandbox.
- **Task Templates**: Stored locally in browser localStorage.

## Third-Party Services

WhaleCode connects to the following services **only** when you initiate an orchestration:

- **Anthropic API** (Claude Code) — Subject to [Anthropic's Privacy Policy](https://www.anthropic.com/privacy)
- **Google AI API** (Gemini CLI) — Subject to [Google's Privacy Policy](https://policies.google.com/privacy)
- **OpenAI API** (Codex CLI) — Subject to [OpenAI's Privacy Policy](https://openai.com/privacy)

Your prompts and project code are sent to these services as part of agent execution. WhaleCode does not intercept, log, or modify this communication beyond what is necessary for orchestration.

## Git Operations

WhaleCode creates isolated Git worktrees in your local filesystem. No Git data is transmitted to external services unless you explicitly use the Push feature.

## Analytics & Telemetry

WhaleCode does **not** include any analytics, telemetry, crash reporting, or tracking of any kind.

## Contact

For privacy questions, open an issue at the project repository.
