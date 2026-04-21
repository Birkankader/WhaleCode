import { describe, expect, it } from 'vitest';

import {
  agentDetectionResultSchema,
  agentKindSchema,
  agentStatusSchema,
  diffReadySchema,
  editorMethodSchema,
  editorResultSchema,
  isMasterCapable,
  MASTER_CAPABLE_AGENTS,
  migrationNoticeSchema,
  repoInfoSchema,
  repoValidationSchema,
  runStatusSchema,
  settingsSchema,
  skipResultSchema,
  statusChangedSchema,
  subtaskDataSchema,
  subtaskDraftSchema,
  subtaskPatchSchema,
  subtaskStateChangedSchema,
  subtaskStateSchema,
  subtasksProposedSchema,
} from './ipc';

describe('agentKindSchema', () => {
  it('accepts the three kebab-case variants', () => {
    expect(agentKindSchema.parse('claude')).toBe('claude');
    expect(agentKindSchema.parse('codex')).toBe('codex');
    expect(agentKindSchema.parse('gemini')).toBe('gemini');
  });

  it('rejects unknown variants', () => {
    expect(agentKindSchema.safeParse('gpt4').success).toBe(false);
  });
});

describe('master capability helpers', () => {
  // Phase 4 Step 1: Gemini is worker-only. The const list and the
  // helper are the frontend's mirror of `AgentKind::supports_master`;
  // both sides must agree, so these tests pin the surface.
  it('lists Claude and Codex as master-capable', () => {
    expect(MASTER_CAPABLE_AGENTS).toEqual(['claude', 'codex']);
  });

  it('isMasterCapable returns true for masters and false for Gemini', () => {
    expect(isMasterCapable('claude')).toBe(true);
    expect(isMasterCapable('codex')).toBe(true);
    expect(isMasterCapable('gemini')).toBe(false);
  });
});

describe('migrationNoticeSchema', () => {
  it('parses the gemini-demotion notice shape', () => {
    const parsed = migrationNoticeSchema.parse({
      kind: 'gemini-master-demoted',
      message: 'Gemini is now worker-only — master agent switched to Claude Code.',
    });
    expect(parsed.kind).toBe('gemini-master-demoted');
    expect(parsed.message).toMatch(/worker-only/);
  });

  it('rejects unknown migration kinds so future additions surface loudly', () => {
    const bad = migrationNoticeSchema.safeParse({
      kind: 'some-future-thing',
      message: 'hi',
    });
    expect(bad.success).toBe(false);
  });
});

describe('agentStatusSchema', () => {
  it('parses available with version and binaryPath', () => {
    const parsed = agentStatusSchema.parse({
      status: 'available',
      version: '1.2.3',
      binaryPath: '/usr/local/bin/claude',
    });
    expect(parsed).toEqual({
      status: 'available',
      version: '1.2.3',
      binaryPath: '/usr/local/bin/claude',
    });
  });

  it('parses broken with binaryPath and error', () => {
    const parsed = agentStatusSchema.parse({
      status: 'broken',
      binaryPath: '/bad',
      error: 'boom',
    });
    expect(parsed).toEqual({ status: 'broken', binaryPath: '/bad', error: 'boom' });
  });

  it('parses not-installed', () => {
    expect(agentStatusSchema.parse({ status: 'not-installed' })).toEqual({
      status: 'not-installed',
    });
  });

  it('rejects available without binaryPath', () => {
    expect(
      agentStatusSchema.safeParse({ status: 'available', version: '1.0.0' }).success,
    ).toBe(false);
  });
});

describe('agentDetectionResultSchema', () => {
  it('accepts the stub payload from detect_agents', () => {
    const parsed = agentDetectionResultSchema.parse({
      claude: { status: 'not-installed' },
      codex: { status: 'not-installed' },
      gemini: { status: 'not-installed' },
      recommendedMaster: null,
    });
    expect(parsed.recommendedMaster).toBeNull();
  });

  it('accepts a recommendation of claude', () => {
    const parsed = agentDetectionResultSchema.parse({
      claude: {
        status: 'available',
        version: '1.0.0',
        binaryPath: '/opt/homebrew/bin/claude',
      },
      codex: { status: 'not-installed' },
      gemini: { status: 'broken', binaryPath: '/x', error: 'bad path' },
      recommendedMaster: 'claude',
    });
    expect(parsed.recommendedMaster).toBe('claude');
  });
});

describe('runStatusSchema', () => {
  it('accepts all documented kebab-case states', () => {
    for (const s of [
      'idle',
      'planning',
      'awaiting-approval',
      'running',
      'merging',
      'done',
      'rejected',
      'failed',
    ]) {
      expect(runStatusSchema.parse(s)).toBe(s);
    }
  });
});

describe('subtaskStateSchema', () => {
  it('accepts all documented states', () => {
    for (const s of ['proposed', 'waiting', 'running', 'done', 'failed', 'skipped']) {
      expect(subtaskStateSchema.parse(s)).toBe(s);
    }
  });
});

