/**
 * Gemini CLI NDJSON stream event types and parsing utilities.
 *
 * Mirrors the Rust GeminiStreamEvent but in TypeScript for frontend consumption.
 * Used by useGeminiTask hook to convert raw NDJSON lines to human-readable output.
 *
 * Key differences from Claude events:
 * - message.content is a plain string (not Array<ContentBlock>)
 * - tool_use uses tool_name/parameters (not name/input)
 * - result has stats object with total_tokens/duration_ms (not top-level fields)
 * - error is a distinct event type (not a result flag)
 */

export interface GeminiStreamEvent {
  type: 'init' | 'message' | 'tool_use' | 'tool_result' | 'result' | 'error';
  // init fields
  session_id?: string;
  model?: string;
  timestamp?: string;
  // message fields
  role?: string;
  content?: string;
  // tool_use fields
  tool_name?: string;
  tool_id?: string;
  parameters?: unknown;
  // tool_result fields
  output?: string;
  status?: string;
  // error fields
  message?: string;
  // result fields
  response?: string;
  stats?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    duration_ms?: number;
    tool_calls?: number;
  };
}

/**
 * Parse a single NDJSON line into a GeminiStreamEvent.
 * Returns null for empty lines or non-JSON content (graceful handling).
 */
export function parseGeminiEvent(line: string): GeminiStreamEvent | null {
  if (!line || line.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
      return parsed as GeminiStreamEvent;
    }
    return null;
  } catch { // expected: not valid JSON
    return null;
  }
}

/**
 * Format a Gemini NDJSON line into human-readable text for terminal display.
 *
 * - init: "[Session started] model={model}"
 * - message: content string directly
 * - tool_use: "[Tool: {tool_name}] {JSON.stringify(parameters)}"
 * - tool_result: "[Result] {output}"
 * - error: "[Error] {message}"
 * - result: "[Done] tokens={total_tokens}, duration={duration_ms}ms"
 * - unparseable: return raw line as-is
 */
export function formatGeminiEvent(line: string): string {
  const event = parseGeminiEvent(line);
  if (!event) {
    return line;
  }

  switch (event.type) {
    case 'init':
      return `[Session started] model=${event.model ?? 'unknown'}`;

    case 'message':
      return event.content ?? '';

    case 'tool_use': {
      const paramsStr = JSON.stringify(event.parameters);
      const truncatedParams = paramsStr.length > 200 ? paramsStr.slice(0, 197) + '...' : paramsStr;
      return `[Tool: ${event.tool_name}] ${truncatedParams}`;
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

    case 'result':
      return `[Done] tokens=${event.stats?.total_tokens ?? '?'}, duration=${event.stats?.duration_ms ?? '?'}ms`;

    default:
      return line;
  }
}
