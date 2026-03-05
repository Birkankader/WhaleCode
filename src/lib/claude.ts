/**
 * Claude Code NDJSON stream event types and parsing utilities.
 *
 * Mirrors the Rust ClaudeStreamEvent but in TypeScript for frontend consumption.
 * Used by useClaudeTask hook to convert raw NDJSON lines to human-readable output.
 */

export interface ClaudeStreamEvent {
  type: 'init' | 'message' | 'tool_use' | 'tool_result' | 'result' | 'stream_event';
  session_id?: string;
  role?: string;
  content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  name?: string;
  input?: unknown;
  output?: string;
  status?: string;
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
}

/**
 * Parse a single NDJSON line into a ClaudeStreamEvent.
 * Returns null for empty lines or non-JSON content (graceful handling).
 */
export function parseClaudeEvent(line: string): ClaudeStreamEvent | null {
  if (!line || line.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
      return parsed as ClaudeStreamEvent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Format a Claude NDJSON line into human-readable text for terminal display.
 *
 * - init: "[Session started]"
 * - message: Extract text from content blocks, join with newlines
 * - tool_use: "[Tool: {name}] {JSON.stringify(input)}"
 * - tool_result: "[Result] {output}"
 * - result: "[Done] status={status}, turns={num_turns}, cost=${total_cost_usd}"
 *           or "[Error] {result}" if is_error
 * - unparseable: return raw line as-is
 */
export function formatClaudeEvent(line: string): string {
  const event = parseClaudeEvent(line);
  if (!event) {
    return line;
  }

  switch (event.type) {
    case 'init':
      return '[Session started]';

    case 'message': {
      if (!event.content || event.content.length === 0) {
        return '';
      }
      return event.content
        .filter((block) => block.type === 'text' && block.text)
        .map((block) => block.text!)
        .join('\n');
    }

    case 'tool_use':
      return `[Tool: ${event.name}] ${JSON.stringify(event.input)}`;

    case 'tool_result':
      return `[Result] ${event.output ?? ''}`;

    case 'result': {
      if (event.is_error) {
        return `[Error] ${event.result ?? event.status ?? 'Unknown error'}`;
      }
      return `[Done] status=${event.status}, turns=${event.num_turns}, cost=$${event.total_cost_usd}`;
    }

    case 'stream_event':
      return line;

    default:
      return line;
  }
}
