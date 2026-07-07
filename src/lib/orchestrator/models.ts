// Shared model + effort sources for the on-the-fly pickers (Vibe sessions,
// orchestrator codex chats, Settings defaults). The recently-used Codex model
// ids are derived from REAL usage on this machine — the same honest source the
// `list_blueprints` executor exposes to the orchestrator — so the picker never
// shows a stale hardcoded catalog.

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useSwarm } from "@/store";

/**
 * Reasoning-effort values codex accepts (turn/start `effort` override). Kept in
 * sync with the create_panes reasoning enum in `executors.ts`. Ordered low →
 * high for display.
 */
export const CODEX_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type CodexEffort = (typeof CODEX_EFFORTS)[number];

/**
 * Recently-used Codex model ids on this machine, newest signal first. Reads the
 * open panes' usage plus the persisted usage history (mirrors the
 * `list_blueprints` executor). Pure over the passed state so it stays cheap in
 * a selector; the no-arg overload reads the live store.
 */
export function recentCodexModels(
  state: ReturnType<typeof useSwarm.getState> = useSwarm.getState(),
): string[] {
  const seen = new Set<string>();
  const add = (runtime: string | undefined, model: string | undefined | null) => {
    if (!model) return;
    if (runtime === "codex") seen.add(model);
  };
  for (const a of Object.values(state.agents)) {
    add(a.runtime, a.usage?.primary_model ?? undefined);
    for (const m of a.usage?.by_model ?? []) add(a.runtime, m.model);
  }
  const history = Object.values(state.usageHistory)
    .sort((a, b) => b.last_updated - a.last_updated)
    .slice(0, 120);
  for (const e of history) for (const m of e.by_model) add(e.runtime, m.model);
  return [...seen].slice(0, 12);
}

/**
 * Available Codex models, fetched from the app-server `model/list` catalog
 * (`codex_list_models` Rust command) and cached for the app's lifetime. This is
 * the AUTHORITATIVE list the installed codex offers — unlike recentCodexModels,
 * which is only what happened to run on this machine. Non-default-picker
 * (hidden) models are excluded by the backend; the default model sorts first.
 *
 * A standalone zustand store (same pattern as lib/limits.ts) so any picker can
 * subscribe; `ensureCodexModels()` triggers the one-shot fetch (a failed or
 * unauthenticated fetch just leaves the list empty — the picker falls back to
 * Recent + Custom).
 */
interface CodexModelsState {
  /** available model ids, default first (empty until fetched / on failure) */
  available: string[];
  loaded: boolean;
  loading: boolean;
  ensure: () => void;
}

export const useCodexModels = create<CodexModelsState>((set, get) => ({
  available: [],
  loaded: false,
  loading: false,
  ensure: () => {
    if (get().loaded || get().loading) return;
    set({ loading: true });
    void invoke<string[]>("codex_list_models")
      .then((ids) =>
        set({
          available: Array.isArray(ids) ? ids : [],
          loaded: true,
          loading: false,
        }),
      )
      // failure is NOT cached as loaded — the next picker open retries (the
      // first open can race the dev rebuild / a codex that isn't up yet)
      .catch(() => set({ loading: false }));
  },
}));

/** Kick off the one-shot codex model-catalog fetch (no-op once loaded). */
export function ensureCodexModels(): void {
  useCodexModels.getState().ensure();
}
