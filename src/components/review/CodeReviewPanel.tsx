import { useState, useCallback } from 'react';
import { Check, MessageSquare, ThumbsUp, ThumbsDown, Send, FileCode } from 'lucide-react';
import { Button } from '../ui/button';
import type { ToolName } from '../../stores/taskStore';

export interface ReviewItem {
  worktreeBranch: string;
  agent: ToolName;
  taskDescription: string;
  status: 'approved' | 'needs_changes' | 'pending';
  reviewComment: string;
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface CodeReviewResult {
  planId: string;
  overallSummary: string;
  items: ReviewItem[];
  masterAgent: ToolName;
}

const AGENT_COLORS: Record<ToolName, { text: string; bg: string; border: string }> = {
  claude: { text: 'text-violet-400', bg: 'bg-violet-500/10', border: 'border-violet-500/30' },
  gemini: { text: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/30' },
  codex: { text: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30' },
};

interface CodeReviewPanelProps {
  review: CodeReviewResult;
  onAcceptAll: () => void;
  onSendFeedback: (feedback: string) => void;
  onAcceptItem: (branch: string) => void;
  onRejectItem: (branch: string) => void;
  onProceedToMerge: (approvedBranches: string[]) => void;
}

export function CodeReviewPanel({
  review,
  onAcceptAll,
  onSendFeedback,
  onAcceptItem,
  onRejectItem,
  onProceedToMerge,
}: CodeReviewPanelProps) {
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const [itemOverrides, setItemOverrides] = useState<Record<string, 'approved' | 'rejected'>>({});

  const getEffectiveStatus = useCallback(
    (item: ReviewItem) => {
      return itemOverrides[item.worktreeBranch] ?? item.status;
    },
    [itemOverrides],
  );

  const approvedBranches = review.items.filter(
    (item) => getEffectiveStatus(item) === 'approved',
  ).map((item) => item.worktreeBranch);

  const handleSendFeedback = useCallback(() => {
    if (feedback.trim()) {
      onSendFeedback(feedback.trim());
      setFeedback('');
      setShowFeedback(false);
    }
  }, [feedback, onSendFeedback]);

  return (
    <div className="flex flex-col h-full bg-black/20">
      {/* Header */}
      <div className="shrink-0 px-6 py-4 border-b border-white/5 bg-black/30">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileCode className="w-4 h-4 text-zinc-400" />
            <h2 className="text-sm font-semibold text-zinc-200">Code Review</h2>
          </div>
          <span className="text-xs text-zinc-500">
            Reviewed by: <span className={AGENT_COLORS[review.masterAgent].text}>
              {review.masterAgent.charAt(0).toUpperCase() + review.masterAgent.slice(1)}
            </span>
          </span>
        </div>
        {review.overallSummary && (
          <p className="mt-2 text-xs text-zinc-400 leading-relaxed">
            {review.overallSummary}
          </p>
        )}
      </div>

      {/* Review items */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {review.items.map((item) => {
          const colors = AGENT_COLORS[item.agent];
          const effectiveStatus = getEffectiveStatus(item);

          return (
            <div
              key={item.worktreeBranch}
              className={`p-4 rounded-xl border ${colors.border} ${colors.bg}`}
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-xs font-medium ${colors.text}`}>
                      {item.agent.charAt(0).toUpperCase() + item.agent.slice(1)}
                    </span>
                    <span className="text-[10px] text-zinc-600 font-mono">
                      {item.worktreeBranch}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-300">{item.taskDescription}</p>
                </div>

                <div className="flex items-center gap-1.5 ml-3 shrink-0">
                  <button
                    onClick={() => {
                      setItemOverrides((prev) => ({ ...prev, [item.worktreeBranch]: 'approved' }));
                      onAcceptItem(item.worktreeBranch);
                    }}
                    className={`p-1 rounded transition-colors ${
                      effectiveStatus === 'approved'
                        ? 'bg-green-500/20 text-green-400'
                        : 'text-zinc-600 hover:text-green-400 hover:bg-green-500/10'
                    }`}
                    title="Approve"
                  >
                    <ThumbsUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => {
                      setItemOverrides((prev) => ({ ...prev, [item.worktreeBranch]: 'rejected' }));
                      onRejectItem(item.worktreeBranch);
                    }}
                    className={`p-1 rounded transition-colors ${
                      effectiveStatus === 'rejected'
                        ? 'bg-red-500/20 text-red-400'
                        : 'text-zinc-600 hover:text-red-400 hover:bg-red-500/10'
                    }`}
                    title="Reject"
                  >
                    <ThumbsDown className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Review comment */}
              {item.reviewComment && (
                <div className="mt-2 p-2 rounded-lg bg-black/30 border border-white/5">
                  <p className="text-[10px] text-zinc-400 leading-relaxed">
                    {item.reviewComment}
                  </p>
                </div>
              )}

              {/* Stats */}
              <div className="flex items-center gap-3 mt-2 text-[10px] text-zinc-600">
                <span>{item.filesChanged} files</span>
                <span className="text-green-500">+{item.additions}</span>
                <span className="text-red-500">-{item.deletions}</span>
                <span className={`ml-auto px-1.5 py-0.5 rounded-full ${
                  effectiveStatus === 'approved'
                    ? 'bg-green-500/20 text-green-400'
                    : effectiveStatus === 'rejected' || effectiveStatus === 'needs_changes'
                      ? 'bg-red-500/20 text-red-400'
                      : 'bg-zinc-800 text-zinc-500'
                }`}>
                  {effectiveStatus === 'approved' ? 'Approved' :
                   effectiveStatus === 'rejected' ? 'Rejected' :
                   effectiveStatus === 'needs_changes' ? 'Needs Changes' : 'Pending'}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Feedback input */}
      {showFeedback && (
        <div className="shrink-0 px-6 py-3 border-t border-white/5 bg-black/30">
          <div className="flex gap-2">
            <input
              type="text"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Send feedback to master agent..."
              className="flex-1 text-xs bg-black/40 border border-white/10 text-zinc-200 rounded-lg px-3 py-2 focus:outline-none focus:border-violet-500/50"
              onKeyDown={(e) => { if (e.key === 'Enter') handleSendFeedback(); }}
              autoFocus
            />
            <Button
              size="sm"
              onClick={handleSendFeedback}
              disabled={!feedback.trim()}
              className="bg-violet-600 text-white hover:bg-violet-500 h-8"
            >
              <Send className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Action bar */}
      <div className="shrink-0 flex items-center justify-between px-6 py-3 border-t border-white/5 bg-black/30">
        <div className="text-xs text-zinc-500">
          {approvedBranches.length}/{review.items.length} approved
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowFeedback(!showFeedback)}
            className="border-white/10 text-zinc-400 hover:bg-white/5 text-xs h-8"
          >
            <MessageSquare className="w-3.5 h-3.5 mr-1.5" />
            Feedback
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onAcceptAll}
            className="border-green-500/30 text-green-400 hover:bg-green-500/10 text-xs h-8"
          >
            <Check className="w-3.5 h-3.5 mr-1.5" />
            Accept All
          </Button>
          <Button
            size="sm"
            onClick={() => onProceedToMerge(approvedBranches)}
            disabled={approvedBranches.length === 0}
            className="bg-violet-600 text-white hover:bg-violet-500 shadow-lg shadow-violet-500/20 text-xs h-8"
          >
            Proceed to Merge ({approvedBranches.length})
          </Button>
        </div>
      </div>
    </div>
  );
}
