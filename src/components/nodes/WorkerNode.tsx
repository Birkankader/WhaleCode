import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

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
  retries: number;
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
  done: 'Done',
  skipped: 'Skipped',
};

const LOG_VISIBLE_STATES: ReadonlySet<NodeState> = new Set([
  'running',
  'retrying',
  'done',
  'failed',
]);

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
  const { width, height } = NODE_DIMENSIONS.worker;
  const color = AGENT_COLOR_VAR[d.agent];
  const isProposed = d.state === 'proposed';
  const strikeTitle = d.state === 'escalating' || d.state === 'skipped';
  const showLogs = LOG_VISIBLE_STATES.has(d.state);

  const isSelected = useGraphStore((s) => s.selectedSubtaskIds.has(id));
  const toggle = useGraphStore((s) => s.toggleSubtaskSelection);
  // Subscribe only to this node's logs — identity-stable when other nodes
  // append so this worker doesn't rerender on every graph-wide log write.
  const logs = useGraphStore((s) => s.nodeLogs.get(id));

  // Derived provenance badges. Both selectors are cheap (map/set lookups
  // plus a three-field comparison), and subscribing to the whole state
  // slice keeps them in sync with both re-plan re-emits and local edits.
  const edited = useGraphStore((s) => isSubtaskEdited(s, id));
  const added = useGraphStore((s) => isSubtaskAdded(s, id));

  // Inline-edit one-shot: if the store just coined this id via addSubtask,
  // auto-enter edit mode on the title. Consume the flag in a layout effect
  // so we don't re-trigger on re-renders of the same node.
  const autoEnter = useGraphStore((s) => s.lastAddedSubtaskId === id);
  const clearLastAdded = useGraphStore((s) => s.clearLastAddedSubtaskId);
  useLayoutEffect(() => {
    if (autoEnter) clearLastAdded();
  }, [autoEnter, clearLastAdded]);

  return (
    <NodeContainer
      variant="worker"
      state={d.state}
      agentColor={color}
      width={width}
      height={height}
      // Whole-card click is a mouse affordance for toggling selection in
      // the proposed state. The checkbox is the accessible truth — it
      // stops propagation below so a direct click doesn't double-toggle.
      // In proposed state the inner inputs/dropdown all wear `nodrag
      // nopan` + `stopPropagation` so card-click only fires from empty
      // padding regions, which is the intended affordance.
      onClick={isProposed ? () => toggle(id) : undefined}
      // `group` opts the whole card into Tailwind's group-hover pattern
      // so the remove button fades in on hover without JS state. Only
      // relevant while proposed — in other states RemoveButton isn't
      // rendered and the class is a no-op.
      className={isProposed ? 'group' : undefined}
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
        </div>
        <div className="flex items-center gap-2">
          {d.retries > 0 ? (
            <span className="text-hint text-fg-tertiary">retry {d.retries}</span>
          ) : null}
          {isProposed ? <RemoveButton id={id} title={d.title} /> : null}
        </div>
      </header>

      {isProposed ? (
        <ProposedBody id={id} data={d} autoEnter={autoEnter} />
      ) : (
        <p
          className="truncate text-body text-fg-primary"
          style={strikeTitle ? { textDecoration: 'line-through' } : undefined}
          title={d.title}
        >
          {d.title}
        </p>
      )}

      {showLogs ? <LogBlock lines={logs ?? []} animateCursor={isStreaming(d.state)} /> : null}

      <footer className="mt-auto flex items-center justify-end">
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
      <InlineTextEdit
        value={data.title}
        onSave={onSaveTitle}
        validate={(next) =>
          next.trim().length === 0 ? 'Title is required.' : null
        }
        ariaLabel="Subtask title"
        textClassName="text-body text-fg-primary truncate"
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
        textClassName="text-meta text-fg-tertiary"
        inputClassName="text-meta"
        emptyPlaceholder="Add context…"
      />
      {data.dependsOn.length > 0 ? <DependsOn ids={data.dependsOn} /> : null}
    </div>
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

// Backend emits this reserved-prefix marker on the log channel right
// before the second (retry) attempt begins — see
// `execute_subtask_with_retry` in dispatcher.rs. We render it as a
// thin horizontal rule with the previous error inline rather than a
// normal log line so the user can see where attempt 1 ended and
// attempt 2 began.
const RETRY_LOG_MARKER = '[whalecode] retry';

function LogBlock({ lines, animateCursor }: { lines: readonly string[]; animateCursor: boolean }) {
  const tail = lines.slice(-3);
  return (
    <div
      className="font-mono text-fg-tertiary"
      style={{
        background: 'var(--color-bg-primary)',
        borderRadius: 4,
        padding: '6px 8px',
        fontSize: 10,
        lineHeight: 1.5,
        height: 54,
        overflow: 'hidden',
      }}
      data-testid="worker-log-block"
    >
      {tail.map((line, i) => {
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
      })}
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
