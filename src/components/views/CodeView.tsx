import { useEffect, useState, useCallback } from 'react';
import { C } from '@/lib/theme';
import { sanitizeShikiHtml } from '@/lib/sanitize';
import { useUIStore } from '@/stores/uiStore';
import { useFileExplorer, type TreeNode } from '@/hooks/useFileExplorer';
import { commands } from '@/bindings';
import type { FileContent } from '@/bindings';

/* ── Shiki lazy loader ────────────────────────────────── */

type Highlighter = {
  codeToHtml: (code: string, opts: { lang: string; theme: string }) => string;
  getLoadedLanguages: () => string[];
  loadLanguage: (...langs: string[]) => Promise<void>;
};

// Core languages loaded eagerly — others loaded on demand
const CORE_LANGS = ['typescript', 'javascript', 'rust', 'json', 'bash', 'markdown'] as const;
const EXTRA_LANGS = [
  'python', 'yaml', 'toml', 'html', 'css', 'sql', 'go',
  'java', 'c', 'cpp', 'ruby', 'swift', 'kotlin', 'vue',
  'svelte', 'graphql', 'dockerfile', 'scss',
] as const;

let shikiHighlighterPromise: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!shikiHighlighterPromise) {
    shikiHighlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({
        themes: ['github-dark-default'],
        langs: [...CORE_LANGS],
      })
    ) as Promise<Highlighter>;
  }
  return shikiHighlighterPromise;
}

/** Load a language on demand if not already loaded */
async function ensureLanguage(highlighter: Highlighter, lang: string): Promise<string> {
  const loaded = highlighter.getLoadedLanguages();
  if (loaded.includes(lang)) return lang;
  // Check if it's a known language we can load
  if ((EXTRA_LANGS as readonly string[]).includes(lang)) {
    try {
      await highlighter.loadLanguage(lang as never);
      return lang;
    } catch {
      return 'text';
    }
  }
  return 'text';
}

/* ── File icon helper ─────────────────────────────────── */

function fileIcon(isDir: boolean, ext: string): string {
  if (isDir) return '📁';
  const map: Record<string, string> = {
    rs: '🦀', ts: '🔷', tsx: '🔷', js: '🟨', jsx: '🟨',
    py: '🐍', json: '📋', md: '📝', toml: '⚙️', yaml: '⚙️', yml: '⚙️',
    html: '🌐', css: '🎨', scss: '🎨', svg: '🖼️', png: '🖼️', jpg: '🖼️',
  };
  return map[ext.toLowerCase()] ?? '📄';
}

/* ── Tree Item Component ──────────────────────────────── */

