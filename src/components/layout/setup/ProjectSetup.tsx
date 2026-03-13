import { open } from '@tauri-apps/plugin-dialog';
import { C } from '@/lib/theme';

/* ── Types ─────────────────────────────────────────────── */

interface ProjectSetupProps {
  sessionName: string;
  setSessionName: (v: string) => void;
  projectDir: string;
  setProjectDir: (v: string) => void;
  developerMode: boolean;
  setDeveloperMode: (v: boolean) => void;
  autoMerge: boolean;
  setAutoMerge: (v: boolean) => void;
  codeReview: boolean;
  setCodeReview: (v: boolean) => void;
}

/* ── Helpers ───────────────────────────────────────────── */

function renderToggle(label: string, value: boolean, onChange: (v: boolean) => void, description?: string) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 0',
        borderBottom: `1px solid ${C.border}`,
      }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: C.textPrimary }}>{label}</div>
        {description && (
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{description}</div>
        )}
      </div>
      <button
        onClick={() => onChange(!value)}
        style={{
          width: 40,
          height: 22,
          borderRadius: 11,
          background: value ? C.accent : C.surface,
          border: `1px solid ${value ? C.accent : C.borderStrong}`,
          position: 'relative',
          cursor: 'pointer',
          transition: 'background 0.2s, border-color 0.2s',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: '#fff',
            position: 'absolute',
            top: 2,
            left: value ? 20 : 2,
            transition: 'left 0.2s',
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
          }}
        />
      </button>
    </div>
  );
}

/* ── Component ─────────────────────────────────────────── */

export function ProjectSetup({
  sessionName,
  setSessionName,
  projectDir,
  setProjectDir,
  developerMode,
  setDeveloperMode,
  autoMerge,
  setAutoMerge,
  codeReview,
  setCodeReview,
}: ProjectSetupProps) {
  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Session Name
        </label>
        <input
          type="text"
          value={sessionName}
          onChange={(e) => setSessionName(e.target.value)}
          placeholder="e.g. refactor-auth-module"
          autoFocus
          style={{
            display: 'block',
            width: '100%',
            marginTop: 8,
            padding: '10px 14px',
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 10,
            color: C.textPrimary,
            fontSize: 14,
            outline: 'none',
            transition: 'border-color 0.2s',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = C.border; }}
        />
      </div>

      <div style={{ marginBottom: 20 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Project Directory
        </label>
        <button
          type="button"
          onClick={async () => {
            const selected = await open({ directory: true, multiple: false, title: 'Select Project Directory' });
            if (selected) setProjectDir(selected as string);
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            width: '100%',
            marginTop: 8,
            padding: projectDir ? '10px 14px' : '20px 14px',
            background: C.surface,
            border: `1.5px dashed ${projectDir ? C.accent : C.borderStrong}`,
            borderRadius: 12,
            cursor: 'pointer',
            textAlign: 'left',
            transition: 'all 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = C.accent;
            e.currentTarget.style.background = C.surfaceHover;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = projectDir ? C.accent : C.borderStrong;
            e.currentTarget.style.background = C.surface;
          }}
        >
          {projectDir ? (
            <>
              <div style={{
                width: 32, height: 32, borderRadius: 8,
                background: C.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M2 4.5C2 3.67 2.67 3 3.5 3H6.29a1 1 0 0 1 .7.29L8 4.3h4.5c.83 0 1.5.67 1.5 1.5V12c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5Z" fill={C.accent} opacity="0.9"/>
                </svg>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {projectDir.split('/').pop()}
                </div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                  {projectDir}
                </div>
              </div>
              <div style={{ fontSize: 11, color: C.accentText, fontWeight: 500, flexShrink: 0 }}>Change</div>
            </>
          ) : (
            <div style={{ width: '100%', textAlign: 'center' }}>
              <div style={{ marginBottom: 4 }}>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" style={{ display: 'inline-block' }}>
                  <path d="M3 6C3 4.9 3.9 4 5 4H8.17a1 1 0 0 1 .71.29L10 5.41h5c1.1 0 2 .9 2 2V15c0 1.1-.9 2-2 2H5a2 2 0 0 1-2-2V6Z" stroke={C.textMuted} strokeWidth="1.5" fill="none"/>
                </svg>
              </div>
              <div style={{ fontSize: 13, fontWeight: 500, color: C.textSecondary }}>
                Click to select project folder
              </div>
            </div>
          )}
        </button>
      </div>

      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
          Settings
        </div>
        {renderToggle('Developer Mode', developerMode, setDeveloperMode, 'Show raw output and debug info')}
        {renderToggle('Auto Merge', autoMerge, setAutoMerge, 'Merge worktree branches automatically')}
        {renderToggle('Code Review Gate', codeReview, setCodeReview, 'Require review before merging')}
      </div>
    </div>
  );
}
