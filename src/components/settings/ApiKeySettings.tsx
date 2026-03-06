import { useState, useEffect, useCallback } from 'react';
import { commands } from '../../bindings';

type TabId = 'claude' | 'gemini';

interface TabConfig {
  label: string;
  placeholder: string;
  hasKey: () => Promise<{ status: 'ok'; data: boolean } | { status: 'error'; error: string }>;
  setKey: (key: string) => Promise<{ status: 'ok'; data: null } | { status: 'error'; error: string }>;
  deleteKey: () => Promise<{ status: 'ok'; data: null } | { status: 'error'; error: string }>;
}

const TAB_CONFIGS: Record<TabId, TabConfig> = {
  claude: {
    label: 'Claude',
    placeholder: 'sk-ant-...',
    hasKey: () => commands.hasClaudeApiKey(),
    setKey: (key: string) => commands.setClaudeApiKey(key),
    deleteKey: () => commands.deleteClaudeApiKey(),
  },
  gemini: {
    label: 'Gemini',
    placeholder: 'AI...',
    hasKey: () => commands.hasGeminiApiKey(),
    setKey: (key: string) => commands.setGeminiApiKey(key),
    deleteKey: () => commands.deleteGeminiApiKey(),
  },
};

/**
 * API key settings component for Claude Code and Gemini CLI integration.
 *
 * Provides tabbed interface to manage both API keys independently:
 * - Password input for each key (masked)
 * - Save button that stores key via respective IPC command
 * - Status indicator: "Key stored" (green) or "No key" (red)
 * - Delete button to clear the stored key
 */
export function ApiKeySettings({ onClose }: { onClose?: () => void }) {
  const [activeTab, setActiveTab] = useState<TabId>('claude');

  // Per-tab state
  const [claudeKeyInput, setClaudeKeyInput] = useState('');
  const [claudeHasKey, setClaudeHasKey] = useState<boolean | null>(null);
  const [claudeSaving, setClaudeSaving] = useState(false);
  const [claudeMessage, setClaudeMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [geminiKeyInput, setGeminiKeyInput] = useState('');
  const [geminiHasKey, setGeminiHasKey] = useState<boolean | null>(null);
  const [geminiSaving, setGeminiSaving] = useState(false);
  const [geminiMessage, setGeminiMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const checkClaudeKey = useCallback(async () => {
    try {
      const result = await commands.hasClaudeApiKey();
      if (result.status === 'ok') {
        setClaudeHasKey(result.data);
      } else {
        setClaudeHasKey(false);
      }
    } catch {
      setClaudeHasKey(false);
    }
  }, []);

  const checkGeminiKey = useCallback(async () => {
    try {
      const result = await commands.hasGeminiApiKey();
      if (result.status === 'ok') {
        setGeminiHasKey(result.data);
      } else {
        setGeminiHasKey(false);
      }
    } catch {
      setGeminiHasKey(false);
    }
  }, []);

  useEffect(() => {
    checkClaudeKey();
    checkGeminiKey();
  }, [checkClaudeKey, checkGeminiKey]);

  const handleSave = async (tab: TabId) => {
    const config = TAB_CONFIGS[tab];
    const keyInput = tab === 'claude' ? claudeKeyInput : geminiKeyInput;
    const setSaving = tab === 'claude' ? setClaudeSaving : setGeminiSaving;
    const setMessage = tab === 'claude' ? setClaudeMessage : setGeminiMessage;
    const setKeyInput = tab === 'claude' ? setClaudeKeyInput : setGeminiKeyInput;
    const setHasKey = tab === 'claude' ? setClaudeHasKey : setGeminiHasKey;

    if (!keyInput.trim()) return;

    setSaving(true);
    setMessage(null);

    try {
      const result = await config.setKey(keyInput.trim());
      if (result.status === 'ok') {
        setMessage({ type: 'success', text: `${config.label} API key saved to Keychain` });
        setKeyInput('');
        setHasKey(true);
      } else {
        setMessage({ type: 'error', text: result.error });
      }
    } catch {
      setMessage({ type: 'error', text: `Failed to save ${config.label} API key` });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (tab: TabId) => {
    const config = TAB_CONFIGS[tab];
    const setSaving = tab === 'claude' ? setClaudeSaving : setGeminiSaving;
    const setMessage = tab === 'claude' ? setClaudeMessage : setGeminiMessage;
    const setHasKey = tab === 'claude' ? setClaudeHasKey : setGeminiHasKey;

    setSaving(true);
    setMessage(null);

    try {
      const result = await config.deleteKey();
      if (result.status === 'ok') {
        setHasKey(false);
        setMessage({ type: 'success', text: `${config.label} API key removed from Keychain` });
      } else {
        setMessage({ type: 'error', text: 'Failed to delete: ' + result.error });
      }
    } catch {
      setMessage({ type: 'error', text: `Failed to delete ${config.label} API key` });
    } finally {
      setSaving(false);
    }
  };

  // Active tab state
  const keyInput = activeTab === 'claude' ? claudeKeyInput : geminiKeyInput;
  const setKeyInput = activeTab === 'claude' ? setClaudeKeyInput : setGeminiKeyInput;
  const hasKey = activeTab === 'claude' ? claudeHasKey : geminiHasKey;
  const saving = activeTab === 'claude' ? claudeSaving : geminiSaving;
  const message = activeTab === 'claude' ? claudeMessage : geminiMessage;
  const config = TAB_CONFIGS[activeTab];

  return (
    <div className="p-6 max-w-md">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-zinc-100">API Keys</h2>
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

      {/* Tab toggle */}
      <div className="flex gap-1 mb-4 p-1 bg-zinc-800 rounded-lg">
        {(Object.keys(TAB_CONFIGS) as TabId[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 px-3 py-1.5 text-sm rounded-md transition-colors ${
              activeTab === tab
                ? 'bg-zinc-700 text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {TAB_CONFIGS[tab].label}
          </button>
        ))}
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
          placeholder={config.placeholder}
          className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
          disabled={saving}
        />

        <div className="flex gap-2">
          <button
            onClick={() => handleSave(activeTab)}
            disabled={saving || !keyInput.trim()}
            className="px-4 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>

          {hasKey && (
            <button
              onClick={() => handleDelete(activeTab)}
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
        Your API keys are stored securely in the macOS Keychain and are never logged or displayed.
      </p>
    </div>
  );
}
