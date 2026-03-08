/**
 * Codex CLI NDJSON stream event types and parsing utilities.
 *
 * Mirrors the Gemini stream event pattern but adapted for Codex CLI output.
 * Used by useTaskDispatch hook to convert raw NDJSON lines to human-readable output.
 *
 * Key differences from Gemini events:
 * - Uses function_name/arguments for tool_use (not tool_name/parameters)
 * - result may have stats or usage object with prompt_tokens/completion_tokens
 * - error includes code field for error classification
 */

export interface CodexStreamEvent {
  type: 'init' | 'message' | 'tool_use' | 'tool_result' | 'result' | 'error';
  // init fields
  session_id?: string;
  model?: string;
  timestamp?: string;
  // message fields
  role?: string;
  content?: string;
  // tool_use fields
  function_name?: string;
  call_id?: string;
  arguments?: unknown;
  // tool_result fields
  output?: string;
  status?: string;
  // error fields
  message?: string;
  code?: string;
  // result fields
  response?: string;
  stats?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    duration_ms?: number;
    tool_calls?: number;
  };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    duration_ms?: number;
    tool_calls?: number;
  };
}

/**
 * Parse a single NDJSON line into a CodexStreamEvent.
 * Returns null for empty lines or non-JSON content (graceful handling).
 */
export function parseCodexEvent(line: string): CodexStreamEvent | null {
  if (!line || line.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
      return parsed as CodexStreamEvent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Format a Codex NDJSON line into human-readable text for terminal display.
 *
 * - init: "[Session started] model={model}"
 * - message: content string directly
 * - tool_use: "[Tool: {function_name}] {JSON.stringify(arguments)}"
 * - tool_result: "[Result] {output}"
 * - error: "[Error] {message}"
 * - result: "[Done] tokens={total_tokens}, duration={duration_ms}ms"
 * - unparseable: return raw line as-is
 */
export function formatCodexEvent(line: string): string {
  const event = parseCodexEvent(line);
  if (!event) {
    return line;
  }

  switch (event.type) {
    case 'init':
      return `[Session started] model=${event.model ?? 'unknown'}`;

    case 'message':
      return event.content ?? '';

    case 'tool_use': {
      const argsStr = JSON.stringify(event.arguments);
      const truncatedArgs = argsStr.length > 200 ? argsStr.slice(0, 197) + '...' : argsStr;
      return `[Tool: ${event.function_name}] ${truncatedArgs}`;
    }

    case 'tool_result': {
      const output = event.output ?? '';
      if (output.length <= 500) return `[Result] ${output}`;
      const lines = output.split('\n');
      if (lines.length <= 5) return `[Result] ${output.slice(0, 500)}...`;
      return `[Result] ${lines.slice(0, 3).join('\n')}\n  ... (${lines.length - 3} more lines)`;
    }

    case 'error':
      return `[Error] ${event.message ?? 'Unknown error'}`;

    case 'result': {
      const u = event.stats ?? event.usage;
      return `[Done] tokens=${u?.total_tokens ?? '?'}, duration=${u?.duration_ms ?? '?'}ms`;
    }

    default:
      return line;
  }
}
