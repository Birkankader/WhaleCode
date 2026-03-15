import { describe, it, expect } from 'vitest';
import { humanizeError } from '../lib/humanizeError';

describe('humanizeError', () => {
  it('maps "Process xyz not found" to friendly message', () => {
    expect(humanizeError('Process 7a2f-b3c1 not found')).toBe(
      'The agent process has already ended.'
    );
  });

  it('maps "already running a task" to friendly message', () => {
    expect(humanizeError('claude is already running a task')).toBe(
      'This agent is already busy with another task. Wait for it to finish or cancel it first.'
    );
  });

  it('maps "Failed to spawn process" to install hint', () => {
    expect(humanizeError('Failed to spawn process: ENOENT')).toBe(
      'Could not start the agent. Make sure the CLI tool is installed and accessible.'
    );
  });

  it('maps rate limit errors', () => {
    expect(humanizeError('API rate limit exceeded')).toBe(
      'API rate limit reached. The system will retry automatically.'
    );
  });

  it('maps authentication errors', () => {
    expect(humanizeError('403 Forbidden')).toBe(
      'Authentication failed. Please check your API key in Settings.'
    );
  });

  it('extracts JSON detail field', () => {
    expect(humanizeError('{"detail": "Connection timeout"}')).toBe(
      'Connection timeout'
    );
  });

  it('strips stack traces and returns first line', () => {
    const error = 'Something failed\n    at Object.<anonymous>\n    at Module._compile';
    expect(humanizeError(error)).toBe('Something failed');
  });

  it('truncates very long messages', () => {
    const long = 'x'.repeat(300);
    const result = humanizeError(long);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith('...')).toBe(true);
  });

  it('handles null/undefined gracefully', () => {
    expect(humanizeError(null)).toBe('null');
    expect(humanizeError(undefined)).toBe('undefined');
  });

  it('returns default for empty string', () => {
    expect(humanizeError('')).toBe('An unexpected error occurred.');
  });
});
