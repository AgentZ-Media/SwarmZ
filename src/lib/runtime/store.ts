import { create } from "zustand";
import { loadRuntimeEnvironments, saveRuntimeEnvironments } from "@/lib/transport";
import { createPersistenceCoordinator } from "@/lib/persistence/coordinator";
import {
  validateRuntimeEnvironment,
  type PersistedRuntimeEnvironments,
  type RuntimeEnvironmentSpec,
} from "./core";

interface RuntimeEnvironmentState extends PersistedRuntimeEnvironments {
  hydrated: boolean;
  hydrateError: string | null;
  hydrate: () => Promise<void>;
  upsert: (projectId: string, spec: RuntimeEnvironmentSpec) => Promise<void>;
  remove: (projectId: string, environmentId: string) => Promise<void>;
  select: (projectId: string, environmentId: string | null) => Promise<void>;
}

function validProjectId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(value);
}

/** Parse the durable payload fail-soft, dropping unknown/invalid/duplicate specs. */
export function sanitizePersistedRuntimeEnvironments(
  input: unknown,
): PersistedRuntimeEnvironments {
  const empty: PersistedRuntimeEnvironments = {
    version: 1,
    byProject: {},
    selectedByProject: {},
  };
  if (!input || typeof input !== "object") return empty;
  const value = input as Partial<PersistedRuntimeEnvironments>;
  if (!value.byProject || typeof value.byProject !== "object") return empty;
  const byProject: Record<string, RuntimeEnvironmentSpec[]> = {};
  for (const [projectId, rawSpecs] of Object.entries(value.byProject)) {
    if (!validProjectId(projectId) || !Array.isArray(rawSpecs)) continue;
    const ids = new Set<string>();
    const specs: RuntimeEnvironmentSpec[] = [];
    for (const candidate of rawSpecs.slice(0, 32)) {
      if (!candidate || typeof candidate !== "object") continue;
      const spec = candidate as RuntimeEnvironmentSpec;
      try {
        const validation = validateRuntimeEnvironment(spec);
        if (!validation.valid || ids.has(spec.id)) continue;
        ids.add(spec.id);
        // JSON clone strips prototypes and ensures only data crosses into state.
        specs.push(JSON.parse(JSON.stringify(spec)) as RuntimeEnvironmentSpec);
      } catch {
        // Malformed nested values are ignored; valid siblings still hydrate.
      }
    }
    if (specs.length > 0) byProject[projectId] = specs;
  }
  const selectedByProject: Record<string, string | null> = {};
  if (value.selectedByProject && typeof value.selectedByProject === "object") {
    for (const [projectId, selection] of Object.entries(value.selectedByProject)) {
      if (!validProjectId(projectId)) continue;
      const specs = byProject[projectId] ?? [];
      selectedByProject[projectId] =
        typeof selection === "string" && specs.some((spec) => spec.id === selection)
          ? selection
          : specs[0]?.id ?? null;
    }
  }
  for (const [projectId, specs] of Object.entries(byProject)) {
    selectedByProject[projectId] ??= specs[0]?.id ?? null;
  }
  return { version: 1, byProject, selectedByProject };
}

function snapshot(): PersistedRuntimeEnvironments {
  const state = useRuntimeEnvironments.getState();
  return {
    version: 1,
    byProject: state.byProject,
    selectedByProject: state.selectedByProject,
  };
}

const runtimePersistence = createPersistenceCoordinator({
  name: "runtimeEnvironments",
  debounceMs: 0,
  snapshot,
  save: saveRuntimeEnvironments,
});

async function persistNow(): Promise<void> {
  runtimePersistence.schedule();
  await runtimePersistence.flush();
  const health = runtimePersistence.health();
  if (health.write === "failed") {
    throw health.error instanceof Error
      ? health.error
      : new Error("Runtime Environment store could not be saved");
  }
}

function requireHydrated(): void {
  const state = useRuntimeEnvironments.getState();
  if (!state.hydrated) {
    throw new Error(state.hydrateError ?? "runtime environment store is not ready");
  }
}

export const useRuntimeEnvironments = create<RuntimeEnvironmentState>((set, get) => ({
  version: 1,
  byProject: {},
  selectedByProject: {},
  hydrated: false,
  hydrateError: null,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const persisted = sanitizePersistedRuntimeEnvironments(await loadRuntimeEnvironments());
      set({ ...persisted, hydrated: true, hydrateError: null });
      runtimePersistence.hydrationSucceeded();
    } catch (error) {
      runtimePersistence.hydrationFailed(error);
      set({
        hydrated: false,
        hydrateError: error instanceof Error ? error.message : "Runtime store could not be read",
      });
      throw error;
    }
  },

  upsert: async (projectId, spec) => {
    requireHydrated();
    if (!validProjectId(projectId)) throw new Error("invalid project id");
    const validation = validateRuntimeEnvironment(spec);
    if (!validation.valid) throw new Error(validation.errors.join("; "));
    const current = get().byProject[projectId] ?? [];
    const index = current.findIndex((item) => item.id === spec.id);
    const next = [...current];
    if (index >= 0) next[index] = spec;
    else {
      if (next.length >= 32) throw new Error("runtime environment cap is 32 per project");
      next.push(spec);
    }
    set((state) => ({
      byProject: { ...state.byProject, [projectId]: next },
      selectedByProject: {
        ...state.selectedByProject,
        [projectId]: state.selectedByProject[projectId] ?? spec.id,
      },
    }));
    await persistNow();
  },

  remove: async (projectId, environmentId) => {
    requireHydrated();
    const next = (get().byProject[projectId] ?? []).filter((spec) => spec.id !== environmentId);
    set((state) => ({
      byProject: { ...state.byProject, [projectId]: next },
      selectedByProject: {
        ...state.selectedByProject,
        [projectId]: next.some((spec) => spec.id === state.selectedByProject[projectId])
          ? state.selectedByProject[projectId] ?? null
          : next[0]?.id ?? null,
      },
    }));
    await persistNow();
  },

  select: async (projectId, environmentId) => {
    requireHydrated();
    if (
      environmentId !== null &&
      !(get().byProject[projectId] ?? []).some((spec) => spec.id === environmentId)
    )
      throw new Error("runtime environment does not exist in this project");
    set((state) => ({
      selectedByProject: { ...state.selectedByProject, [projectId]: environmentId },
    }));
    await persistNow();
  },
}));

export async function hydrateRuntimeEnvironments(): Promise<void> {
  await useRuntimeEnvironments.getState().hydrate();
}

export async function flushRuntimeEnvironmentsPersist(): Promise<void> {
  await runtimePersistence.flush();
  const health = runtimePersistence.health();
  if (health.write === "failed") {
    throw health.error instanceof Error
      ? health.error
      : new Error("Runtime Environment store could not be saved");
  }
}

export function createDefaultRuntimeEnvironment(index = 1): RuntimeEnvironmentSpec {
  return {
    id: `local-${index}`,
    name: index === 1 ? "Local development" : `Local development ${index}`,
    setup: [],
    cleanup: [],
    services: [],
    secrets: [],
    databaseNamespacePrefix: "swarmz",
  };
}
