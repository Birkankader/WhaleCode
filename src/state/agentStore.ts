/**
 * Zustand slice for agent detection state. Lives alongside `repoStore` and
 * `graphStore` but keeps its own concerns narrow: what does `detect_agents`
 * say about each CLI, are we currently checking, when did the last check
 * finish.
 *
 * Boot flow owns the first `refresh()` (see `repoStore.init()` — it sequences
 * settings load → detect → auto-select recommended master if needed). The
 * UI can call `refresh()` again from a "Recheck" button; the store ignores
 * concurrent calls so button-mashing can't stack probes on the orchestrator.
 */

import { create } from 'zustand';

import {
  detectAgents,
  setMasterAgent as setMasterAgentIpc,
  type AgentDetectionResult,
  type AgentKind,
  type AgentStatus,
} from '../lib/ipc';
import { useRepoStore } from './repoStore';

export type AgentState = {
  /** Last detection result, or null before the first refresh completes. */
  detection: AgentDetectionResult | null;
  /** True while a `detect_agents` call is in flight. */
  checking: boolean;
  /** Last error thrown by the backend (serialized) for a Recheck surface. */
  error: string | null;

  /** Runs detect_agents once. Concurrent calls are coalesced to the in-flight one. */
  refresh: () => Promise<AgentDetectionResult | null>;
  /** Thin wrapper around the IPC — updates `detection` locally on success. */
  selectMaster: (agent: AgentKind) => Promise<void>;
};

/** Held outside the store so `set` doesn't need to track it; pure coalescing. */
let inFlight: Promise<AgentDetectionResult | null> | null = null;

export const useAgentStore = create<AgentState>((set) => ({
  detection: null,
  checking: false,
  error: null,

  async refresh() {
    if (inFlight) return inFlight;
    set({ checking: true, error: null });
    inFlight = (async () => {
      try {
        const result = await detectAgents();
        set({ detection: result, checking: false });
        return result;
      } catch (err) {
        set({ error: String(err), checking: false });
        return null;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },

  async selectMaster(agent) {
    // set_master_agent returns the merged Settings; funnel it straight into
    // repoStore so both stores stay consistent without a re-fetch.
    const updated = await setMasterAgentIpc(agent);
    useRepoStore.setState({ settings: updated });
  },
}));

/** Pure helper: is this status selectable as a master? Exported for tests/UI. */
export function isSelectable(status: AgentStatus | undefined): boolean {
  return status?.status === 'available';
}
