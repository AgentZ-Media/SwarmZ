// Standalone zustand store for the Agent Library (pattern: lib/limits.ts).
// NO persistence — the agent folders on disk ARE the source of truth; this
// store only CACHES the discovered list + holds the library/editor UI state.
// Discovery is lazy (`ensureAgents`) and re-runs on demand (`refreshAgents`).

import { create } from "zustand";
import { listAgents } from "./api";
import type { AgentSummary } from "./types";

interface AgentsState {
  /** cached discovery result (null until the first load settles) */
  agents: AgentSummary[] | null;
  loading: boolean;
  error: string | null;

  /** the Agent Library dialog */
  libraryOpen: boolean;
  /** the slug currently being edited, "" = a brand-new draft, null = closed */
  editingSlug: string | null;
  /** the "New agent" Builder pre-dialog (name → slug → start a Builder session) */
  newBuilderOpen: boolean;
  /**
   * The Vibe session id of the OPEN Builder modal, or null when closed. The
   * Builder no longer lives on the Vibe stage — it runs its native session in a
   * dedicated focused modal (components/agents/BuilderModal.tsx) that stays open
   * until the agent is finished. `startBuilderSession` sets this.
   */
  builderSessionId: string | null;

  setLibraryOpen: (open: boolean) => void;
  openEditor: (slug: string | null) => void;
  setNewBuilderOpen: (open: boolean) => void;
  /** open the Builder modal on a freshly-started Builder session */
  openBuilderModal: (sessionId: string) => void;
  /** close the Builder modal (the session is ended separately) */
  closeBuilderModal: () => void;
  /** load once if not already loaded (library open) */
  ensureAgents: () => Promise<void>;
  /** force a re-scan of the folder (after create/edit/delete) */
  refreshAgents: () => Promise<void>;
}

export const useAgents = create<AgentsState>((set, get) => ({
  agents: null,
  loading: false,
  error: null,
  libraryOpen: false,
  editingSlug: null,
  newBuilderOpen: false,
  builderSessionId: null,

  setLibraryOpen: (open) => {
    set({ libraryOpen: open });
    if (open) void get().ensureAgents();
  },
  openEditor: (slug) => set({ editingSlug: slug }),
  setNewBuilderOpen: (open) => set({ newBuilderOpen: open }),
  openBuilderModal: (sessionId) => set({ builderSessionId: sessionId }),
  closeBuilderModal: () => set({ builderSessionId: null }),

  ensureAgents: async () => {
    if (get().agents !== null || get().loading) return;
    await get().refreshAgents();
  },

  refreshAgents: async () => {
    set({ loading: true });
    try {
      const agents = await listAgents();
      set({ agents, loading: false, error: null });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },
}));
