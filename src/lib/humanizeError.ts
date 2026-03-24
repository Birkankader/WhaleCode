/**
 * Humanize raw error messages for end-user display.
 * Maps technical/backend errors to friendly descriptions.
 */

const ERROR_PATTERNS: [RegExp, string][] = [
  // Decomposition-specific patterns (more specific, checked first)
  [/Decomposition parse failed|not valid JSON|Could not parse decomposition/i,
   'The AI returned an unexpected response format. Try rephrasing your task or switching the master agent.'],
  [/Falling back to.*single task|Fallback:.*single task/i,
   'The task couldn\'t be broken into sub-tasks and will run as a single task instead.'],
  [/timed out during.*decomposition|Master agent timed out/i,
   'The orchestrator took too long breaking down your task. Try a simpler prompt or a different master agent.'],

  [/Process .{4,} not found/i, 'The agent process has already ended.'],
  [/already running a task/i, 'This agent is already busy with another task. Wait for it to finish or cancel it first.'],
  [/already being dispatched/i, 'This agent is being set up. Please wait a moment.'],
  [/Failed to spawn process/i, 'Could not start the agent. Make sure the CLI tool is installed and accessible.'],
  [/No credential provider/i, 'No API key configured for this agent. Set it up in Settings.'],
  [/Failed to get HEAD/i, 'This directory does not appear to be a valid Git repository.'],
  [/Cycle detected/i, 'Task dependencies have a circular reference. Please check the task setup.'],
  [/could not parse JSON/i, 'The agent returned an unexpected response. Try rephrasing your task.'],
  [/ENOTFOUND|ECONNREFUSED|fetch failed/i, 'Network connection failed. Check your internet connection.'],
  [/rate limit/i, 'API rate limit reached. The system will retry automatically.'],
  [/authentication|unauthorized|403/i, 'Authentication failed. Please check your API key in Settings.'],
  [/not logged in|run.*\/login/i, 'Agent is not logged in. Run the login command in your terminal first.'],
  [/ENOMEM|out of memory/i, 'System is low on memory. Close other applications and try again.'],
  [/Lock poisoned/i, 'An internal error occurred. Please restart the application.'],
  [/Merge conflict/i, 'Merge conflict detected. Review the changes manually before merging.'],
  [/Orchestration cancelled/i, 'The orchestration was cancelled.'],
  [/could not find repository/i, 'The selected project directory is not a Git repository. Initialize one with "git init" in your terminal, then try again.'],
  [/Failed to create worktree/i, 'Could not create an isolated workspace. Check that the project is a Git repository with at least one commit.'],
  [/Failed to remove/i, 'Could not clean up temporary files. You may need to remove them manually.'],
];

/**
 * Convert a raw error string to a user-friendly message.
 * Returns the original message if no pattern matches (but strips stack traces).
 */
export function humanizeError(raw: unknown): string {
  const msg = String(raw);

  // Try to match known patterns
  for (const [pattern, friendly] of ERROR_PATTERNS) {
    if (pattern.test(msg)) {
      return friendly;
    }
  }

  // Try to extract a JSON error detail
  try {
    const parsed = JSON.parse(msg);
    if (parsed.detail) return String(parsed.detail);
    if (parsed.message) return String(parsed.message);
  } catch { /* not JSON */ }

  // Strip stack traces and long paths, keep first meaningful line
  const firstLine = msg.split('\n')[0].trim();
  if (firstLine.length > 200) {
    return firstLine.slice(0, 197) + '...';
  }

  return firstLine || 'An unexpected error occurred.';
}
