import { useState, useEffect, useCallback } from 'react';
import { X } from 'lucide-react';
import { commands } from '../../bindings';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { useUIStore } from '../../stores/uiStore';

type TabId = 'claude' | 'gemini' | 'codex';

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
  codex: {
    label: 'Codex',
    placeholder: 'sk-...',
    hasKey: () => commands.hasCodexApiKey(),
    setKey: (key: string) => commands.setCodexApiKey(key),
    deleteKey: () => commands.deleteCodexApiKey(),
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

  const [codexKeyInput, setCodexKeyInput] = useState('');
  const [codexHasKey, setCodexHasKey] = useState<boolean | null>(null);
  const [codexSaving, setCodexSaving] = useState(false);
  const [codexMessage, setCodexMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

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

  const checkCodexKey = useCallback(async () => {
    try {
      const result = await commands.hasCodexApiKey();
      if (result.status === 'ok') {
        setCodexHasKey(result.data);
      } else {
        setCodexHasKey(false);
      }
    } catch {
      setCodexHasKey(false);
    }
  }, []);

  useEffect(() => {
    checkClaudeKey();
    checkGeminiKey();
    checkCodexKey();
  }, [checkClaudeKey, checkGeminiKey, checkCodexKey]);

  const handleSave = async (tab: TabId) => {
    const config = TAB_CONFIGS[tab];
    const keyInput = tab === 'claude' ? claudeKeyInput : tab === 'gemini' ? geminiKeyInput : codexKeyInput;
    const setSaving = tab === 'claude' ? setClaudeSaving : tab === 'gemini' ? setGeminiSaving : setCodexSaving;
    const setMessage = tab === 'claude' ? setClaudeMessage : tab === 'gemini' ? setGeminiMessage : setCodexMessage;
    const setKeyInput = tab === 'claude' ? setClaudeKeyInput : tab === 'gemini' ? setGeminiKeyInput : setCodexKeyInput;
    const setHasKey = tab === 'claude' ? setClaudeHasKey : tab === 'gemini' ? setGeminiHasKey : setCodexHasKey;

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
    const setSaving = tab === 'claude' ? setClaudeSaving : tab === 'gemini' ? setGeminiSaving : setCodexSaving;
    const setMessage = tab === 'claude' ? setClaudeMessage : tab === 'gemini' ? setGeminiMessage : setCodexMessage;
    const setHasKey = tab === 'claude' ? setClaudeHasKey : tab === 'gemini' ? setGeminiHasKey : setCodexHasKey;

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
  const keyInput = activeTab === 'claude' ? claudeKeyInput : activeTab === 'gemini' ? geminiKeyInput : codexKeyInput;
  const setKeyInput = activeTab === 'claude' ? setClaudeKeyInput : activeTab === 'gemini' ? setGeminiKeyInput : setCodexKeyInput;
  const hasKey = activeTab === 'claude' ? claudeHasKey : activeTab === 'gemini' ? geminiHasKey : codexHasKey;
  const saving = activeTab === 'claude' ? claudeSaving : activeTab === 'gemini' ? geminiSaving : codexSaving;
  const message = activeTab === 'claude' ? claudeMessage : activeTab === 'gemini' ? geminiMessage : codexMessage;
  const config = TAB_CONFIGS[activeTab];

  return (
    <div className="p-6 max-w-md">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-zinc-100">API Keys</h2>
        {onClose && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            aria-label="Close settings"
            className="text-zinc-500 hover:text-zinc-300"
          >
            <X className="size-4" />
          </Button>
        )}
      </div>

      {/* Tab toggle */}
      <div className="flex gap-1 mb-4 p-1 bg-zinc-800 rounded-lg">
        {(Object.keys(TAB_CONFIGS) as TabId[]).map((tab) => (
          <Button
            key={tab}
            variant={activeTab === tab ? 'secondary' : 'ghost'}
            size="sm"
            className={`flex-1 ${
              activeTab === tab
                ? 'bg-zinc-700 text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {TAB_CONFIGS[tab].label}
          </Button>
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
        <Input
          type="password"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder={config.placeholder}
          disabled={saving}
        />

        <div className="flex gap-2">
          <Button
            onClick={() => handleSave(activeTab)}
            disabled={saving || !keyInput.trim()}
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>

          {hasKey && (
            <Button
              variant="destructive"
              onClick={() => handleDelete(activeTab)}
              disabled={saving}
            >
              Delete Key
            </Button>
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

      {/* Preferences */}
      <div className="mt-6 pt-4 border-t border-white/5">
        <h3 className="text-sm font-medium text-zinc-300 mb-3">Preferences</h3>
        <div className="space-y-3">
          <ToggleSetting
            label="Auto Merge"
            description="Automatically merge PRs after master agent code review"
            storeKey="autoMerge"
          />
          <ToggleSetting
            label="Code Review"
            description="Keep review step enabled before final merge"
            storeKey="codeReview"
          />
          <ToggleSetting
            label="Developer Mode"
            description="Enable direct terminal access to running agents"
            storeKey="developerMode"
          />
        </div>
      </div>
    </div>
  );
}

function ToggleSetting({ label, description, storeKey }: {
  label: string;
  description: string;
  storeKey: 'autoMerge' | 'codeReview' | 'developerMode';
}) {
  const value = useUIStore((s) => s[storeKey]);
  const setter = useUIStore((s) => {
    switch (storeKey) {
      case 'autoMerge':
        return s.setAutoMerge;
      case 'codeReview':
        return s.setCodeReview;
      default:
        return s.setDeveloperMode;
    }
  });

  return (
    <label className="flex items-center justify-between cursor-pointer group">
      <div>
        <p className="text-xs font-medium text-zinc-300 group-hover:text-zinc-100 transition-colors">{label}</p>
        <p className="text-[10px] text-zinc-600">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={value}
        onClick={() => setter(!value)}
        className={`relative inline-flex h-5 w-8.5 items-center rounded-full border transition-colors ${
          value ? 'border-violet-400/40 bg-violet-500/25' : 'border-white/10 bg-white/[0.05]'
        }`}
      >
        <span
          className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
            value ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </label>
  );
}
