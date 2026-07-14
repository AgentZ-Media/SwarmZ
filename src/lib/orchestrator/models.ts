// Shared model + effort sources for the on-the-fly pickers (sessions,
// orchestrator chats, Settings defaults). The recently-used Codex model ids
// are derived from REAL usage on this machine (the persisted usage history),
// so the picker never shows a stale hardcoded catalog.

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useSwarm } from "@/store";

/**
 * Reasoning-effort values codex accepts (turn/start `effort` override). Kept in
 * as a fallback for Custom/default selections. Catalog-backed models use
 * their own advertised effort list. `ultra` is intentionally absent: it is a
 * multi-agent execution mode, not a single-agent reasoning effort.
 */
export const CODEX_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type CodexEffort = (typeof CODEX_EFFORTS)[number];

export interface CodexReasoningEffortEntry {
  effort: string;
  description: string;
}

/** Rich `model/list` row from the installed Codex app-server. */
export interface CodexModelCatalogEntry {
  id: string;
  /** exact value accepted by thread/turn model overrides */
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: CodexReasoningEffortEntry[];
}

/**
 * Recently-used Codex model ids on this machine, newest signal first. Reads
 * the persisted usage history. Pure over the passed state so it stays cheap
 * in a selector; the no-arg overload reads the live store.
 */
export function recentCodexModels(
  state: ReturnType<typeof useSwarm.getState> = useSwarm.getState(),
): string[] {
  const seen = new Set<string>();
  const add = (runtime: string | undefined, model: string | undefined | null) => {
    if (!model) return;
    // runtime-less entries predate the rebuild (Claude parser) — their model
    // ids must never reach the codex picker (they'd go out as turn overrides)
    if ((runtime ?? "claude") === "codex") seen.add(model);
  };
  const history = Object.values(state.usageHistory)
    .sort((a, b) => b.last_updated - a.last_updated)
    .slice(0, 120);
  for (const e of history) for (const m of e.by_model) add(e.runtime, m.model);
  return [...seen].slice(0, 12);
}

/**
 * Available Codex models, fetched from the app-server `model/list` catalog
 * (`codex_model_catalog` Rust command) and cached for the app's lifetime. This is
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
  /** rich live catalog, in server order */
  catalog: CodexModelCatalogEntry[];
  loaded: boolean;
  loading: boolean;
  ensure: () => void;
}

export const useCodexModels = create<CodexModelsState>((set, get) => ({
  available: [],
  catalog: [],
  loaded: false,
  loading: false,
  ensure: () => {
    if (get().loaded || get().loading) return;
    set({ loading: true });
    void fetchCodexModelCatalog()
      .then((catalog) =>
        set({
          available: catalog.map((entry) => entry.model),
          catalog,
          loaded: true,
          loading: false,
        }),
      )
      // failure is NOT cached as loaded — the next picker open retries (the
      // first open can race the dev rebuild / a codex that isn't up yet)
      .catch(() => set({ loading: false }));
  },
}));

let catalogInFlight: Promise<CodexModelCatalogEntry[]> | null = null;

/** Shared awaitable loader for pickers and Conductor executors. Concurrent
 * calls collapse onto one app-server request; failures are not cached. Pass
 * `force` for the Conductor's list_models tool so an explicit refresh really
 * asks the currently installed app-server instead of returning the UI cache. */
export function fetchCodexModelCatalog(
  force = false,
): Promise<CodexModelCatalogEntry[]> {
  if (!force && useCodexModels.getState().loaded)
    return Promise.resolve(useCodexModels.getState().catalog);
  if (catalogInFlight) return catalogInFlight;
  catalogInFlight = invoke<CodexModelCatalogEntry[]>("codex_model_catalog")
    .then((value) => {
      const catalog = (Array.isArray(value) ? value : []).map((entry) => ({
        ...entry,
        defaultReasoningEffort:
          entry.defaultReasoningEffort.trim().toLowerCase() === "ultra"
            ? ""
            : entry.defaultReasoningEffort,
        supportedReasoningEfforts: entry.supportedReasoningEfforts.filter(
          (item) => item.effort.trim().toLowerCase() !== "ultra",
        ),
      }));
      useCodexModels.setState({
        available: catalog.map((entry) => entry.model),
        catalog,
        loaded: true,
        loading: false,
      });
      return catalog;
    })
    .finally(() => {
      catalogInFlight = null;
    });
  return catalogInFlight;
}

/** Catalog row for an exact override; accepts catalog id as a compatibility
 * alias but callers should send the row's `model` value. */
export function catalogModel(
  catalog: CodexModelCatalogEntry[],
  model: string,
): CodexModelCatalogEntry | undefined {
  return catalog.find((entry) => entry.model === model || entry.id === model);
}

/** Strict Conductor-side preflight. Human Custom… selections remain open;
 * autonomous choices must come from the catalog so failures happen before a
 * worktree/session is created. */
export function validateCatalogModelEffort(
  catalog: CodexModelCatalogEntry[],
  model: string,
  effort?: string,
): CodexModelCatalogEntry {
  if (effort?.trim().toLowerCase() === "ultra")
    throw new Error(
      'effort "ultra" is unavailable in SwarmZ — Ultra is a multi-agent mode, not a single-agent reasoning level',
    );
  if (!catalog.length)
    throw new Error(
      "the live Codex model catalog is unavailable — retry list_models before choosing an explicit model",
    );
  const entry = catalogModel(catalog, model);
  if (!entry) {
    const available = catalog.map((item) => item.model).join(", ");
    throw new Error(
      `model "${model}" is not in the live Codex catalog (available: ${available || "none"})`,
    );
  }
  if (effort) {
    const supported = entry.supportedReasoningEfforts.map((item) => item.effort);
    if (supported.length && !supported.includes(effort))
      throw new Error(
        `effort "${effort}" is not supported by model "${entry.model}" (supported: ${supported.join(", ")})`,
      );
  }
  return entry;
}

/** Kick off the one-shot codex model-catalog fetch (no-op once loaded). */
export function ensureCodexModels(): void {
  useCodexModels.getState().ensure();
}
