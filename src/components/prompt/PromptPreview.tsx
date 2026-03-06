import { useEffect, useState } from 'react';
import { commands, type OptimizedPrompt } from '../../bindings';

interface PromptPreviewProps {
  prompt: string;
  projectDir: string;
  visible: boolean;
  onClose: () => void;
}

export function PromptPreview({ prompt, projectDir, visible, onClose }: PromptPreviewProps) {
  const [previews, setPreviews] = useState<OptimizedPrompt[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;

    if (!prompt.trim()) {
      setPreviews([]);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    commands.optimizePrompt(prompt, projectDir).then((result) => {
      if (cancelled) return;
      setLoading(false);

      if (result.status === 'ok') {
        setPreviews(result.data);
      } else {
        setError(result.error);
      }
    }).catch(() => {
      if (cancelled) return;
      setLoading(false);
      setError('Failed to optimize prompt');
    });

    return () => { cancelled = true; };
  }, [visible, prompt, projectDir]);

  if (!visible) return null;

  return (
    <div className="border-t border-zinc-800 bg-zinc-900/80 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-zinc-400">Prompt Preview</span>
        <button
          onClick={onClose}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Close
        </button>
      </div>

      {loading && (
        <div className="text-xs text-zinc-500 py-2">Optimizing...</div>
      )}

      {error && (
        <div className="text-xs text-red-400 py-2">{error}</div>
      )}

      {!loading && !error && previews.length === 0 && (
        <div className="text-xs text-zinc-600 py-2">Enter a prompt to preview</div>
      )}

      {!loading && !error && previews.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {previews.map((preview) => (
            <div key={preview.tool_name} className="bg-zinc-800 rounded p-2">
              <div className="text-xs font-semibold text-zinc-300 mb-1 capitalize">
                {preview.tool_name === 'claude' ? 'Claude' : preview.tool_name === 'gemini' ? 'Gemini' : preview.tool_name}
              </div>
              <pre className="text-xs font-mono text-zinc-400 whitespace-pre-wrap max-h-48 overflow-y-auto">
                {preview.optimized_prompt}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
