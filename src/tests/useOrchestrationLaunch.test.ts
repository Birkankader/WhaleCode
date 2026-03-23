import { describe, expect, it } from 'vitest';
import { buildLaunchDispatchPlan, type LaunchConfig } from '../hooks/useOrchestrationLaunch';

function makeConfig(partial: Partial<LaunchConfig>): LaunchConfig {
  return {
    sessionName: 'Mar 15 session',
    projectDir: '/tmp/project',
    master: { cli: 'gemini', name: 'Gemini CLI' },
    workers: [],
    taskDescription: 'Selam',
    ...partial,
  };
}

describe('buildLaunchDispatchPlan', () => {
  it('uses single-task mode when no workers are selected', () => {
    const plan = buildLaunchDispatchPlan(makeConfig({ workers: [] }));

    expect(plan).not.toBeNull();
    expect(plan?.mode).toBe('single');
    expect(plan?.masterToolName).toBe('gemini');
    expect(plan?.totalWorkerCount).toBe(0);
    expect(plan?.orchestratorConfig.agents).toEqual([
      { toolName: 'gemini', subAgentCount: 0, isMaster: true },
    ]);
  });

  it('keeps orchestration mode when workers exist on a different tool', () => {
    const plan = buildLaunchDispatchPlan(
      makeConfig({
        workers: [
          {
            agent: { cli: 'claude', name: 'Claude Code' },
            count: 2,
          },
        ],
      }),
    );

    expect(plan?.mode).toBe('orchestrated');
    expect(plan?.totalWorkerCount).toBe(2);
    expect(plan?.orchestratorConfig.agents).toEqual([
      { toolName: 'gemini', subAgentCount: 0, isMaster: true },
      { toolName: 'claude', subAgentCount: 2, isMaster: false },
    ]);
  });

  it('merges same-tool workers into the master entry instead of creating a duplicate agent', () => {
    const plan = buildLaunchDispatchPlan(
      makeConfig({
        workers: [
          {
            agent: { cli: 'gemini', name: 'Gemini CLI' },
            count: 1,
          },
        ],
      }),
    );

    expect(plan?.mode).toBe('orchestrated');
    expect(plan?.totalWorkerCount).toBe(1);
    expect(plan?.orchestratorConfig.agents).toEqual([
      { toolName: 'gemini', subAgentCount: 1, isMaster: true },
    ]);
  });

  it('returns null when config.master is null', () => {
    const plan = buildLaunchDispatchPlan(makeConfig({ master: null }));
    expect(plan).toBeNull();
  });

  it('treats worker with count: 0 as single mode (no effective workers)', () => {
    const plan = buildLaunchDispatchPlan(
      makeConfig({
        workers: [
          {
            agent: { cli: 'claude', name: 'Claude Code' },
            count: 0,
          },
        ],
      }),
    );

    expect(plan).not.toBeNull();
    expect(plan?.mode).toBe('single');
    expect(plan?.totalWorkerCount).toBe(0);
  });
});
