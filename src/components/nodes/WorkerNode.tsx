import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

import { describeErrorCategory } from '../../lib/errorCategory';
import { NODE_DIMENSIONS } from '../../lib/layout';
import {
  isSubtaskAdded,
  isSubtaskEdited,
  useGraphStore,
} from '../../state/graphStore';
import { isSelectable, useAgentStore } from '../../state/agentStore';
import type { AgentKind as BackendAgentKind } from '../../lib/ipc';
import type { NodeState } from '../../state/nodeMachine';
import { Badge } from '../primitives/Badge';
import { Chip } from '../primitives/Chip';
import { Dropdown, type DropdownOption } from '../primitives/Dropdown';
import { InlineTextEdit } from '../primitives/InlineTextEdit';
import { NodeContainer } from '../primitives/NodeContainer';
import { StatusDot } from '../primitives/StatusDot';
import { AGENT_COLOR_VAR, AGENT_LABEL } from '../primitives/agentColor';
import { DiffPopover } from './DiffPopover';
import { EscalationActions } from './EscalationActions';
import { ActivityChipStack } from './ActivityChipStack';
import { QuestionInput } from './QuestionInput';
import { StopButton } from './StopButton';
import { WorktreeActions } from './WorktreeActions';

export type WorkerNodeData = {
  state: NodeState;
  /**
   * Narrowed to `BackendAgentKind` (no `'master'`) because workers are never
   * the master actor — `WorkerNode` is only rendered for subtasks, whose
   * `assignedWorker` comes from the backend as one of the three CLIs. Keeps
   * the inline worker dropdown well-typed without a cast.
   */
  agent: BackendAgentKind;
  title: string;
  /** Master's rationale. `null` = no rationale; only visible while `proposed`. */
  why: string | null;
  /** Upstream subtask ids. Rendered as `Depends on: #N, #N` while `proposed`. */
  dependsOn: string[];
  /**
   * Subtask ids this node replaces — non-empty only for Layer-2 replan
   * replacements the master produced after an original worker ran out of
   * retries. Drives the "replaces #N" badge so lineage is readable.
   */
  replaces: string[];
  retries: number;
  /**
   * Layer-2 replans already consumed on this subtask's lineage. The
   * EscalationActions surface hides "Try replan again" when `>= 2`;
   * all other states ignore this field. Optional because only relevant
   * in `human_escalation` state — older test fixtures that build
   * WorkerNodeData literals by hand can omit it and fall through to 0.
   */
  replanCount?: number;
  /**
   * Per-node height emitted by `layoutGraph`. The container sizes to
   * this value so escalated workers can host the EscalationActions
   * surface (~280px) while the rest of the grid stays at the default
   * 140px. Optional: defaults to `NODE_DIMENSIONS.worker.height` when
   * unset.
   */
  height?: number;
};

