import { setup } from 'xstate';

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
  | 'skipped'
  | 'cancelled';

export type NodeEventType =
  | 'THINK'
  | 'PROPOSE'
  | 'APPROVE'
  | 'SKIP'
  | 'BLOCK'
  | 'UNBLOCK'
  | 'START'
  | 'START_RETRY'
  | 'FAIL'
  | 'RETRY_SUCCESS'
  | 'RETRY_FAIL'
  | 'COMPLETE'
  | 'ESCALATE'
  | 'REPLAN_DONE'
  | 'HUMAN_NEEDED'
  | 'MANUAL_FIX'
  | 'CANCEL';

export type NodeEvent = { type: NodeEventType };

// Phase 3 Step 3a: retry semantics are driven by the backend, not by
// the frontend machine.
//
// Rationale (see phase-3-spec.md Decision 2): the backend owns the
// "can we retry?" decision — it knows the subtask's fail history,
// whether the worker agent is still available, whether a dependency
// was invalidated by a master re-plan, etc. The frontend machine
// used to mirror that with a `retries/maxRetries` context and a
// `canRetry` guard, but doing so in two places is how drift bugs
// happen (e.g. "UI shows 'retry 2' but backend is on attempt 3").
//
// The model is now:
//   running -- FAIL ----------→ failed       (terminal fail from
//                                              first attempt, no
//                                              guard branching)
//   running -- START_RETRY --→ retrying     (backend emitted
//                                              SubtaskState::Retrying
//                                              → store bridge drives
//                                              this)
//   retrying -- RETRY_SUCCESS → running     (backend re-entered
//                                              Running after the retry
//                                              began)
//   retrying -- RETRY_FAIL ---→ failed      (backend transitioned
//                                              retry attempt to Failed)
//
// The "how many retries has this subtask seen?" counter lives in
// `graphStore.subtaskRetryCounts` — a `Map<subtaskId, number>`
// incremented on every backend `Retrying` event. WorkerNode reads
// that map via GraphCanvas; the machine context is context-free.
export const nodeMachine = setup({
  types: {
    events: {} as NodeEvent,
  },
}).createMachine({
  id: 'node',
  initial: 'idle',
  states: {
    idle: {
      on: {
        THINK: 'thinking',
        PROPOSE: 'proposed',
        CANCEL: 'cancelled',
      },
    },
    thinking: {
      on: {
        PROPOSE: 'proposed',
        CANCEL: 'cancelled',
      },
    },
    proposed: {
      on: {
        APPROVE: 'approved',
        SKIP: 'skipped',
        CANCEL: 'cancelled',
      },
    },
    approved: {
      on: {
        START: 'running',
        BLOCK: 'waiting',
        // Master only: re-enters thinking when a subtask escalates and it has
        // to draft a replacement plan. Workers never drive this transition.
        THINK: 'thinking',
        CANCEL: 'cancelled',
      },
    },
    waiting: {
      on: {
        UNBLOCK: 'approved',
        CANCEL: 'cancelled',
      },
    },
    running: {
      on: {
        COMPLETE: 'done',
        // Single-branch terminal FAIL — backend's first-pass failure.
        // The retry decision (if any) arrives as a subsequent
        // Retrying-state event that the store bridges via
        // START_RETRY; we don't guess it from here.
        FAIL: 'failed',
        START_RETRY: 'retrying',
        CANCEL: 'cancelled',
      },
    },
    retrying: {
      on: {
        RETRY_SUCCESS: 'running',
        RETRY_FAIL: 'failed',
        CANCEL: 'cancelled',
      },
    },
    failed: {
      on: {
        ESCALATE: 'escalating',
        CANCEL: 'cancelled',
      },
    },
    escalating: {
      on: {
        REPLAN_DONE: 'done',
        HUMAN_NEEDED: 'human_escalation',
        CANCEL: 'cancelled',
      },
    },
    human_escalation: {
      on: {
        MANUAL_FIX: 'done',
        SKIP: 'skipped',
        CANCEL: 'cancelled',
      },
    },
    done: { type: 'final' },
    skipped: { type: 'final' },
    // User-initiated cancel or approval timeout. Terminal; unlike `failed`,
    // there's no retry/escalation path — the run is over. The
    // `handleStatusChanged` bridge dispatches CANCEL to every non-final
    // actor when the run flips to `status: 'cancelled'` so the graph stops
    // looking alive (the master node in particular: a frozen `thinking`
    // spinner with no forward motion is how users read "it didn't work").
    cancelled: { type: 'final' },
  },
});
