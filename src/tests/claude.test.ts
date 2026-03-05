import { describe, it, expect } from 'vitest';
import { parseClaudeEvent, formatClaudeEvent } from '../lib/claude';

describe('parseClaudeEvent', () => {
  it('parses init event JSON to typed object', () => {
    const line = JSON.stringify({ type: 'init', session_id: 'sess-123' });
    const result = parseClaudeEvent(line);
    expect(result).toEqual({ type: 'init', session_id: 'sess-123' });
  });

  it('parses message event with content blocks', () => {
    const line = JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello world' }],
    });
    const result = parseClaudeEvent(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('message');
    expect(result!.content).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('parses result event with all fields', () => {
    const line = JSON.stringify({
      type: 'result',
      status: 'success',
      result: 'Task completed',
      is_error: false,
      duration_ms: 1500,
      num_turns: 3,
      total_cost_usd: 0.05,
    });
    const result = parseClaudeEvent(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('result');
    expect(result!.status).toBe('success');
    expect(result!.total_cost_usd).toBe(0.05);
    expect(result!.num_turns).toBe(3);
  });

  it('returns null for non-JSON string', () => {
    expect(parseClaudeEvent('not json at all')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseClaudeEvent('')).toBeNull();
  });
});

describe('formatClaudeEvent', () => {
  it('formats message event as readable text', () => {
    const line = JSON.stringify({
      type: 'message',
      content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: 'World' }],
    });
    expect(formatClaudeEvent(line)).toBe('Hello\nWorld');
  });

  it('formats tool_use event as "[Tool: name] input"', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      name: 'read_file',
      input: { path: '/tmp/test.txt' },
    });
    expect(formatClaudeEvent(line)).toBe('[Tool: read_file] {"path":"/tmp/test.txt"}');
  });

  it('formats result event with status and cost', () => {
    const line = JSON.stringify({
      type: 'result',
      status: 'success',
      num_turns: 3,
      total_cost_usd: 0.05,
      is_error: false,
    });
    expect(formatClaudeEvent(line)).toBe('[Done] status=success, turns=3, cost=$0.05');
  });

  it('formats result event with is_error as error message', () => {
    const line = JSON.stringify({
      type: 'result',
      status: 'error',
      is_error: true,
      result: 'Something went wrong',
    });
    const formatted = formatClaudeEvent(line);
    expect(formatted).toContain('[Error]');
    expect(formatted).toContain('Something went wrong');
  });

  it('formats init event', () => {
    const line = JSON.stringify({ type: 'init', session_id: 'sess-abc' });
    expect(formatClaudeEvent(line)).toBe('[Session started]');
  });

  it('formats tool_result event', () => {
    const line = JSON.stringify({ type: 'tool_result', output: 'file contents here' });
    expect(formatClaudeEvent(line)).toBe('[Result] file contents here');
  });

  it('returns raw text for unparseable lines', () => {
    expect(formatClaudeEvent('some raw output')).toBe('some raw output');
  });
});
