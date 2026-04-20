/**
 * Zustand slice for repo + settings — everything the app needs to decide
 * which folder the orchestrator is working in. Kept separate from
 * `graphStore` because its lifecycle is different: repo/settings outlive
 * a single run, while `graphStore` is reset per run.
 *
 * Boot flow is driven by `init()` from `App.tsx`. Everything else is the
 * user pressing Cmd+O, clicking the TopBar label, or picking from the
 * overlay — all funnel through `pickInteractively()`.
 */

import { create } from 'zustand';

import {
  getSettings,
  pickRepo,
  setSettings as setSettingsIpc,
  validateRepo,
  type AgentKind,
  type RepoInfo,
  type Settings,
} from '../lib/ipc';
import { useAgentStore } from './agentStore';

export type RepoState = {
  /** Initial boot is in flight — gate the UI so we don't flash the picker. */
  initializing: boolean;
  /** Null until settings are loaded. */
  settings: Settings | null;
  /** Validated repo the orchestrator will operate on, or null if none. */
  currentRepo: RepoInfo | null;
  /**
   * Transient explanation of the last failed pick, for a toast-ish surface
   * beneath the picker. Cleared on the next successful pick or on open.
   */
  pickerError: string | null;

  init: () => Promise<void>;
  pickInteractively: () => Promise<void>;
  clearCurrentRepo: () => Promise<void>;
  setMasterAgent: (agent: AgentKind) => Promise<void>;
  /**
   * Phase 3 Step 7: persist auto-approve settings. Accepts a partial
   * patch — any combination of toggle / ceiling / editor / consent
   * flag. The backend persists + re-emits the merged settings; we
   * mirror the result locally so UI reads stay in sync.
   */
  updateSettings: (
    patch: Partial<{
      autoApprove: boolean;
      maxSubtasksPerAutoApprovedRun: number;
      autoApproveConsentGiven: boolean;
      /**
       * `null` explicitly clears the editor preference (backend falls
       * back to $EDITOR / platform default); `undefined` / omission
       * leaves the stored value untouched. Mirrors the wire contract
       * in `SettingsPatch`.
       */
      editor: string | null;
    }>,
  ) => Promise<void>;
};

export const useRepoStore = create<RepoState>((set, get) => ({
  initializing: true,
  settings: null,
  currentRepo: null,
  pickerError: null,

  async init() {
    try {
      const settings = await getSettings();
      let currentRepo: RepoInfo | null = null;

      if (settings.lastRepo) {
        const validation = await validateRepo(settings.lastRepo);
        if (validation.valid) {
          currentRepo = validation.info;
        } else {
          // Stale pointer (folder deleted/moved) — forget it silently so the
          // picker shows up clean on the next render.
          await setSettingsIpc({ lastRepo: null });
          settings.lastRepo = null;
        }
      }

      set({ settings, currentRepo, initializing: false });

      // Kick off agent detection. We don't await it blocking the UI — the
      // setup/picker screens can render without it — but we do want the
      // master-agent auto-swap to happen before the first submit_task.
      const detection = await useAgentStore.getState().refresh();
      if (detection) {
        const currentMasterStatus = detection[settings.masterAgent];
        const currentMasterUsable = currentMasterStatus.status === 'available';
        if (!currentMasterUsable && detection.recommendedMaster) {
          // Silent auto-switch: the user's chosen master is broken/missing,
          // so follow the fallback chain. They can change it back from the
          // TopBar dropdown once the binary is fixed.
          try {
            const merged = await setSettingsIpc({
              masterAgent: detection.recommendedMaster,
            });
            set({ settings: merged });
          } catch (err) {
            console.error('[repoStore] auto-swap master failed', err);
          }
        }
      }
    } catch (err) {
      console.error('[repoStore] init failed', err);
      set({ initializing: false });
    }
  },

  async pickInteractively() {
    set({ pickerError: null });
    let picked: RepoInfo | null;
    try {
      picked = await pickRepo();
    } catch (err) {
      set({ pickerError: String(err) });
      return;
    }
    if (picked === null) return; // user cancelled
    if (!picked.isGitRepo) {
      set({ pickerError: `"${picked.name}" isn't a git repo` });
      return;
    }

    try {
      const merged = await setSettingsIpc({ lastRepo: picked.path });
      set({ currentRepo: picked, settings: merged });
    } catch (err) {
      set({ pickerError: `Couldn't save settings: ${err}` });
    }
  },

  async clearCurrentRepo() {
    try {
      const merged = await setSettingsIpc({ lastRepo: null });
      set({ currentRepo: null, settings: merged });
    } catch (err) {
      set({ pickerError: `Couldn't clear settings: ${err}` });
    }
  },

  async setMasterAgent(agent) {
    const merged = await setSettingsIpc({ masterAgent: agent });
    set({ settings: merged });
    // Keep graphStore's selectedMasterAgent in sync for Phase 1's mock flow;
    // real orchestrator reads settings directly from Rust.
    const { settings } = get();
    if (settings) settings.masterAgent = agent;
  },

  async updateSettings(patch) {
    const merged = await setSettingsIpc(patch);
    set({ settings: merged });
  },
}));
