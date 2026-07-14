// Small, in-memory UI state for the Vibe shell — dialogs, the Conductor
// sidebar, the fleet filter and the focus/wide state. Deliberately NOT
// persisted (transient view state). Kept out of the session store so
// transcript churn never re-renders the shell chrome and vice-versa.

import { create } from "zustand";

/** What the right-hand stage shows: Mission Control or one focused worker. */
export type VibeStageMode = "workspace" | "session";
export type WorkspaceView =
  | "board"
  | "graph"
  | "fleet"
  | "integration"
  | "timeline";

/** Fleet-grid filter chips (the reference's All/working/needs/finished/idle). */
export type FleetFilter = "all" | "working" | "needs" | "finished" | "idle";

const CONDUCTOR_MIN_W = 300;
const CONDUCTOR_MAX_W = 680;
export const CONDUCTOR_DEFAULT_W = 430;

interface VibeUiState {
  /** the New-Session dialog is open */
  newSessionOpen: boolean;
  setNewSessionOpen: (open: boolean) => void;
  /** mission intake / policy dialog */
  missionCreateOpen: boolean;
  setMissionCreateOpen: (open: boolean) => void;
  /** session id awaiting a busy-close confirmation (null = no dialog) */
  closeConfirmId: string | null;
  setCloseConfirmId: (id: string | null) => void;
  /** project tab awaiting a close confirmation because sessions are still
   * busy (closing never stops them — the dialog just says so) */
  closeProjectConfirm: { projectId: string; busyCount: number } | null;
  setCloseProjectConfirm: (
    confirm: { projectId: string; busyCount: number } | null,
  ) => void;
  /** fleet grid vs. one focused session (see VibeStageMode) */
  stageMode: VibeStageMode;
  setStageMode: (mode: VibeStageMode) => void;
  workspaceView: WorkspaceView;
  setWorkspaceView: (view: WorkspaceView) => void;
  selectedMissionId: string | null;
  setSelectedMissionId: (id: string | null) => void;
  selectedMissionTaskId: string | null;
  setSelectedMissionTaskId: (id: string | null) => void;
  attentionOpen: boolean;
  setAttentionOpen: (open: boolean) => void;
  recoveryOpen: boolean;
  setRecoveryOpen: (open: boolean) => void;
  /** "show me the Conductor" (⌘⇧O, Deck dot, title bar, palette): land on
   * the fleet AND make sure the sidebar is visible */
  showConductor: () => void;
  /** collapse a focused session back to the grid (never touches the sidebar) */
  backToFleet: () => void;
  /** the Conductor sidebar is visible (⌘B toggles) */
  conductorOpen: boolean;
  setConductorOpen: (open: boolean) => void;
  toggleConductor: () => void;
  /** preferred sidebar width in px (300–680; the view adds a viewport clamp) */
  conductorWidth: number;
  setConductorWidth: (w: number) => void;
  /** active fleet-grid filter chip */
  fleetFilter: FleetFilter;
  setFleetFilter: (f: FleetFilter) => void;
  /** focused session fills the whole window (fleet + sidebar hidden) */
  wide: boolean;
  setWide: (wide: boolean) => void;
}

export const useVibeUi = create<VibeUiState>((set) => ({
  newSessionOpen: false,
  setNewSessionOpen: (open) => set({ newSessionOpen: open }),
  missionCreateOpen: false,
  setMissionCreateOpen: (open) => set({ missionCreateOpen: open }),
  closeConfirmId: null,
  setCloseConfirmId: (id) => set({ closeConfirmId: id }),
  closeProjectConfirm: null,
  setCloseProjectConfirm: (confirm) => set({ closeProjectConfirm: confirm }),
  stageMode: "workspace",
  setStageMode: (mode) =>
    set(mode === "workspace" ? { stageMode: mode, wide: false } : { stageMode: mode }),
  workspaceView: "board",
  setWorkspaceView: (workspaceView) =>
    set({ workspaceView, stageMode: "workspace", wide: false }),
  selectedMissionId: null,
  setSelectedMissionId: (selectedMissionId) =>
    set({ selectedMissionId, selectedMissionTaskId: null }),
  selectedMissionTaskId: null,
  setSelectedMissionTaskId: (selectedMissionTaskId) =>
    set({ selectedMissionTaskId }),
  attentionOpen: false,
  setAttentionOpen: (attentionOpen) => set({ attentionOpen }),
  recoveryOpen: false,
  setRecoveryOpen: (recoveryOpen) => set({ recoveryOpen }),
  showConductor: () =>
    set({ stageMode: "workspace", conductorOpen: true, wide: false }),
  backToFleet: () =>
    set({ stageMode: "workspace", workspaceView: "fleet", wide: false }),
  conductorOpen: true,
  setConductorOpen: (open) => set({ conductorOpen: open }),
  toggleConductor: () => set((s) => ({ conductorOpen: !s.conductorOpen })),
  conductorWidth: CONDUCTOR_DEFAULT_W,
  setConductorWidth: (w) =>
    set({
      conductorWidth: Math.max(CONDUCTOR_MIN_W, Math.min(CONDUCTOR_MAX_W, w)),
    }),
  fleetFilter: "all",
  setFleetFilter: (f) => set({ fleetFilter: f }),
  wide: false,
  setWide: (wide) => set({ wide }),
}));
