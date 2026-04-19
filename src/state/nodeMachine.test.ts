import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import { nodeMachine, type NodeEventType } from './nodeMachine';

function run(events: NodeEventType[]) {
  const actor = createActor(nodeMachine).start();
  for (const type of events) actor.send({ type });
  const snap = actor.getSnapshot();
  actor.stop();
  return snap;
}

describe('nodeMachine — happy paths', () => {
  it('starts in idle', () => {
    const snap = run([]);
    expect(snap.value).toBe('idle');
  });

  it('idle → thinking → proposed → approved → running → done', () => {
    const snap = run(['THINK', 'PROPOSE', 'APPROVE', 'START', 'COMPLETE']);
    expect(snap.value).toBe('done');
    expect(snap.status).toBe('done');
  });

  it('idle → proposed shortcut skips thinking', () => {
    const snap = run(['PROPOSE']);
    expect(snap.value).toBe('proposed');
  });

  it('proposed → skipped via SKIP', () => {
    const snap = run(['PROPOSE', 'SKIP']);
    expect(snap.value).toBe('skipped');
  });
});

describe('nodeMachine — waiting / blocked', () => {
  it('approved → waiting on BLOCK, then UNBLOCK → approved → running', () => {
    const snap = run(['PROPOSE', 'APPROVE', 'BLOCK', 'UNBLOCK', 'START']);
    expect(snap.value).toBe('running');
  });

  it('waiting ignores START until UNBLOCK', () => {
    const snap = run(['PROPOSE', 'APPROVE', 'BLOCK', 'START']);
    expect(snap.value).toBe('waiting');
  });

  it('approved → thinking → proposed → approved (master replan loop)', () => {
    const snap = run(['PROPOSE', 'APPROVE', 'THINK', 'PROPOSE', 'APPROVE']);
    expect(snap.value).toBe('approved');
  });
});

// Phase 3 Step 3a: retry semantics are backend-driven. FAIL from running is a
// terminal leaf (no guard branch); START_RETRY/RETRY_SUCCESS/RETRY_FAIL drive
// the retry sub-loop. No retry count lives in the machine context — that's in
// graphStore.subtaskRetryCounts now.
describe('nodeMachine — failure path', () => {
  it('FAIL from running lands in failed (no intermediate retrying)', () => {
    const snap = run(['PROPOSE', 'APPROVE', 'START', 'FAIL']);
    expect(snap.value).toBe('failed');
  });
});

describe('nodeMachine — retry sub-loop (backend-driven)', () => {
  it('START_RETRY from running lands in retrying', () => {
    const snap = run(['PROPOSE', 'APPROVE', 'START', 'START_RETRY']);
    expect(snap.value).toBe('retrying');
  });

  it('RETRY_SUCCESS from retrying lands in running', () => {
    const snap = run(['PROPOSE', 'APPROVE', 'START', 'START_RETRY', 'RETRY_SUCCESS']);
    expect(snap.value).toBe('running');
  });

  it('RETRY_FAIL from retrying lands in failed', () => {
    const snap = run(['PROPOSE', 'APPROVE', 'START', 'START_RETRY', 'RETRY_FAIL']);
    expect(snap.value).toBe('failed');
  });

  it('recovered subtask can complete: retry → running → done', () => {
    const snap = run([
      'PROPOSE',
      'APPROVE',
      'START',
      'START_RETRY',
      'RETRY_SUCCESS',
      'COMPLETE',
    ]);
    expect(snap.value).toBe('done');
  });

  it('retry sub-loop can re-enter: running → retrying → running → retrying', () => {
    const snap = run([
      'PROPOSE',
      'APPROVE',
      'START',
      'START_RETRY',
      'RETRY_SUCCESS',
      'START_RETRY',
    ]);
    expect(snap.value).toBe('retrying');
  });

  it('START_RETRY from proposed is a no-op (only running reaches retrying)', () => {
    const snap = run(['PROPOSE', 'START_RETRY']);
    expect(snap.value).toBe('proposed');
  });

  it('RETRY_SUCCESS from running is a no-op', () => {
    const snap = run(['PROPOSE', 'APPROVE', 'START', 'RETRY_SUCCESS']);
    expect(snap.value).toBe('running');
  });
});

describe('nodeMachine — escalation path', () => {
  it('failed → escalating → done via REPLAN_DONE', () => {
    const snap = run(['PROPOSE', 'APPROVE', 'START', 'FAIL', 'ESCALATE', 'REPLAN_DONE']);
    expect(snap.value).toBe('done');
  });

  it('failed → escalating → human_escalation via HUMAN_NEEDED', () => {
    const snap = run(['PROPOSE', 'APPROVE', 'START', 'FAIL', 'ESCALATE', 'HUMAN_NEEDED']);
    expect(snap.value).toBe('human_escalation');
  });

  it('human_escalation → done via MANUAL_FIX', () => {
    const snap = run([
      'PROPOSE',
      'APPROVE',
      'START',
      'FAIL',
      'ESCALATE',
      'HUMAN_NEEDED',
      'MANUAL_FIX',
    ]);
    expect(snap.value).toBe('done');
  });

  it('human_escalation → skipped via SKIP', () => {
    const snap = run([
      'PROPOSE',
      'APPROVE',
      'START',
      'FAIL',
      'ESCALATE',
      'HUMAN_NEEDED',
      'SKIP',
    ]);
    expect(snap.value).toBe('skipped');
  });

  it('retry-then-fail flows into escalation: retrying → failed → escalating', () => {
    const snap = run([
      'PROPOSE',
      'APPROVE',
      'START',
      'START_RETRY',
      'RETRY_FAIL',
      'ESCALATE',
    ]);
    expect(snap.value).toBe('escalating');
  });
});

describe('nodeMachine — invalid transitions are no-ops', () => {
  it('COMPLETE from idle does nothing', () => {
    const snap = run(['COMPLETE']);
    expect(snap.value).toBe('idle');
  });

  it('APPROVE from running does nothing', () => {
    const snap = run(['PROPOSE', 'APPROVE', 'START', 'APPROVE']);
    expect(snap.value).toBe('running');
  });

  it('done is final — no further events accepted', () => {
    const actor = createActor(nodeMachine).start();
    for (const type of ['PROPOSE', 'APPROVE', 'START', 'COMPLETE'] as const) actor.send({ type });
    expect(actor.getSnapshot().status).toBe('done');
    expect(() => actor.send({ type: 'FAIL' })).not.toThrow();
    actor.stop();
  });

  it('skipped is final', () => {
    const actor = createActor(nodeMachine).start();
    for (const type of ['PROPOSE', 'SKIP'] as const) actor.send({ type });
    expect(actor.getSnapshot().status).toBe('done');
    expect(actor.getSnapshot().value).toBe('skipped');
    actor.stop();
  });
});