const STATE_LABEL: Record<NodeState, string> = {
  idle: 'Queued',
  thinking: 'Thinking',
  proposed: 'Proposed',
  approved: 'Approved',
  waiting: 'Waiting',
  running: 'Running',
  retrying: 'Retrying',
  failed: 'Failed',
  escalating: 'Escalating',
  human_escalation: 'Needs you',
  awaiting_input: 'Has a question',
  done: 'Done',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

const LOG_VISIBLE_STATES: ReadonlySet<NodeState> = new Set([
  'running',
  'retrying',
  'done',
  'failed',
]);

/**
 * Phase 4 Step 3: states where the card's whole-body click toggles
 * expand/collapse. Proposed is excluded — that state owns the
 * whole-card click as the selection-toggle affordance already.
 * `human_escalation` is included so the user can expand the failing
 * worker's log before deciding how to intervene; `cancelled` is
 * included so post-cancel inspection still works. Mirrors
 * `EXPANDABLE_STATES` in GraphCanvas (duplicated on purpose — the
 * UI gate and the layout-height gate are both authoritative and
 * should read obviously independent).
 */
const EXPANDABLE_STATES: ReadonlySet<NodeState> = new Set([
  'running',
  'retrying',
  'done',
  'failed',
  'human_escalation',
  'cancelled',
]);

/**
 * Phase 4 Step 4: states that surface the WorktreeActions folder-icon
 * affordance. The worktree only exists on disk for subtasks that have
 * actually run; proposed and waiting cards have nothing to reveal.
 * Running / retrying are omitted deliberately — the worker is still
 * writing to the worktree and we don't want the user to poke at it
 * mid-write (the spec calls this out explicitly). `skipped` and
 * `escalating` are omitted for symmetry — the worktree either was
 * never populated (skipped) or is about to be reassigned (escalating).
 * `cancelled` is included even though the lifecycle terminal path
 * clears worktrees: the backend reveals/terminal calls will naturally
 * fail on a gone directory and the user will see an error toast — we
 * still prefer to *offer* the action so the UX is consistent with done/
 * failed.
 */
const INSPECTABLE_STATES: ReadonlySet<NodeState> = new Set([
  'done',
  'failed',
  'human_escalation',
  'cancelled',
]);

/**
 * Phase 5 Step 1: states that expose the per-worker Stop affordance.
 * The worker must be in a state the backend's `cancel_subtask`
 * accepts — running / retrying / waiting. Proposed is pre-dispatch
 * (handled via remove-from-plan in the approval bar); all terminal
 * states reject. Disjoint from `INSPECTABLE_STATES`, so Stop and
 * WorktreeActions never coexist in the footer.
 */
const STOPPABLE_STATES: ReadonlySet<NodeState> = new Set([
  'running',
  'retrying',
  'waiting',
  // Phase 5 Step 4: allow Stop during `awaiting_input` so the user
  // can bail out without having to answer or skip if they want to
  // cancel the subtask outright.
  'awaiting_input',
]);

/**
 * Phase 4 Step 3: render-window cap for the expanded LogBlock. The
 * store keeps every line it receives; the expanded view shows only
 * the most recent `LOG_RENDER_WINDOW` by default, with a "Load N
 * more above" affordance that bumps the window by the same amount.
 * 2000 lines × ~80 chars is ~160KB of text per card — well under
 * any jank threshold we've measured but large enough that a chatty
 * 10-minute worker rarely hits it. Upper bound: if the log grows
 * past `LOG_HARD_CAP` we stop allowing "load more" (the DOM cost
 * of a single card holding 10k log rows isn't worth the inspection
 * value — the user should fall back to Layer-3 manual fix for that
 * far back in time). Phase 5 will revisit with virtualization.
 */
const LOG_RENDER_WINDOW = 2000;
const LOG_HARD_CAP = 10_000;

// 100-char soft limit with a counter after 80 (pre-confirmed with user).
// Backend enforces a 500-char hard floor; nothing user-visible caps that.
const TITLE_SOFT_LIMIT = 100;
const TITLE_SOFT_WARN = 80;
const TITLE_HARD_LIMIT = 500;
// `why` is advisory; no soft counter — the 200px textarea max-height is the
// visual budget and caps are enforced at the backend.
const WHY_HARD_LIMIT = 2000;

const AGENT_ORDER: readonly BackendAgentKind[] = ['claude', 'codex', 'gemini'];

export function WorkerNode({ id, data }: NodeProps) {
  const d = data as unknown as WorkerNodeData;
  const { width } = NODE_DIMENSIONS.worker;
  // `data.height` is the per-row max emitted by `layoutGraph` — it
  // expands to ~280px when this or another row-mate is in
  // `human_escalation` (so the row aligns visually). Fall back to
  // the default worker height for data shapes that haven't been
  // through the new layout pipeline (e.g. unit tests that build
  // nodes by hand).
  const height = d.height ?? NODE_DIMENSIONS.worker.height;
  const color = AGENT_COLOR_VAR[d.agent];
  const isProposed = d.state === 'proposed';
  const isEscalated = d.state === 'human_escalation';
  const strikeTitle = d.state === 'escalating' || d.state === 'skipped';
  const showLogs = LOG_VISIBLE_STATES.has(d.state);
  const isInspectable = INSPECTABLE_STATES.has(d.state);
  const isStoppable = STOPPABLE_STATES.has(d.state);

  const isSelected = useGraphStore((s) => s.selectedSubtaskIds.has(id));
  const toggle = useGraphStore((s) => s.toggleSubtaskSelection);
  // Subscribe only to this node's logs — identity-stable when other nodes
  // append so this worker doesn't rerender on every graph-wide log write.
  const logs = useGraphStore((s) => s.nodeLogs.get(id));
  // Phase 4 Step 3: expand state — subscribe to this id's membership
  // only. The Set identity flips on every toggle, but the `.has`
  // projection gives us a stable boolean selector so unrelated
  // expands/collapses don't rerender this card.
  const isExpanded = useGraphStore((s) => s.workerExpanded.has(id));
  // Phase 5 Step 4: subscribe to this subtask's pending question
  // entry only. Identity-stable across sibling updates.
  const pendingQuestion = useGraphStore((s) => s.pendingQuestions.get(id));
  const toggleExpanded = useGraphStore((s) => s.toggleWorkerExpanded);
  const canExpand = EXPANDABLE_STATES.has(d.state);
  // Phase 3.5 Item 6: per-subtask diff — available once the backend has
  // collected diffs for this worker during the Apply pre-merge pass. We
  // subscribe to this id's entry only; a sibling worker's diff arriving
  // won't rerender this card. `undefined` = no diff yet (still running
  // or not a done subtask); a vec (possibly empty) means the chip should
  // render with the file count.
  const diff = useGraphStore((s) => s.subtaskDiffs.get(id));

  // Derived provenance badges. Both selectors are cheap (map/set lookups
  // plus a three-field comparison), and subscribing to the whole state
  // slice keeps them in sync with both re-plan re-emits and local edits.
  const edited = useGraphStore((s) => isSubtaskEdited(s, id));
  const added = useGraphStore((s) => isSubtaskAdded(s, id));

  // Phase 4 Step 5: error category attached to the last `Failed`
  // transition for this subtask, if any. `undefined` for non-failed
  // subtasks and for failed subtasks whose backend predates Step 5
  // (Option payload on the wire). Only read; never written here.
  const errorCategory = useGraphStore((s) => s.subtaskErrorCategories.get(id));

  // Inline-edit one-shot: if the store just coined this id via addSubtask,
  // auto-enter edit mode on the title. Consume the flag in a layout effect
  // so we don't re-trigger on re-renders of the same node.
  const autoEnter = useGraphStore((s) => s.lastAddedSubtaskId === id);
  const clearLastAdded = useGraphStore((s) => s.clearLastAddedSubtaskId);
  useLayoutEffect(() => {
    if (autoEnter) clearLastAdded();
  }, [autoEnter, clearLastAdded]);

  // Phase 4 Step 3: card-body click / keyboard toggle for expand.
  // Interactive children (chips, buttons, inputs, dropdowns) already
  // stopPropagation on their own handlers, so the card-level handler
  // here only fires on empty-padding regions, the title text, and the
  // LogBlock surface — exactly the "card body" the spec calls out.
  // useCallback so the function identity is stable across renders —
  // otherwise the eslint exhaustive-deps check on onCardKeyDown below
  // flags the ternary as a per-render closure.
  const onCardClick = useCallback(() => {
    if (isProposed) {
      toggle(id);
    } else if (canExpand) {
      toggleExpanded(id);
    }
  }, [isProposed, canExpand, toggle, toggleExpanded, id]);
  const hasCardAction = isProposed || canExpand;
  // Space/Enter mirror onClick while the card has focus. A11y-standard
  // `role="button"` affordance — we intentionally don't use a real
  // <button> because the card's flex layout and rich child content
  // don't fit inside one, and React Flow nodes are semantically
  // container-like. preventDefault on Space stops the page from
  // scrolling on activation.
  const onCardKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!hasCardAction) return;
      if (e.target !== e.currentTarget) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      onCardClick();
    },
    [hasCardAction, onCardClick],
  );

  return (
    <NodeContainer
      variant="worker"
      state={d.state}
      agentColor={color}
      width={width}
      height={height}
      // Whole-card click is a mouse affordance with two meanings:
      //   - proposed  → selection toggle (checkbox proxy)
      //   - expandable → expand/collapse the log surface
      // The checkbox is the accessible truth for proposed (it
      // stops propagation below so a direct click doesn't double-
      // toggle). Expand is keyboard-reachable via the role+tabIndex
      // pair we set below. Interactive children (inputs, dropdowns,
      // chips, buttons) already wear `nodrag nopan` + stopPropagation
      // so card-click only fires from empty padding / title / log
      // regions — the intended hit-test.
      onClick={hasCardAction ? onCardClick : undefined}
      onKeyDown={canExpand ? onCardKeyDown : undefined}
      role={canExpand ? 'button' : undefined}
      tabIndex={canExpand ? 0 : undefined}
      ariaExpanded={canExpand ? isExpanded : undefined}
      dataTestId={`worker-node-${id}`}
      // `group` opts the whole card into Tailwind's group-hover pattern
      // so the remove button fades in on hover without JS state. Only
      // relevant while proposed — in other states RemoveButton isn't
      // rendered and the class is a no-op.
      className={isProposed ? 'group' : undefined}
      // Dim proposed subtasks the user has unticked so the surviving
      // selection reads as the focus. Gated on `isProposed` because
      // `isSelected` is stale noise once execution starts (running /
      // done / failed cards never belong to the approval set).
      dimmed={isProposed && !isSelected}
    >
      <Handle type="target" position={Position.Top} className="!border-0 !bg-transparent" />
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isProposed ? (
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => toggle(id)}
              onClick={(e) => e.stopPropagation()}
              aria-label={`Select ${d.title || id}`}
              className="size-3 cursor-pointer accent-[var(--color-agent-master)]"
            />
          ) : (
            <StatusDot color={statusColor(d.state, color)} />
          )}
          <span className="text-hint uppercase tracking-wide text-fg-secondary">
            {STATE_LABEL[d.state]}
          </span>
          {/* Phase 4 Step 5: inline error-category chip. Rendered only
              on Failed cards with a classified category — legacy
              failures (pre-Step-5 payloads) fall back to just the
              "Failed" label. Copy flows through
              `describeErrorCategory` so ErrorBanner and the chip stay
              in lockstep on the five locked strings. */}
          {d.state === 'failed' && errorCategory !== undefined ? (
            <Badge
              variant="failed"
              tooltip={describeErrorCategory(errorCategory)}
            >
              <span data-testid={`worker-error-category-${id}`}>
                {describeErrorCategory(errorCategory)}
              </span>
            </Badge>
          ) : null}
          {isProposed && added ? (
            <Badge variant="added" tooltip="Added by you — not from master's original plan.">
              added
            </Badge>
          ) : null}
          {isProposed && edited ? (
            <Badge variant="edited" tooltip="Modified from master's original plan.">
              edited
            </Badge>
          ) : null}
          {d.replaces.length > 0 ? <ReplacesBadge ids={d.replaces} /> : null}
        </div>
        <div className="flex items-center gap-2">
          {d.retries > 0 ? (
            <span className="text-hint text-fg-tertiary">retry {d.retries}</span>
          ) : null}
          {isProposed ? <RemoveButton id={id} title={d.title} /> : null}
          {canExpand ? <ExpandChevron isExpanded={isExpanded} /> : null}
        </div>
      </header>

      {isProposed ? (
        <ProposedBody id={id} data={d} autoEnter={autoEnter} />
      ) : (
        <NonProposedBody title={d.title} why={d.why} strikeTitle={strikeTitle} />
      )}

      {isEscalated ? (
        <EscalationActions subtaskId={id} replanCount={d.replanCount ?? 0} />
      ) : null}

      {/* Phase 6 Step 2: activity chip stack — sits above the log
          tail on running/retrying cards. Empty stack renders null,
          so non-running states are unaffected. Compressed bursts
          shrink the visible chip count without altering the
          underlying event store. */}
      {showLogs ? <ActivityChipStack subtaskId={id} /> : null}

      {showLogs ? (
        isExpanded && canExpand ? (
          <ExpandedLogBlock
            lines={logs ?? []}
            animateCursor={isStreaming(d.state)}
          />
        ) : (
          <LogBlock lines={logs ?? []} animateCursor={isStreaming(d.state)} />
        )
      ) : null}
      {/*
        Expanded + non-streaming expandable states without a LogBlock
        (cancelled, human_escalation) still get the expanded surface
        — the tail LogBlock itself is gated on `showLogs`, but the
        expand toggle is legal on those states per the spec. Render
        a placeholder so the card fills its content-fit container rather
        than leaving blank space. Double-gated on `canExpand` to
        defend against a stale set entry on a transient non-
        expandable state (skipped / escalating).
      */}
      {isExpanded && canExpand && !showLogs ? (
        <ExpandedLogBlock lines={logs ?? []} animateCursor={false} />
      ) : null}

      {/* Phase 5 Step 4: QuestionInput renders on `awaiting_input`
          state, sitting above the footer so it's the primary
          interaction surface on the card. Backed by the store's
          `pendingQuestions` map — ignored when the state is not
          awaiting_input (defensive, since the map clears on every
          transition out). */}
      {d.state === 'awaiting_input' && pendingQuestion ? (
        <QuestionInput subtaskId={id} question={pendingQuestion.question} />
      ) : null}

      <footer className="mt-auto flex items-center justify-end gap-1">
        {/* Phase 5 Step 1: per-worker Stop. Rendered on running /
            retrying / waiting — disjoint from INSPECTABLE_STATES, so
            Stop and WorktreeActions never coexist. Bypasses the retry
            ladder entirely; subtask transitions to `cancelled`
            (user-intent terminal) without triggering Layer 1 retry,
            Layer 2 replan, or Layer 3 escalation. */}
        {isStoppable ? <StopButton subtaskId={id} /> : null}
        {/* Phase 4 Step 4: worktree inspection affordance. Rendered
            only on inspectable states (done / failed / human_escalation
            / cancelled) — running workers must not be poked at mid-
            write, proposed subtasks have no worktree yet. Folder icon
            opens a menu with Reveal / Copy path / Open terminal. */}
        {isInspectable ? <WorktreeActions subtaskId={id} /> : null}
        {/* File-count chip sits left of the agent chip on done workers.
            Hidden while proposed (no work yet) and while running (diff
            hasn't been collected). `undefined` diff = no chip; empty
            diff = "0 files" (user-visible signal the worker touched
            nothing). */}
        {!isProposed && diff !== undefined ? (
          <FileCountChip files={diff} />
        ) : null}
        {isProposed ? (
          <WorkerDropdown id={id} value={d.agent} />
        ) : (
          <Chip variant="agent" color={color}>
            {AGENT_LABEL[d.agent]}
          </Chip>
        )}
      </footer>
      <Handle type="source" position={Position.Bottom} className="!border-0 !bg-transparent" />
    </NodeContainer>
  );
}