describe('subtaskDataSchema', () => {
  it('parses camelCase keys with nullable why', () => {
    const parsed = subtaskDataSchema.parse({
      id: 's1',
      title: 'do the thing',
      why: null,
      assignedWorker: 'codex',
      dependencies: ['s0'],
    });
    expect(parsed.assignedWorker).toBe('codex');
    expect(parsed.why).toBeNull();
    // `replaces` / `replanCount` omitted in wire → default [] / 0.
    expect(parsed.replaces).toEqual([]);
    expect(parsed.replanCount).toBe(0);
  });

  it('accepts an explicit replanCount from the wire', () => {
    const parsed = subtaskDataSchema.parse({
      id: 's2',
      title: 'replacement',
      why: 'original failed',
      assignedWorker: 'claude',
      dependencies: [],
      replaces: ['s1'],
      replanCount: 2,
    });
    expect(parsed.replaces).toEqual(['s1']);
    expect(parsed.replanCount).toBe(2);
  });

  it('rejects a negative replanCount', () => {
    const result = subtaskDataSchema.safeParse({
      id: 's3',
      title: 't',
      why: null,
      assignedWorker: 'claude',
      dependencies: [],
      replanCount: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe('subtaskPatchSchema', () => {
  it('accepts an empty patch (all fields optional, means "leave alone")', () => {
    expect(subtaskPatchSchema.parse({})).toEqual({});
  });

  it('accepts a title-only patch', () => {
    expect(subtaskPatchSchema.parse({ title: 'new' })).toEqual({ title: 'new' });
  });

  it('accepts why as string, null, or absent', () => {
    expect(subtaskPatchSchema.parse({ why: 'because' }).why).toBe('because');
    expect(subtaskPatchSchema.parse({ why: null }).why).toBeNull();
    expect(subtaskPatchSchema.parse({}).why).toBeUndefined();
  });

  it('accepts assignedWorker', () => {
    const parsed = subtaskPatchSchema.parse({ assignedWorker: 'gemini' });
    expect(parsed.assignedWorker).toBe('gemini');
  });

  it('rejects an unknown assignedWorker', () => {
    expect(
      subtaskPatchSchema.safeParse({ assignedWorker: 'gpt4' }).success,
    ).toBe(false);
  });

  it('rejects a non-string title', () => {
    expect(subtaskPatchSchema.safeParse({ title: 123 }).success).toBe(false);
  });
});

describe('subtaskDraftSchema', () => {
  it('parses a minimal draft (title + worker)', () => {
    const parsed = subtaskDraftSchema.parse({
      title: 'do X',
      assignedWorker: 'claude',
    });
    expect(parsed.title).toBe('do X');
    expect(parsed.assignedWorker).toBe('claude');
    expect(parsed.why).toBeUndefined();
  });

  it('accepts why as string or null', () => {
    expect(
      subtaskDraftSchema.parse({
        title: 't',
        why: 'rationale',
        assignedWorker: 'codex',
      }).why,
    ).toBe('rationale');
    expect(
      subtaskDraftSchema.parse({
        title: 't',
        why: null,
        assignedWorker: 'codex',
      }).why,
    ).toBeNull();
  });

  it('requires title and assignedWorker', () => {
    expect(subtaskDraftSchema.safeParse({ title: 't' }).success).toBe(false);
    expect(
      subtaskDraftSchema.safeParse({ assignedWorker: 'claude' }).success,
    ).toBe(false);
  });
});

describe('statusChangedSchema', () => {
  it('matches the camelCase shape emitted by the Rust helper', () => {
    const parsed = statusChangedSchema.parse({
      runId: 'r1',
      status: 'awaiting-approval',
    });
    expect(parsed).toEqual({ runId: 'r1', status: 'awaiting-approval' });
  });

  it('rejects snake_case keys (guards against backend regression)', () => {
    expect(
      statusChangedSchema.safeParse({ run_id: 'r1', status: 'planning' }).success,
    ).toBe(false);
  });
});

describe('subtasksProposedSchema', () => {
  it('parses a list of subtasks', () => {
    const parsed = subtasksProposedSchema.parse({
      runId: 'r1',
      subtasks: [
        {
          id: 's1',
          title: 't',
          why: 'because',
          assignedWorker: 'claude',
          dependencies: [],
        },
      ],
    });
    expect(parsed.subtasks).toHaveLength(1);
  });
});

describe('subtaskStateChangedSchema', () => {
  it('parses camelCase subtaskId', () => {
    const parsed = subtaskStateChangedSchema.parse({
      runId: 'r1',
      subtaskId: 's1',
      state: 'running',
    });
    expect(parsed.subtaskId).toBe('s1');
  });
});

describe('diffReadySchema', () => {
  it('rejects negative additions', () => {
    expect(
      diffReadySchema.safeParse({
        runId: 'r1',
        files: [{ path: 'a', additions: -1, deletions: 0 }],
      }).success,
    ).toBe(false);
  });

  it('accepts an empty file list', () => {
    const parsed = diffReadySchema.parse({ runId: 'r1', files: [] });
    expect(parsed.files).toEqual([]);
  });
});

describe('settingsSchema', () => {
  it('parses the default-ish settings shape from disk', () => {
    const parsed = settingsSchema.parse({
      lastRepo: null,
      masterAgent: 'claude',
    });
    expect(parsed.lastRepo).toBeNull();
    expect(parsed.masterAgent).toBe('claude');
  });

  it('accepts optional binary overrides', () => {
    const parsed = settingsSchema.parse({
      lastRepo: '/Users/me/app',
      masterAgent: 'gemini',
      claudeBinaryPath: '/opt/homebrew/bin/claude',
    });
    expect(parsed.claudeBinaryPath).toBe('/opt/homebrew/bin/claude');
    expect(parsed.codexBinaryPath).toBeUndefined();
  });

  it('requires lastRepo to be present (null is the empty value)', () => {
    expect(settingsSchema.safeParse({ masterAgent: 'claude' }).success).toBe(false);
  });
});

describe('repoInfoSchema', () => {
  it('parses the payload returned by pick_repo', () => {
    const parsed = repoInfoSchema.parse({
      path: '/Users/me/app',
      name: 'app',
      isGitRepo: true,
      currentBranch: 'main',
    });
    expect(parsed.currentBranch).toBe('main');
  });

  it('allows currentBranch to be null (detached HEAD or non-repo)', () => {
    const parsed = repoInfoSchema.parse({
      path: '/tmp/x',
      name: 'x',
      isGitRepo: false,
      currentBranch: null,
    });
    expect(parsed.isGitRepo).toBe(false);
  });
});

describe('repoValidationSchema', () => {
  it('discriminates on the boolean valid tag — valid branch', () => {
    const parsed = repoValidationSchema.parse({
      valid: true,
      info: {
        path: '/r',
        name: 'r',
        isGitRepo: true,
        currentBranch: 'main',
      },
    });
    expect(parsed.valid).toBe(true);
    if (parsed.valid) expect(parsed.info.name).toBe('r');
  });

  it('discriminates on the boolean valid tag — invalid branch', () => {
    const parsed = repoValidationSchema.parse({
      valid: false,
      reason: 'not_a_git_repo',
    });
    expect(parsed.valid).toBe(false);
    if (!parsed.valid) expect(parsed.reason).toBe('not_a_git_repo');
  });

  it('rejects string-tagged discriminator (guard against serde regression)', () => {
    // The Rust side hand-rolls Serialize to emit `true`/`false` as booleans,
    // not strings — this test catches a regression if it flips back.
    expect(
      repoValidationSchema.safeParse({ valid: 'true', info: {} }).success,
    ).toBe(false);
  });

  it('rejects unknown reason codes', () => {
    expect(
      repoValidationSchema.safeParse({ valid: false, reason: 'wat' }).success,
    ).toBe(false);
  });
});

describe('editorMethodSchema', () => {
  it('accepts the four kebab-case tiers emitted by the backend', () => {
    for (const m of ['configured', 'environment', 'platform-default', 'clipboard-only']) {
      expect(editorMethodSchema.parse(m)).toBe(m);
    }
  });

  it('rejects snake_case (guard against serde regression)', () => {
    expect(editorMethodSchema.safeParse('clipboard_only').success).toBe(false);
  });
});

describe('editorResultSchema', () => {
  it('parses the happy-path payload', () => {
    const parsed = editorResultSchema.parse({
      method: 'configured',
      path: '/tmp/subtask-r1-s1',
    });
    expect(parsed.method).toBe('configured');
    expect(parsed.path).toBe('/tmp/subtask-r1-s1');
  });

  it('parses the clipboard-only tier (path still populated)', () => {
    const parsed = editorResultSchema.parse({
      method: 'clipboard-only',
      path: '/tmp/subtask-r1-s1',
    });
    expect(parsed.method).toBe('clipboard-only');
  });

  it('requires both method and path', () => {
    expect(
      editorResultSchema.safeParse({ method: 'configured' }).success,
    ).toBe(false);
  });
});

describe('skipResultSchema', () => {
  it('parses a leaf-only skip (count=1, ids=[sid])', () => {
    const parsed = skipResultSchema.parse({
      skippedCount: 1,
      skippedIds: ['s1'],
    });
    expect(parsed.skippedCount).toBe(1);
    expect(parsed.skippedIds).toEqual(['s1']);
  });

  it('parses a cascade skip', () => {
    const parsed = skipResultSchema.parse({
      skippedCount: 3,
      skippedIds: ['s1', 's2', 's3'],
    });
    expect(parsed.skippedCount).toBe(3);
    expect(parsed.skippedIds).toHaveLength(3);
  });

  it('rejects a negative count', () => {
    expect(
      skipResultSchema.safeParse({ skippedCount: -1, skippedIds: [] }).success,
    ).toBe(false);
  });
});
