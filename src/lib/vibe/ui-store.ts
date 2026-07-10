// Small, in-memory UI state for the Vibe shell (Phase 3) — the New-Session
// dialog and the close-confirm target. Deliberately NOT persisted (transient
// dialog state, like the main store's newAgentOpen). Kept out of the session
// store so transcript churn never re-renders the dialog and vice-versa.

import { create } from "zustand";

/**
 * Which surface the FocusStage shows: the pinned Conductor (the orchestrator
 * chat, Orchestrator-first) or the selected native session. Default
 * "conductor" — starting without an explicit session pick lands on
 * the conductor. Transient in-memory, like the dialog flags.
 */
export type VibeStageMode = "conductor" | "session";

interface VibeUiState {
  /** the New-Session dialog is open */
  newSessionOpen: boolean;
  setNewSessionOpen: (open: boolean) => void;
  /** session id awaiting a busy-close confirmation (null = no dialog) */
  closeConfirmId: string | null;
  setCloseConfirmId: (id: string | null) => void;
  /** project tab awaiting a close confirmation because sessions are still
   * busy (closing never stops them — the dialog just says so) */
  closeProjectConfirm: { projectId: string; busyCount: number } | null;
  setCloseProjectConfirm: (
    confirm: { projectId: string; busyCount: number } | null,
  ) => void;
  /** conductor vs. session stage (Phase 5, Orchestrator-first) */
  stageMode: VibeStageMode;
  setStageMode: (mode: VibeStageMode) => void;
}

export const useVibeUi = create<VibeUiState>((set) => ({
  newSessionOpen: false,
  setNewSessionOpen: (open) => set({ newSessionOpen: open }),
  closeConfirmId: null,
  setCloseConfirmId: (id) => set({ closeConfirmId: id }),
  closeProjectConfirm: null,
  setCloseProjectConfirm: (confirm) => set({ closeProjectConfirm: confirm }),
  stageMode: "conductor",
  setStageMode: (mode) => set({ stageMode: mode }),
}));