// ---------- Proposed-state sub-components ----------

function ProposedBody({
  id,
  data,
  autoEnter,
}: {
  id: string;
  data: WorkerNodeData;
  autoEnter: boolean;
}) {
  const updateSubtask = useGraphStore((s) => s.updateSubtask);

  const onSaveTitle = async (next: string) => {
    const trimmed = next.trim();
    await updateSubtask(id, { title: trimmed });
  };

  const onSaveWhy = async (next: string) => {
    // Empty string → null → backend clears. InlineTextEdit's "no-op save"
    // already skips the call when the value didn't change.
    await updateSubtask(id, { why: next.trim().length === 0 ? null : next });
  };

  return (
    <div
      className="flex min-h-0 flex-col gap-1"
      // Card-click-to-toggle is an empty-padding affordance. Keep inline
      // edit clicks from bubbling up so typing in the title doesn't flip
      // selection on every keystroke focus-change.
      onClick={(e) => e.stopPropagation()}
    >
      {/*
        `shrink-0` on title: the card is a fixed 140px and the why field
        below can wrap to multiple lines. Without this, flex's default
        shrink would squeeze the title to zero height, and the
        `truncate` class's `overflow: hidden` would clip it invisible —
        which is exactly what the proposed cards were doing. Title gets
        to keep its natural one-line height; the why is the one that
        shrinks+scrolls when the rationale runs long.
      */}
      <InlineTextEdit
        value={data.title}
        onSave={onSaveTitle}
        validate={(next) =>
          next.trim().length === 0 ? 'Title is required.' : null
        }
        ariaLabel="Subtask title"
        textClassName="shrink-0 text-body text-fg-primary truncate"
        inputClassName="text-body"
        maxLength={TITLE_HARD_LIMIT}
        softLimit={TITLE_SOFT_LIMIT}
        softLimitWarnAt={TITLE_SOFT_WARN}
        autoEnterEdit={autoEnter}
        emptyPlaceholder="Untitled subtask"
      />
      <InlineTextEdit
        value={data.why ?? ''}
        onSave={onSaveWhy}
        ariaLabel="Subtask rationale"
        multiline
        maxLength={WHY_HARD_LIMIT}
        textClassName="min-h-0 overflow-hidden text-meta text-fg-tertiary"
        inputClassName="text-meta"
        emptyPlaceholder="Add context…"
      />
      {data.dependsOn.length > 0 ? <DependsOn ids={data.dependsOn} /> : null}
    </div>
  );
}

