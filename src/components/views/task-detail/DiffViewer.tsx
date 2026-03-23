import { useMemo, useState } from 'react';
import { C } from '@/lib/theme';
import type { FileDiff } from '@/bindings';

/* ── Inline Diff Viewer ───────────────────────────────── */

export function InlineDiffView({ files, onClose }: { files: FileDiff[]; onClose: () => void }) {
  const [selectedFile, setSelectedFile] = useState<string | null>(files[0]?.path ?? null);
  const selectedDiff = useMemo(() => files.find((f) => f.path === selectedFile), [files, selectedFile]);

  return (
    <div
      style={{
        borderRadius: 14,
        background: C.surface,
        border: `1px solid ${C.border}`,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: `1px solid ${C.border}`,
          background: C.panel,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 700, color: C.textPrimary }}>
          Changes ({files.length} file{files.length !== 1 ? 's' : ''})
        </span>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            color: C.textMuted,
            cursor: 'pointer',
            fontSize: 14,
            fontFamily: 'Inter, sans-serif',
            padding: '0 4px',
          }}
        >
          &#10005;
        </button>
      </div>

      {/* File list */}
      <div style={{ maxHeight: 120, overflowY: 'auto', borderBottom: `1px solid ${C.border}` }}>
        {files.map((file) => {
          const isSelected = file.path === selectedFile;
          const statusColor = file.status === 'added' ? C.green : file.status === 'deleted' ? '#f87171' : C.accentText;
          const statusLetter = file.status === 'added' ? '+' : file.status === 'deleted' ? 'D' : file.status === 'renamed' ? 'R' : 'M';
          return (
            <button
              key={file.path}
              type="button"
              onClick={() => setSelectedFile(file.path)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 12px',
                background: isSelected ? C.surfaceHover : 'transparent',
                border: 'none',
                borderBottom: `1px solid ${C.border}`,
                color: C.textPrimary,
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{ color: statusColor, fontWeight: 700, width: 12, flexShrink: 0 }}>{statusLetter}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.path}</span>
              <span style={{ color: '#4ade80', fontSize: 10, flexShrink: 0 }}>+{file.additions}</span>
              <span style={{ color: '#f87171', fontSize: 10, flexShrink: 0 }}>-{file.deletions}</span>
            </button>
          );
        })}
      </div>

      {/* Diff content */}
      <div
        style={{
          maxHeight: 300,
          overflowY: 'auto',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          lineHeight: '18px',
        }}
      >
        {selectedDiff?.patch ? (
          selectedDiff.patch.split('\n').map((line, i) => {
            let bg = 'transparent';
            let color: string = C.textSecondary;
            if (line.startsWith('@@')) {
              color = '#22d3ee';
            } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
              color = C.textMuted;
            } else if (line.startsWith('+')) {
              color = '#4ade80';
              bg = 'rgba(34,197,94,0.08)';
            } else if (line.startsWith('-')) {
              color = '#f87171';
              bg = 'rgba(248,113,113,0.08)';
            }
            return (
              <div key={i} style={{ padding: '0 12px', whiteSpace: 'pre', background: bg, color }}>{line}</div>
            );
          })
        ) : (
          <div style={{ padding: 16, textAlign: 'center', color: C.textMuted }}>
            {selectedFile ? 'No diff available' : 'Select a file to view'}
          </div>
        )}
      </div>
    </div>
  );
}
