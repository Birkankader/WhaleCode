import { assign, setup } from 'xstate';

export type NodeState =
  | 'idle'
  | 'thinking'
  | 'proposed'
  | 'approved'
  | 'waiting'
  | 'running'
  | 'retrying'
  | 'failed'
  | 'escalating'
  | 'human_escalation'
  | 'done'
  | 'skipped';

export type NodeEventType =
  | 'THINK'
  | 'PROPOSE'
  | 'APPROVE'
  | 'SKIP'
  | 'BLOCK'
  | 'UNBLOCK'
  | 'START'
  | 'FAIL'
  | 'RETRY_SUCCESS'
  | 'COMPLETE'
  | 'ESCALATE'
  | 'REPLAN_DONE'
  | 'HUMAN_NEEDED'
  | 'MANUAL_FIX';

export type NodeEvent = { type: NodeEventType };

export type NodeContext = {
  retries: number;
  maxRetries: number;
};

export const MAX_RETRIES = 1;

export const nodeMachine = setup({
  types: {
    context: {} as NodeContext,
    events: {} as NodeEvent,
  },
  guards: {
    canRetry: ({ context }) => context.retries < context.maxRetries,
  },
  actions: {
    incrementRetries: assign({ retries: ({ context }) => context.retries + 1 }),
  },
}).createMachine({
  id: 'node',
  initial: 'idle',
  context: { retries: 0, maxRetries: MAX_RETRIES },
  states: {
    idle: {
      on: {
        THINK: 'thinking',
        PROPOSE: 'proposed',
      },
    },
    thinking: {
      on: {
        PROPOSE: 'proposed',
      },
    },
    proposed: {
      on: {
        APPROVE: 'approved',
        SKIP: 'skipped',
      },
    },
    approved: {
      on: {
        START: 'running',
        BLOCK: 'waiting',
      },
    },
    waiting: {
      on: {
        UNBLOCK: 'approved',
      },
    },
    running: {
      on: {
        COMPLETE: 'done',
        FAIL: [
          {
            target: 'retrying',
            guard: 'canRetry',
            actions: 'incrementRetries',
          },
          { target: 'failed' },
        ],
      },
    },
    retrying: {
      on: {
        RETRY_SUCCESS: 'running',
        FAIL: 'failed',
      },
    },
    failed: {
      on: {
        ESCALATE: 'escalating',
      },
    },
    escalating: {
      on: {
        REPLAN_DONE: 'done',
        HUMAN_NEEDED: 'human_escalation',
      },
    },
    human_escalation: {
      on: {
        MANUAL_FIX: 'done',
        SKIP: 'skipped',
      },
    },
    done: { type: 'final' },
    skipped: { type: 'final' },
  },
});
