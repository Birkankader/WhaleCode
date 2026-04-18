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

// Phase 2: retry decisions live in the backend, not the frontend machine.
// The `retrying` state is currently unreachable — backend's `failed` means
// terminal, so FAIL from `running` routes directly to `failed` via the
// second transition branch. Phase 3 will refactor this to be backend-driven
// (entered on backend SubtaskState::Retrying, exited on backend Done/Failed),
// at which point this constant becomes obsolete.
export const MAX_RETRIES = 0;

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
        // Master only: re-enters thinking when a subtask escalates and it has
        // to draft a replacement plan. Workers never drive this transition.
        THINK: 'thinking',
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
