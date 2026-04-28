import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Check } from 'lucide-react';

import { NODE_DIMENSIONS } from '../../lib/layout';
import { useGraphStore } from '../../state/graphStore';
import type { NodeState } from '../../state/nodeMachine';
import { Button } from '../primitives/Button';
import { NodeContainer } from '../primitives/NodeContainer';
import { StatusDot } from '../primitives/StatusDot';

export type FinalNodeData = {
  state: NodeState;
  label: string;
  files: readonly string[];
  /**
   * Non-null when a merge conflict is live. Array contains offending paths.
   * Rendering switches to the conflict variant, which hides Apply and keeps
   * only Discard enabled. `null` means no conflict (the normal ready-to-merge
   * path); `[]` is treated as "no conflict" defensively — backend shouldn't
   * emit it but we guard rather than crash.
   */
  conflictFiles?: readonly string[] | null;
};

const CONFLICT_FILE_LIMIT = 5;

export function FinalNode({ data }: NodeProps) {
  const d = data as unknown as FinalNodeData;
  const { width, height } = NODE_DIMENSIONS.final;
  const applyRun = useGraphStore((s) => s.applyRun);
  const discardRun = useGraphStore((s) => s.discardRun);
  // Phase 7 polish: read run-level state so the MERGE node reflects
  // the post-Apply outcome instead of leaving the "Apply to branch"
  // button live (looks like the click did nothing, even though the
  // ApplySummaryOverlay confirmed success on the right).
  const status = useGraphStore((s) => s.status);
  const applySummary = useGraphStore((s) => s.applySummary);

  const conflicting =
    d.conflictFiles !== null && d.conflictFiles !== undefined && d.conflictFiles.length > 0;

  if (conflicting) {
    return (
      <NodeContainer
        variant="final"
        state="failed"
        agentColor="var(--color-status-failed)"
        width={width}
        height={height}
      >
        <Handle type="target" position={Position.Top} className="!border-0 !bg-transparent" />
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <StatusDot color="var(--color-status-failed)" />
            <span className="text-hint uppercase tracking-wide text-fg-secondary">
              Merge conflict
            </span>
          </div>
          <span className="text-hint text-fg-tertiary">
            {d.conflictFiles!.length} file{d.conflictFiles!.length === 1 ? '' : 's'}
          </span>
        </header>
        <ul
          className="flex flex-col gap-0.5 text-meta text-fg-primary"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {d.conflictFiles!.slice(0, CONFLICT_FILE_LIMIT).map((f) => (
            <li key={f} className="truncate" title={f}>
              {f}
            </li>
          ))}
          {d.conflictFiles!.length > CONFLICT_FILE_LIMIT ? (
            <li className="text-fg-secondary">
              +{d.conflictFiles!.length - CONFLICT_FILE_LIMIT} more conflicts
            </li>
          ) : null}
        </ul>
        <footer className="mt-auto flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => void discardRun()}>
            Discard all
          </Button>
        </footer>
        <Handle type="source" position={Position.Bottom} className="!border-0 !bg-transparent" />
      </NodeContainer>
    );
  }

  const isApplied = status === 'applied' || applySummary !== null;
  const isApplying = status === 'merging';
  const activated = d.state === 'done' || d.state === 'running';
  const dotColor = isApplied
    ? 'var(--color-status-success)'
    : activated
      ? 'var(--color-status-success)'
      : 'var(--color-fg-tertiary)';

  // Phase 7 polish: post-Apply success state replaces the action
  // footer with a "✓ Applied to <branch> · <sha>" line so the MERGE
  // node mirrors the ApplySummaryOverlay instead of leaving a
  // misleadingly-active "Apply to branch" button on screen.
  const headerLabel = isApplied ? 'Applied' : isApplying ? 'Applying…' : d.label;

  return (
    <NodeContainer
      variant="final"
      state={d.state}
      agentColor="var(--color-agent-master)"
      width={width}
      height={height}
    >
      <Handle type="target" position={Position.Top} className="!border-0 !bg-transparent" />
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusDot color={dotColor} />
          <span
            className="text-hint uppercase tracking-wide text-fg-secondary"
            data-testid="final-node-label"
          >
            {headerLabel}
          </span>
        </div>
        <span className="text-hint text-fg-tertiary">
          {d.files.length} file{d.files.length === 1 ? '' : 's'}
        </span>
      </header>
      <ul className="flex flex-col gap-0.5 text-meta text-fg-secondary">
        {d.files.slice(0, 3).map((f) => (
          <li key={f} className="truncate" title={f}>
            {f}
          </li>
        ))}
        {d.files.length > 3 ? (
          <li className="text-fg-tertiary">+{d.files.length - 3} more</li>
        ) : null}
      </ul>
      <footer className="mt-auto flex items-center justify-between gap-2">
        {isApplied && applySummary ? (
          <span
            className="flex min-w-0 items-center gap-1.5 text-meta text-fg-secondary"
            data-testid="final-node-applied"
          >
            <Check
              size={12}
              aria-hidden
              style={{ color: 'var(--color-status-success)' }}
            />
            <span className="truncate font-mono">
              {applySummary.branch} · {applySummary.commitSha.slice(0, 7)}
            </span>
          </span>
        ) : (
          <>
            <Button
              variant="ghost"
              disabled={!activated || isApplying}
              onClick={() => void discardRun()}
            >
              Discard all
            </Button>
            <Button
              variant="primary"
              disabled={!activated || isApplying}
              onClick={() => void applyRun()}
              data-testid="final-node-apply"
            >
              {isApplying ? 'Applying…' : 'Apply to branch'}
            </Button>
          </>
        )}
      </footer>
      <Handle type="source" position={Position.Bottom} className="!border-0 !bg-transparent" />
    </NodeContainer>
  );
}
