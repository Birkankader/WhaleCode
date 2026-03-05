import { useState, useEffect, useCallback } from 'react';
import { commands } from '../../bindings';

/**
 * API key settings component for Claude Code integration.
 *
 * Provides:
 * - Password input for the API key (masked)
 * - Save button that stores key via setClaudeApiKey IPC
 * - Status indicator: "Key stored" (green) or "No key" (red)
 * - Delete button to clear the stored key
 */
export function ApiKeySettings({ onClose }: { onClose?: () => void }) {
  const [keyInput, setKeyInput] = useState('');
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const checkKey = useCallback(async () => {
    try {
      const result = await commands.hasClaudeApiKey();
      if (result.status === 'ok') {
        setHasKey(result.data);
      } else {
        setHasKey(false);
      }
    } catch {
      setHasKey(false);
    }
  }, []);

  useEffect(() => {
    checkKey();
  }, [checkKey]);

  const handleSave = async () => {
    if (!keyInput.trim()) return;

    setSaving(true);
    setMessage(null);

    try {
      const result = await commands.setClaudeApiKey(keyInput.trim());
      if (result.status === 'ok') {
        setMessage({ type: 'success', text: 'API key saved to Keychain' });
        setKeyInput('');
        setHasKey(true);
      } else {
        setMessage({ type: 'error', text: result.error });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to save API key' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setSaving(true);
    setMessage(null);

    try {
      const result = await commands.deleteClaudeApiKey();
      if (result.status === 'ok') {
        setHasKey(false);
        setMessage({ type: 'success', text: 'API key removed from Keychain' });
      } else {
        setMessage({ type: 'error', text: 'Failed to delete: ' + result.error });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to delete API key' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 max-w-md">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-zinc-100">Claude API Key</h2>
        {onClose && (
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 transition-colors"
            aria-label="Close settings"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {/* Status indicator */}
      <div className="flex items-center gap-2 mb-4">
        <span
          className={`w-2.5 h-2.5 rounded-full ${
            hasKey === true ? 'bg-green-500' : hasKey === false ? 'bg-red-500' : 'bg-zinc-600'
          }`}
        />
        <span className="text-sm text-zinc-400">
          {hasKey === true ? 'Key stored in Keychain' : hasKey === false ? 'No key configured' : 'Checking...'}
        </span>
      </div>

      {/* Input form */}
      <div className="space-y-3">
        <input
          type="password"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder="sk-ant-..."
          className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
          disabled={saving}
        />

        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={saving || !keyInput.trim()}
            className="px-4 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>

          {hasKey && (
            <button
              onClick={handleDelete}
              disabled={saving}
              className="px-4 py-1.5 text-sm rounded bg-red-600/20 text-red-400 hover:bg-red-600/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Delete Key
            </button>
          )}
        </div>
      </div>

      {/* Message */}
      {message && (
        <div
          className={`mt-3 px-3 py-2 rounded text-sm ${
            message.type === 'success'
              ? 'bg-green-900/30 text-green-400 border border-green-800/50'
              : 'bg-red-900/30 text-red-400 border border-red-800/50'
          }`}
        >
          {message.text}
        </div>
      )}

      <p className="mt-4 text-xs text-zinc-600">
        Your API key is stored securely in the macOS Keychain and is never logged or displayed.
      </p>
    </div>
  );
}