function TreeItem({
  node,
  depth,
  selectedFile,
  onToggleDir,
  onSelectFile,
}: {
  node: TreeNode;
  depth: number;
  selectedFile: string | null;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const isSelected = node.entry.path === selectedFile;

  return (
    <>
      <div
        className="flex items-center gap-1.5 py-1 px-2 cursor-pointer transition-colors text-xs"
        style={{
          paddingLeft: depth * 16 + 8,
          background: isSelected ? C.accentSoft : 'transparent',
          color: isSelected ? C.accentText : C.textPrimary,
        }}
        onClick={() => {
          if (node.entry.is_dir) onToggleDir(node.entry.path);
          else onSelectFile(node.entry.path);
        }}
        onMouseEnter={(e) => {
          if (!isSelected) (e.currentTarget.style.background = C.surfaceHover);
        }}
        onMouseLeave={(e) => {
          if (!isSelected) (e.currentTarget.style.background = 'transparent');
        }}
      >
        {node.entry.is_dir && (
          <span
            className="text-[9px] flex-shrink-0 transition-transform"
            style={{
              color: C.textMuted,
              transform: node.expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            }}
          >
            ▶
          </span>
        )}
        {!node.entry.is_dir && <span className="w-[9px] flex-shrink-0" />}
        <span className="flex-shrink-0 text-[12px]">{fileIcon(node.entry.is_dir, node.entry.extension)}</span>
        <span className="truncate font-mono">{node.entry.name}</span>
        {!node.entry.is_dir && node.entry.size > 0 && (
          <span className="ml-auto text-[10px] flex-shrink-0" style={{ color: C.textMuted }}>
            {node.entry.size > 1024
              ? `${(node.entry.size / 1024).toFixed(0)}KB`
              : `${node.entry.size}B`}
          </span>
        )}
      </div>
      {node.expanded && node.children?.map((child) => (
        <TreeItem
          key={child.entry.path}
          node={child}
          depth={depth + 1}
          selectedFile={selectedFile}
          onToggleDir={onToggleDir}
          onSelectFile={onSelectFile}
        />
      ))}
    </>
  );
}

/* ── Code Panel with Shiki ────────────────────────────── */

function CodePanel({
  fileContent,
  filePath,
  editing,
  projectDir,
  onFileSaved,
}: {
  fileContent: FileContent | null;
  filePath: string | null;
  editing: boolean;
  projectDir: string;
  onFileSaved: () => void;
}) {
  const [highlightedHtml, setHighlightedHtml] = useState<string>('');
  const [editBuffer, setEditBuffer] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  // Sync edit buffer when file content changes or editing toggled
  useEffect(() => {
    if (fileContent && fileContent.language !== 'binary') {
      setEditBuffer(fileContent.content);
      setHasChanges(false);
      setSaveMsg(null);
    }
  }, [fileContent]);

  useEffect(() => {
    if (!editing || !fileContent || fileContent.language === 'binary' || !fileContent.content) {
      setHighlightedHtml('');
      return;
    }

    let cancelled = false;

    getHighlighter().then(async (highlighter) => {
      if (cancelled) return;
      try {
        const lang = await ensureLanguage(highlighter, fileContent.language);
        const html = highlighter.codeToHtml(fileContent.content, {
          lang,
          theme: 'github-dark-default',
        });
        if (!cancelled) setHighlightedHtml(html);
      } catch { // expected: language may not be loaded in shiki
        if (!cancelled) setHighlightedHtml('');
      }
    });

    return () => { cancelled = true; };
  }, [fileContent, editing]);

  const handleSave = useCallback(async () => {
    if (!filePath || saving) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const result = await commands.writeFile(projectDir, filePath, editBuffer);
      if (result.status === 'ok') {
        setSaveMsg('Saved');
        setHasChanges(false);
        onFileSaved();
        setTimeout(() => setSaveMsg(null), 2000);
      } else {
        setSaveMsg(`Error: ${result.error}`);
      }
    } catch (e) {
      setSaveMsg(`Error: ${e}`);
    } finally {
      setSaving(false);
    }
  }, [filePath, editBuffer, projectDir, saving, onFileSaved]);

  if (!filePath) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: C.bg }}>
        <div className="text-center">
          <div className="text-2xl mb-2">◈</div>
          <div className="text-sm" style={{ color: C.textMuted }}>
            Select a file to view
          </div>
        </div>
      </div>
    );
  }

  if (!fileContent) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: C.bg }}>
        <span className="text-xs" style={{ color: C.textMuted }}>Loading...</span>
      </div>
    );
  }

  if (fileContent.language === 'binary') {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: C.bg }}>
        <span className="text-xs" style={{ color: C.textMuted }}>Binary file — cannot display</span>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: C.bg }}>
      {/* File header */}
      <div
        className="flex items-center gap-2 px-4 py-2 border-b flex-shrink-0"
        style={{ borderColor: C.border, background: C.panel }}
      >
        <span className="text-xs font-mono" style={{ color: C.textPrimary }}>
          {filePath}
        </span>
        {hasChanges && (
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: C.amber }} />
        )}
        <div className="flex-1" />
        {editing && hasChanges && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="text-[10px] px-2.5 py-1 rounded-md font-semibold transition-all"
            style={{
              background: C.accent,
              color: '#fff',
              opacity: saving ? 0.5 : 1,
            }}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        )}
        {saveMsg && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-medium"
            style={{
              color: saveMsg.startsWith('Error') ? C.red : C.green,
              background: saveMsg.startsWith('Error') ? C.redBg : C.greenBg,
            }}
          >
            {saveMsg}
          </span>
        )}
        {editing && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
            style={{ background: C.accentSoft, color: C.accentText }}
          >
            editing
          </span>
        )}
        <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: C.textMuted, background: C.surface }}>
          {fileContent.language}
        </span>
        <span className="text-[10px]" style={{ color: C.textMuted }}>
          {fileContent.size > 1024
            ? `${(fileContent.size / 1024).toFixed(1)}KB`
            : `${fileContent.size}B`}
        </span>
        {fileContent.truncated && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full"
            style={{ background: C.amberBg, color: C.amber }}
          >
            truncated
          </span>
        )}
      </div>

      {/* Code content */}
      <div className="flex-1 overflow-auto">
        {editing ? (
          <textarea
            value={editBuffer}
            onChange={(e) => {
              setEditBuffer(e.target.value);
              setHasChanges(e.target.value !== fileContent.content);
            }}
            onKeyDown={(e) => {
              // Cmd/Ctrl+S to save
              if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                e.preventDefault();
                handleSave();
              }
              // Tab inserts 2 spaces
              if (e.key === 'Tab') {
                e.preventDefault();
                const start = e.currentTarget.selectionStart;
                const end = e.currentTarget.selectionEnd;
                const val = editBuffer;
                const newVal = val.substring(0, start) + '  ' + val.substring(end);
                setEditBuffer(newVal);
                setHasChanges(newVal !== fileContent.content);
                requestAnimationFrame(() => {
                  e.currentTarget.selectionStart = e.currentTarget.selectionEnd = start + 2;
                });
              }
            }}
            className="w-full h-full text-[12px] leading-[20px] p-4 resize-none"
            style={{
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              background: 'transparent',
              color: C.textPrimary,
              outline: 'none',
              border: 'none',
              tabSize: 2,
            }}
            spellCheck={false}
          />
        ) : highlightedHtml ? (
          <div
            className="shiki-container text-[12px] leading-[20px] p-4"
            style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}
            dangerouslySetInnerHTML={{ __html: sanitizeShikiHtml(highlightedHtml) }}
          />
        ) : (
          <pre
            className="text-[12px] leading-[20px] p-4 font-mono whitespace-pre"
            style={{ color: C.textPrimary, margin: 0 }}
          >
            {fileContent.content}
          </pre>
        )}
      </div>
    </div>
  );
}