/**
 * Read-only body for approved/running/done/escalating WorkerNodes.
 *
 * Two visibility guarantees the old `<p>{d.title}</p>` lacked:
 * - **Empty-title fallback**: an italic "(Untitled subtask)" in tertiary
 *   so a card whose upstream producer somehow emitted an empty title
 *   (a user-added subtask the user approved without typing, a master
 *   parser regression, etc.) never renders as an invisible card body.
 *   The spec allows empty titles in proposed state; this keeps the
 *   card legible after the approval boundary without relaxing the
 *   approval invariant.
 * - **Why line**: the master's rationale was previously only visible
 *   while a subtask was in `proposed` state. For `approved`/`running`/
 *   `done`/`failed` states we render it as a single truncated italic
 *   line beneath the title — context for the user watching a worker
 *   execute. Hidden when empty; hovering reveals the full text via
 *   the native `title` attribute.
 */
function NonProposedBody({
  title,
  why,
  strikeTitle,
}: {
  title: string;
  why: string | null;
  strikeTitle: boolean;
}) {
  const emptyTitle = title.trim().length === 0;
  const visibleWhy = (why ?? '').trim();
  // `shrink-0` on both lines: the running-state card packs header +
  // title + why + LogBlock(54px) + chip into a fixed 140px. Without
  // shrink-0, the `truncate` class's `overflow: hidden` lets flex
  // squeeze the `<p>` to zero height and the text disappears —
  // matching the proposed-state bug the title of this component's
  // twin has. Title and why are both single-line truncated, so keeping
  // them at natural height is always cheap.
  return (
    <div className="flex min-h-0 flex-col gap-0.5">
      <p
        className={`shrink-0 truncate text-body ${emptyTitle ? 'italic text-fg-tertiary' : 'text-fg-primary'}`}
        style={strikeTitle ? { textDecoration: 'line-through' } : undefined}
        title={title || 'Untitled subtask'}
      >
        {emptyTitle ? '(Untitled subtask)' : title}
      </p>
      {visibleWhy.length > 0 ? (
        <p
          className="shrink-0 truncate text-meta italic text-fg-tertiary"
          title={visibleWhy}
          data-testid="worker-why"
        >
          {visibleWhy}
        </p>
      ) : null}
    </div>
  );
}

