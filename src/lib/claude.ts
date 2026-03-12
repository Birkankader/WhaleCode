/**
 * Claude Code NDJSON stream event types and parsing utilities.
 *
 * Mirrors the Rust ClaudeStreamEvent but in TypeScript for frontend consumption.
 * Used by useClaudeTask hook to convert raw NDJSON lines to human-readable output.
 */

export interface ClaudeStreamEvent {
  type: string;
  session_id?: string;
  role?: string;
  content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  message?: { role?: string; content?: Array<{ type: string; content?: string }> };
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
export function formatClaudeEvent(line: string): string | null {
  const event = parseClaudeEvent(line);
  if (!event) {
    return line;
  }

  const contentBlocks = event.content ?? [];
  const textBlocks = contentBlocks
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text!.trim())
    .filter(Boolean);

  const messageBlocks = event.message?.content ?? [];
  const messageText = messageBlocks
    .map((block) => block.content?.trim())
    .filter((value): value is string => Boolean(value))
    .join('\n');

  switch (event.type) {
    case 'init':
      return '[Session started]';

    case 'message': {
      if (textBlocks.length > 0) {
        return textBlocks.join('\n');
      }
      if (messageText) {
        return messageText;
      }
      return line;
    }

    case 'tool_use': {
      const inputStr = JSON.stringify(event.input);
      const truncatedInput = inputStr.length > 200 ? inputStr.slice(0, 197) + '...' : inputStr;
      return `[Tool: ${event.name}] ${truncatedInput}`;
    }

    case 'tool_result': {
      const output = event.output ?? '';
      if (output.length <= 500) return `[Result] ${output}`;
      const lines = output.split('\n');
      if (lines.length <= 5) return `[Result] ${output.slice(0, 500)}...`;
      return `[Result] ${lines.slice(0, 3).join('\n')}\n  ... (${lines.length - 3} more lines)`;
    }

    case 'result': {
      if (event.is_error) {
        return `[Error] ${event.result ?? event.status ?? 'Unknown error'}`;
      }
      return `[Done] status=${event.status}, turns=${event.num_turns}, cost=$${event.total_cost_usd}`;
    }

    case 'stream_event':
      if (textBlocks.length > 0) {
        return textBlocks.join('\n');
      }
      if (messageText) {
        return messageText;
      }
      return null;

    default:
      if (textBlocks.length > 0) {
        return textBlocks.join('\n');
      }
      if (messageText) {
        return messageText;
      }
      if (typeof event.result === 'string' && event.result.trim().length > 0) {
        return event.result.trim();
      }
      if (typeof event.output === 'string' && event.output.trim().length > 0) {
        return event.output.trim();
      }
      return line;
  }
}
