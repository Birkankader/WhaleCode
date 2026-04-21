import { describe, expect, it } from 'vitest';

import { formatAgentError } from './errorDisplay';

describe('formatAgentError', () => {
  it('treats an empty string as a generic failure', () => {
    expect(formatAgentError('')).toEqual({ summary: 'the run failed' });
    expect(formatAgentError('   ')).toEqual({ summary: 'the run failed' });
  });

  it('recognises cancellation via AgentError Display text', () => {
    expect(formatAgentError('agent run was cancelled')).toEqual({
      summary: 'the run was cancelled',
    });
  });

  it('recognises cancellation via escalate_error_text shorthand', () => {
    expect(formatAgentError('cancelled')).toEqual({
      summary: 'the run was cancelled',
    });
  });

  it('surfaces timeout with details', () => {
    const out = formatAgentError('agent timed out after 120s');
    expect(out.summary).toBe('the agent timed out');
    expect(out.details).toBe('agent timed out after 120s');
  });

  it('surfaces task refusal reason in the summary', () => {
    const out = formatAgentError(
      'agent refused the task: the file does not exist',
    );
    expect(out.summary).toBe('the agent refused: the file does not exist');
    expect(out.details).toBe(
      'agent refused the task: the file does not exist',
    );
  });

  it('recognises plan parse failure', () => {
    const out = formatAgentError(
      "plan output couldn't be parsed: missing field `title`",
    );
    expect(out.summary).toBe("the agent's plan couldn't be parsed");
    expect(out.details).toMatch(/missing field `title`/);
  });

  it('recognises process crash', () => {
    const out = formatAgentError(
      'agent process crashed (exit=Some(1), signal=None)',
    );
    expect(out.summary).toBe('the agent process crashed');
    expect(out.details).toContain('exit=Some(1)');
  });

  it('recognises spawn failure', () => {
    const out = formatAgentError(
      "couldn't spawn agent: binary not on PATH",
    );
    expect(out.summary).toBe("couldn't start the agent");
    expect(out.details).toContain('PATH');
  });

  it('strips lifecycle wrapper and inspects the inner error', () => {
    const out = formatAgentError('planning failed: agent run was cancelled');
    expect(out.summary).toBe('the run was cancelled');
  });

  it('uses the wrapper as summary when the inner is unrecognised', () => {
    const out = formatAgentError('recording approval failed: db locked');
    expect(out.summary).toBe('recording approval failed');
    expect(out.details).toBe('db locked');
  });

  it('falls back on a generic summary for unknown shapes', () => {
    const out = formatAgentError('something weird happened');
    expect(out.summary).toBe('the run failed');
    expect(out.details).toBe('something weird happened');
  });
});