function ReplacesBadge({ ids }: { ids: readonly string[] }) {
  // Resolve each original id to its 1-indexed position in the current
  // subtask list so the badge reads "replaces #N" instead of exposing
  // opaque ulids — same pattern as DependsOn. Unknown ids (possible
  // transiently during a replan re-emit) are silently dropped; the
  // badge is display-only and would lie if it referenced a dead row.
  const subtasks = useGraphStore((s) => s.subtasks);
  const labels = useMemo(() => {
    const out: string[] = [];
    for (const dep of ids) {
      const idx = subtasks.findIndex((s) => s.id === dep);
      if (idx >= 0) out.push(`#${idx + 1}`);
    }
    return out;
  }, [ids, subtasks]);
  if (labels.length === 0) return null;
  return (
    <Badge
      variant="neutral"
      tooltip="Master replanned — this subtask replaces the originals listed."
    >
      replaces {labels.join(', ')}
    </Badge>
  );
}

function DependsOn({ ids }: { ids: readonly string[] }) {
  // Resolve each id to its 1-indexed position in the current subtask list
  // so the footer reads "Depends on: #1, #3" rather than exposing opaque
  // ulids. Unknown ids (possible during a re-plan while the store is
  // briefly out of sync) are silently dropped — this is display-only.
  const subtasks = useGraphStore((s) => s.subtasks);
  // useReactFlow lives behind ReactFlowProvider, which GraphCanvas already
  // wraps every rendered WorkerNode with. Pulling the helpers here keeps
  // the pan logic colocated with the render site.
  const { getNode, setCenter, getViewport } = useReactFlow();

  const labels = useMemo(() => {
    const out: { id: string; label: string }[] = [];
    for (const dep of ids) {
      const idx = subtasks.findIndex((s) => s.id === dep);
      if (idx >= 0) out.push({ id: dep, label: `#${idx + 1}` });
    }
    return out;
  }, [ids, subtasks]);

  const panToSubtask = (depId: string) => {
    const node = getNode(depId);
    // Node may be absent if a re-plan ran between render and click. Graceful
    // no-op — no crash, no toast; the footer will re-render without the
    // stale row on the next frame once the store settles.
    if (!node) return;
    // Match React Flow's own autoPanOnNodeFocus pattern (see `@xyflow/react`
    // internals): center = node origin + half-dimensions, preserve current
    // zoom explicitly. Fall back to the layout dimensions we use at render
    // time so the calculation is correct even before measured dimensions
    // land on the node.
    const w = node.width ?? NODE_DIMENSIONS.worker.width;
    const h = node.height ?? NODE_DIMENSIONS.worker.height;
    const cx = node.position.x + w / 2;
    const cy = node.position.y + h / 2;
    const { zoom } = getViewport();
    void setCenter(cx, cy, { zoom, duration: 300 });
  };

  if (labels.length === 0) return null;
  return (
    <div className="text-hint text-fg-tertiary">
      Depends on:{' '}
      {labels.map((l, i) => (
        <span key={l.id}>
          {i > 0 ? ', ' : null}
          <button
            type="button"
            // nodrag/nopan defeat React Flow's pan-on-drag inside the node;
            // stopPropagation prevents the card-click-to-select affordance
            // from firing when the user actually meant to pan.
            className="nodrag nopan font-mono text-fg-tertiary hover:underline focus-visible:underline focus-visible:outline-none"
            onClick={(e) => {
              e.stopPropagation();
              panToSubtask(l.id);
            }}
            aria-label={`Pan to subtask ${l.label}`}
            data-testid={`depends-on-link-${l.id}`}
          >
            {l.label}
          </button>
        </span>
      ))}
    </div>
  );
}

