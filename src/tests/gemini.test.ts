import { describe, it, expect } from 'vitest';
import { parseGeminiEvent, formatGeminiEvent } from '../lib/gemini';

describe('parseGeminiEvent', () => {
  it('parses init event with session_id and model', () => {
    const line = JSON.stringify({ type: 'init', session_id: 'gem-123', model: 'gemini-2.5-pro' });
    const result = parseGeminiEvent(line);
    expect(result).toEqual({ type: 'init', session_id: 'gem-123', model: 'gemini-2.5-pro' });
  });

  it('parses message event with role and content string', () => {
    const line = JSON.stringify({
      type: 'message',
      role: 'model',
      content: 'Hello from Gemini',
    });
    const result = parseGeminiEvent(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('message');
    expect(result!.content).toBe('Hello from Gemini');
  });

  it('parses tool_use event with tool_name and parameters', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      tool_name: 'read_file',
      tool_id: 'tool-1',
      parameters: { path: '/tmp/test.txt' },
    });
    const result = parseGeminiEvent(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('tool_use');
    expect(result!.tool_name).toBe('read_file');
    expect(result!.parameters).toEqual({ path: '/tmp/test.txt' });
  });

  it('parses tool_result event with tool_id, status, output', () => {
    const line = JSON.stringify({
      type: 'tool_result',
      tool_id: 'tool-1',
      status: 'success',
      output: 'file contents here',
    });
    const result = parseGeminiEvent(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('tool_result');
    expect(result!.output).toBe('file contents here');
    expect(result!.status).toBe('success');
  });

  it('parses result event with status, response, stats', () => {
    const line = JSON.stringify({
      type: 'result',
      status: 'success',
      response: 'Task completed',
      stats: { total_tokens: 1500, duration_ms: 3200 },
    });
    const result = parseGeminiEvent(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('result');
    expect(result!.status).toBe('success');
    expect(result!.response).toBe('Task completed');
    expect(result!.stats).toEqual({ total_tokens: 1500, duration_ms: 3200 });
  });

  it('parses error event with message', () => {
    const line = JSON.stringify({
      type: 'error',
      message: 'Something went wrong',
    });
    const result = parseGeminiEvent(line);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('error');
    expect(result!.message).toBe('Something went wrong');
  });

  it('returns null for non-JSON string', () => {
    expect(parseGeminiEvent('not json at all')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseGeminiEvent('')).toBeNull();
  });

  it('returns null for JSON without type field', () => {
    expect(parseGeminiEvent('{"data": "no type"}')).toBeNull();
  });
});

describe('formatGeminiEvent', () => {
  it('formats init event as "[Session started] model={model}"', () => {
    const line = JSON.stringify({ type: 'init', session_id: 'gem-abc', model: 'gemini-2.5-pro' });
    expect(formatGeminiEvent(line)).toBe('[Session started] model=gemini-2.5-pro');
  });

  it('formats init event with unknown model when missing', () => {
    const line = JSON.stringify({ type: 'init', session_id: 'gem-abc' });
    expect(formatGeminiEvent(line)).toBe('[Session started] model=unknown');
  });

  it('formats message event as the content string directly', () => {
    const line = JSON.stringify({ type: 'message', content: 'Hello world' });
    expect(formatGeminiEvent(line)).toBe('Hello world');
  });

  it('formats message event with empty content as empty string', () => {
    const line = JSON.stringify({ type: 'message' });
    expect(formatGeminiEvent(line)).toBe('');
  });

  it('formats tool_use event as "[Tool: {name}] {params}"', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      tool_name: 'read_file',
      parameters: { path: '/tmp/test.txt' },
    });
    expect(formatGeminiEvent(line)).toBe('[Tool: read_file] {"path":"/tmp/test.txt"}');
  });

  it('formats tool_result event as "[Result] {output}"', () => {
    const line = JSON.stringify({ type: 'tool_result', output: 'file contents here' });
    expect(formatGeminiEvent(line)).toBe('[Result] file contents here');
  });

  it('formats error event as "[Error] {message}"', () => {
    const line = JSON.stringify({ type: 'error', message: 'API quota exceeded' });
    expect(formatGeminiEvent(line)).toBe('[Error] API quota exceeded');
  });

  it('formats error event with missing message', () => {
    const line = JSON.stringify({ type: 'error' });
    expect(formatGeminiEvent(line)).toBe('[Error] Unknown error');
  });

  it('formats result event as "[Done] tokens=..., duration=..."', () => {
    const line = JSON.stringify({
      type: 'result',
      status: 'success',
      stats: { total_tokens: 1500, duration_ms: 3200 },
    });
    expect(formatGeminiEvent(line)).toBe('[Done] tokens=1500, duration=3200ms');
  });

  it('formats result event with missing stats', () => {
    const line = JSON.stringify({ type: 'result', status: 'success' });
    expect(formatGeminiEvent(line)).toBe('[Done] tokens=?, duration=?ms');
  });

  it('returns raw line for unparseable input', () => {
    expect(formatGeminiEvent('some raw output')).toBe('some raw output');
  });
});