/* ── Main CodeView ────────────────────────────────────── */

export function CodeView() {
  const projectDir = useUIStore((s) => s.projectDir);
  const developerMode = useUIStore((s) => s.developerMode);
  const {
    rootEntries, selectedFile, fileContent, loading, error,
    loadRoot, toggleDir, selectFile,
  } = useFileExplorer(projectDir);

  const handleFileSaved = useCallback(() => {
    // Re-read the file after save to sync content
    if (selectedFile) selectFile(selectedFile);
  }, [selectedFile, selectFile]);

  useEffect(() => {
    loadRoot();
  }, [loadRoot]);

  if (!projectDir) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: C.bg }}>
        <div className="text-center">
          <div className="text-2xl mb-2">◈</div>
          <div className="text-sm font-medium" style={{ color: C.textSecondary }}>
            No project directory selected
          </div>
          <div className="text-xs mt-1" style={{ color: C.textMuted }}>
            Launch a session to browse code
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex overflow-hidden" style={{ background: C.bg }}>
      {/* File tree sidebar */}
      <div
        className="flex flex-col overflow-hidden border-r flex-shrink-0"
        style={{ width: 260, borderColor: C.border, background: C.panel }}
      >
        {/* Tree header */}
        <div
          className="flex items-center gap-2 px-3 py-2 border-b flex-shrink-0"
          style={{ borderColor: C.border }}
        >
          <span className="text-xs font-semibold truncate" style={{ color: C.textPrimary }}>
            {projectDir.split('/').pop()}
          </span>
          <div className="flex-1" />
          <button
            onClick={loadRoot}
            disabled={loading}
            className="text-[10px] px-1.5 py-0.5 rounded transition-colors"
            style={{ color: C.textMuted }}
          >
            {loading ? '⟳' : '↻'}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="px-3 py-1 text-[10px]" style={{ color: C.red }}>
            {error}
          </div>
        )}

        {/* Tree */}
        <div className="flex-1 overflow-y-auto py-1">
          {rootEntries.map((node) => (
            <TreeItem
              key={node.entry.path}
              node={node}
              depth={0}
              selectedFile={selectedFile}
              onToggleDir={toggleDir}
              onSelectFile={selectFile}
            />
          ))}
          {rootEntries.length === 0 && !loading && (
            <div className="px-3 py-4 text-xs text-center" style={{ color: C.textMuted }}>
              Empty directory
            </div>
          )}
        </div>
      </div>

      {/* Code panel */}
      <CodePanel
        fileContent={fileContent}
        filePath={selectedFile}
        editing={developerMode}
        projectDir={projectDir}
        onFileSaved={handleFileSaved}
      />
    </div>
  );
}