function WorkerDropdown({ id, value }: { id: string; value: BackendAgentKind }) {
  const detection = useAgentStore((s) => s.detection);
  const updateSubtask = useGraphStore((s) => s.updateSubtask);

  // Only offer CLIs the detector flagged `available`. An agent that's
  // broken / not-installed would be rejected by the backend, so not
  // exposing it keeps the dropdown honest.
  const options: DropdownOption<BackendAgentKind>[] = AGENT_ORDER.filter((agent) =>
    isSelectable(detection?.[agent]),
  ).map((agent) => ({
    value: agent,
    label: AGENT_LABEL[agent],
  }));

  // If the current value isn't in the available list (detection hasn't
  // finished, or the user's environment changed mid-run) surface it as
  // a disabled single-option trigger rather than flipping to something
  // else unbidden.
  const color = AGENT_COLOR_VAR[value];

  return (
    <Dropdown<BackendAgentKind>
      value={value}
      options={options.length > 0 ? options : [{ value, label: AGENT_LABEL[value] }]}
      onChange={(next) => {
        if (next === value) return;
        void updateSubtask(id, { assignedWorker: next });
      }}
      ariaLabel={`Worker for ${id}`}
      renderTrigger={({ toggle, open, triggerRef }) => (
        <button
          ref={triggerRef}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={`Worker for ${id}`}
          className="nodrag nopan inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-hint hover:bg-bg-subtle/40"
          style={{ borderColor: color, color }}
        >
          {AGENT_LABEL[value]}
          <span aria-hidden style={{ fontSize: 8, opacity: 0.8 }}>
            ▼
          </span>
        </button>
      )}
    />
  );
}

function RemoveButton({ id, title }: { id: string; title: string }) {
  const removeSubtask = useGraphStore((s) => s.removeSubtask);
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<number | null>(null);

  const arm = () => {
    setConfirming(true);
    // Auto-dismiss after 4s so the user can't be nagged into confirming
    // if they mis-clicked and walked away.
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setConfirming(false), 4000);
  };

  // Clear the pending dismiss timer if the button unmounts (e.g. subtask
  // transitioned out of `proposed` while the confirm prompt was open).
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const confirm = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setConfirming(false);
    void removeSubtask(id);
  };

  if (confirming) {
    return (
      <span
        className="nodrag nopan flex items-center gap-1 text-hint"
        onClick={(e) => e.stopPropagation()}
      >
        <span style={{ color: 'var(--color-status-failed)' }}>Remove?</span>
        <button
          type="button"
          onClick={confirm}
          className="rounded-sm border px-1 py-0.5"
          style={{
            borderColor: 'var(--color-status-failed)',
            color: 'var(--color-status-failed)',
          }}
          aria-label={`Confirm remove ${title || id}`}
        >
          Yes
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded-sm border px-1 py-0.5 text-fg-tertiary"
          style={{ borderColor: 'var(--color-border-default)' }}
          aria-label={`Cancel remove ${title || id}`}
        >
          No
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        arm();
      }}
      aria-label={`Remove ${title || id}`}
      className="nodrag nopan flex size-4 items-center justify-center rounded-sm text-fg-tertiary opacity-0 transition-opacity duration-150 ease-out hover:bg-bg-subtle/40 focus-visible:opacity-100 group-hover:opacity-100"
      data-testid="worker-remove-button"
    >
      <span aria-hidden style={{ fontSize: 11, lineHeight: 1 }}>
        ×
      </span>
    </button>
  );
}

/**
 * Phase 3.5 Item 6: clickable "N files" chip + diff popover. Shown on
 * done/failed workers once the backend has emitted `run:subtask_diff`
 * for this id. Keyed on a local `open` flag so reparenting the card
 * (e.g. a layout recompute) doesn't leak an open popover to another
 * worker. Stops click propagation so the card-click-to-select
 * affordance doesn't fire and so a click on the chip while the popover
 * is open doesn't race the outside-click dismiss in the popover.
 */
function FileCountChip({ files }: { files: readonly import('../../lib/ipc').FileDiff[] }) {
  const [open, setOpen] = useState(false);
  const count = files.length;
  return (
    <span className="relative">
      <button
        type="button"
        // nodrag/nopan so React Flow doesn't hijack the click for a pan
        // gesture. aria-expanded drives screen-reader state; click toggles
        // the popover and doubles as the dismiss affordance when open.
        className="nodrag nopan inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-hint hover:bg-bg-subtle/40"
        style={{
          borderColor: 'var(--color-border-default)',
          color: 'var(--color-fg-secondary)',
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Show ${count} changed file${count === 1 ? '' : 's'}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        data-testid="worker-file-count-chip"
      >
        {count} file{count === 1 ? '' : 's'}
      </button>
      {open ? <DiffPopover files={files} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}

// Backend emits this reserved-prefix marker on the log channel right
// before the second (retry) attempt begins — see
// `execute_subtask_with_retry` in dispatcher.rs. We render it as a
// thin horizontal rule with the previous error inline rather than a
// normal log line so the user can see where attempt 1 ended and
// attempt 2 began.
const RETRY_LOG_MARKER = '[whalecode] retry';

function LogBlock({ lines, animateCursor }: { lines: readonly string[]; animateCursor: boolean }) {
  const tail = lines.slice(-3);
  // Done / failed with no logs emitted: don't render the block at all —
  // a placeholder would mislead the user into thinking output is still
  // coming. The card's terminal-state border already communicates the
  // outcome, and our per-state height (180px) stays reserved so the
  // layout doesn't shift.
  if (tail.length === 0 && !animateCursor) return null;
  return (
    <div
      // Background intentionally transparent — inherits bg-elevated from
      // the card. The older darker `bg-primary` fill created a stark
      // black rectangle during the brief window before the first log
      // line arrived; with the placeholder row below, the terminal
      // identity comes from font-mono + italic waiting hint + cursor,
      // not from a darker fill.
      className="font-mono text-fg-tertiary"
      style={{
        padding: '6px 8px',
        fontSize: 10,
        lineHeight: 1.5,
        height: 54,
        overflow: 'hidden',
      }}
      data-testid="worker-log-block"
    >
      {tail.length === 0 ? (
        <div className="truncate italic" data-testid="worker-log-waiting">
          Waiting for output…
          <BlinkingCursor />
        </div>
      ) : (
        tail.map((line, i) => {
          const isLast = i === tail.length - 1;
          if (line.startsWith(RETRY_LOG_MARKER)) {
            return (
              <RetrySeparator
                key={`${i}-retry`}
                prevError={extractRetryError(line)}
              />
            );
          }
          return (
            <div key={`${i}-${line}`} className="truncate">
              <LogLine line={line} />
              {isLast && animateCursor ? <BlinkingCursor /> : null}
            </div>
          );
        })
      )}
    </div>
  );
}

/**
 * Phase 4 Step 3: "pinned open" chevron that rotates 90° when the
 * card is expanded. Purely visual — click/keyboard toggling happens
 * at the NodeContainer level. stopPropagation on the span so a
 * direct click on the chevron doesn't fire the card's onClick twice
 * (it bubbles up to the card anyway if the user clicks the chevron,
 * which is fine — but stopping it here is a belt-and-braces gate
 * against future handler changes).
 */
function ExpandChevron({ isExpanded }: { isExpanded: boolean }) {
  return (
    <span
      aria-hidden
      className="text-hint text-fg-tertiary"
      style={{
        display: 'inline-block',
        transition: 'transform 150ms ease-out',
        transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
      }}
      data-testid="worker-expand-chevron"
      data-expanded={isExpanded ? 'true' : 'false'}
    >
      ▸
    </span>
  );
}

/**
 * Phase 4 Step 3: full-log surface shown when the card is expanded.
 * Renders a scrollable tail of `LOG_RENDER_WINDOW` lines with a
 * "load more above" button that bumps the window by the same amount
 * until the hard cap. Auto-scrolls to the bottom when new lines
 * arrive while the user hasn't deliberately scrolled up — same
 * pattern as terminal emulators.
 */
function ExpandedLogBlock({
  lines,
  animateCursor,
}: {
  lines: readonly string[];
  animateCursor: boolean;
}) {
  const total = lines.length;
  const [windowSize, setWindowSize] = useState(LOG_RENDER_WINDOW);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottomRef = useRef(true);

  // Clamp window to the available cap — avoids asking to render more
  // lines than `LOG_HARD_CAP` even if the caller keeps clicking.
  const effectiveWindow = Math.min(windowSize, total, LOG_HARD_CAP);
  const start = Math.max(0, total - effectiveWindow);
  const visible = useMemo(
    () => lines.slice(start, total),
    [lines, start, total],
  );
  const hasMoreAbove = start > 0 && windowSize < LOG_HARD_CAP;

  // Detect manual scroll-up so the auto-follow behaviour respects
  // the user parking at an older line. Once they scroll back to the
  // bottom we re-pin. 4px slop covers rounding noise on retina.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    pinnedToBottomRef.current = nearBottom;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!pinnedToBottomRef.current) return;
    // Jump, not scroll — running workers may emit many lines per
    // frame; a smooth scroll would queue and visibly lag behind.
    el.scrollTop = el.scrollHeight;
  }, [visible.length, animateCursor]);

  const onLoadMore = useCallback(
    (e: ReactMouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      setWindowSize((w) => Math.min(w + LOG_RENDER_WINDOW, LOG_HARD_CAP));
      // Stay where the user was — don't snap to bottom when older
      // lines get prepended.
      pinnedToBottomRef.current = false;
    },
    [],
  );

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      // Stop click bubbling so the user can select log text or tap
      // the load-more button without collapsing the card.
      onClick={(e) => e.stopPropagation()}
      className="font-mono text-fg-tertiary"
      style={{
        flex: 1,
        minHeight: 0,
        padding: '6px 8px',
        fontSize: 10,
        lineHeight: 1.5,
        overflowY: 'auto',
        background: 'var(--color-bg-primary)',
      }}
      data-testid="worker-log-expanded"
    >
      {hasMoreAbove ? (
        <button
          type="button"
          onClick={onLoadMore}
          className="nodrag nopan mb-1 w-full rounded-sm border border-dashed py-0.5 text-hint text-fg-tertiary hover:bg-bg-subtle/40"
          style={{ borderColor: 'var(--color-border-default)' }}
          data-testid="worker-log-load-more"
        >
          Load {Math.min(LOG_RENDER_WINDOW, start)} more above ·{' '}
          {start.toLocaleString()} hidden
        </button>
      ) : null}
      {visible.length === 0 ? (
        <div className="italic" data-testid="worker-log-expanded-empty">
          Waiting for output…
          {animateCursor ? <BlinkingCursor /> : null}
        </div>
      ) : (
        visible.map((line, i) => {
          const isLast = i === visible.length - 1;
          if (line.startsWith(RETRY_LOG_MARKER)) {
            return (
              <RetrySeparator
                key={`${start + i}-retry`}
                prevError={extractRetryError(line)}
              />
            );
          }
          return (
            <div key={`${start + i}`} className="whitespace-pre-wrap break-all">
              <LogLine line={line} />
              {isLast && animateCursor ? <BlinkingCursor /> : null}
            </div>
          );
        })
      )}
    </div>
  );
}

/** Strip the `[whalecode] retry: ` prefix, leaving the failure message. */
function extractRetryError(line: string): string {
  const rest = line.slice(RETRY_LOG_MARKER.length);
  return rest.startsWith(':') ? rest.slice(1).trim() : rest.trim();
}

function RetrySeparator({ prevError }: { prevError: string }) {
  return (
    <div
      className="flex items-center gap-2 truncate"
      style={{
        color: 'var(--color-status-retry)',
        borderTop: '1px dashed var(--color-status-retry)',
        paddingTop: 2,
        marginTop: 2,
      }}
      data-testid="worker-log-retry-separator"
      title={prevError}
    >
      <span>── retrying after failure</span>
      {prevError ? (
        <span className="truncate text-fg-tertiary" style={{ fontStyle: 'italic' }}>
          {prevError}
        </span>
      ) : null}
    </div>
  );
}

function LogLine({ line }: { line: string }) {
  const first = line.charAt(0);
  const color = PREFIX_COLOR[first];
  if (!color) return <>{line}</>;
  return (
    <>
      <span style={{ color }}>{first}</span>
      {line.slice(1)}
    </>
  );
}

function BlinkingCursor() {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        marginLeft: 2,
        width: 6,
        height: '1em',
        verticalAlign: '-0.15em',
        background: 'currentColor',
        animation: 'log-cursor-blink 1s step-end infinite',
      }}
    />
  );
}

const PREFIX_COLOR: Record<string, string> = {
  '✓': 'var(--color-status-success)',
  '→': 'var(--color-fg-tertiary)',
  '⚠': 'var(--color-status-retry)',
  '✗': 'var(--color-status-failed)',
};

function isStreaming(state: NodeState): boolean {
  return state === 'running' || state === 'retrying';
}

function statusColor(state: NodeState, agent: string): string {
  if (state === 'done') return 'var(--color-status-success)';
  if (state === 'failed' || state === 'human_escalation') return 'var(--color-status-failed)';
  if (state === 'retrying' || state === 'escalating') return 'var(--color-status-retry)';
  if (state === 'waiting' || state === 'skipped') return 'var(--color-fg-tertiary)';
  return agent;
}
