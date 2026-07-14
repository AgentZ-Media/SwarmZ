// Project store (Phase 2 data layer) — the project tabs, a standalone
// zustand store like lib/vibe/session-store.ts. Persisted under the store
// key `projects` (debounced ~500 ms, flushed by flushAllPersists at quit,
// hydrated from store.ts hydrate() BEFORE the vibe sessions — the session
// migration assigns into this store).
//
// Closing a project only hides its tab (`closedAt` stamp) — its sessions
// stay in the session store; reopening the same folder (dedupe by canonical
// path) flips the SAME project open again, so they reappear. Pure logic
// (dedupe key, naming, reorder, the session migration) lives in ./core.ts.

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { nanoid } from "nanoid";
import { IS_TAURI, loadProjects, saveProjects } from "@/lib/transport";
import {
  createPersistenceCoordinator,
  type HydrationStatus,
} from "@/lib/persistence/coordinator";
import type { PersistedProjects, Project } from "@/types";
import {
  assignSessionsToProjects,
  normalizeDirKey,
  openProjectsSorted,
  reorderOpenProject,
  uniqueProjectName,
  type MigratableSession,
} from "./core";

/**
 * Resolve a dir to its canonical form (symlinks, `/private` aliasing) via
 * Rust — the strong half of the dedupe key. Falls back to the plain
 * normalized path outside Tauri or when canonicalization fails (folder
 * gone), so opening a project never hard-fails on the resolver.
 */
async function canonicalDir(dir: string): Promise<string> {
  const key = normalizeDirKey(dir);
  if (!key || !IS_TAURI) return key;
  try {
    const canon = await invoke<string>("canonicalize_path", { path: key });
    return normalizeDirKey(canon) || key;
  } catch {
    return key;
  }
}

function snapshot(): PersistedProjects {
  const s = useProjects.getState();
  return {
    version: 1,
    projects: s.order
      .map((id) => s.projects[id])
      .filter((p): p is Project => !!p),
    activeId: s.activeProjectId,
  };
}

const persistence = createPersistenceCoordinator({
  name: "projects",
  debounceMs: 500,
  snapshot,
  save: saveProjects,
});

function schedulePersist() {
  persistence.schedule();
}

/** Write the pending debounce NOW — called from flushAllPersists at quit. */
export async function flushProjectsPersist(): Promise<void> {
  await persistence.flush();
}

export interface ProjectsState {
  /** projects by id — open AND closed (closed = hidden tab, sessions kept) */
  projects: Record<string, Project>;
  /** stable id order (persistence order, not tab order — that's `order`) */
  order: string[];
  activeProjectId: string | null;
  /** true once hydrate() SUCCEEDED (incl. a fresh install with no persisted
   * data) — consumers that migrate against this store (the chat→project
   * assignment) must not run while this is false: a transient load failure
   * would otherwise read as "no projects exist" and strip every
   * chat→project link. In-memory, never persisted. */
  hydrated: boolean;
  /** Explicit read health. `failed` keeps persistence write-gated. */
  hydrateStatus: HydrationStatus;
  hydrateError: string | null;

  /**
   * Open a project for a folder: dedupe by canonical path — an existing
   * project (even a closed one) is reopened, otherwise a new one is created
   * (name = folder basename with a collision suffix). Returns the project
   * id. `activate` (default true) also makes it the active tab.
   */
  openProject: (dir: string, opts?: { activate?: boolean }) => Promise<string>;
  /**
   * Close a project TAB — the project entity and its sessions stay; only
   * `closedAt` is stamped, and the active tab moves to the nearest neighbor.
   */
  closeProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;
  /** activate a tab (reopens it when closed) + stamp lastActiveAt */
  setActiveProject: (id: string) => void;
  /** move an open tab to `toIndex` among the open tabs */
  moveProject: (id: string, toIndex: number) => void;

  /**
   * Assign sessions to projects (the schema-v2 hydrate migration + the
   * self-heal for lost project records): creates deduped OPEN projects for
   * unknown dirs and returns sessionId → projectId. Synchronous — dirs are
   * matched by normalized path (they were written by the same pickers).
   */
  adoptSessions: (sessions: MigratableSession[]) => Record<string, string>;

  // lifecycle
  hydrate: () => Promise<void>;
}

/** Open projects in tab order — the primitive the tab strip renders from. */
export function openProjectIds(s: ProjectsState): string[] {
  return openProjectsSorted(Object.values(s.projects)).map((p) => p.id);
}

function nextOrder(projects: Record<string, Project>): number {
  let max = -1;
  for (const p of Object.values(projects)) max = Math.max(max, p.order);
  return max + 1;
}

/** The open project the active tab should fall back to (most recent). */
function fallbackActive(projects: Record<string, Project>): string | null {
  const open = openProjectsSorted(Object.values(projects));
  if (open.length === 0) return null;
  return open.reduce((a, b) => (b.lastActiveAt > a.lastActiveAt ? b : a)).id;
}

export const useProjects = create<ProjectsState>((set, get) => ({
  projects: {},
  order: [],
  activeProjectId: null,
  hydrated: false,
  hydrateStatus: "pending",
  hydrateError: null,

  openProject: async (dir, opts) => {
    const canon = await canonicalDir(dir);
    if (!canon) throw new Error("project folder must not be empty");
    const state = get();
    const key = normalizeDirKey(canon);
    const existing = Object.values(state.projects).find(
      (p) => normalizeDirKey(p.dir) === key,
    );
    const activate = opts?.activate ?? true;
    const now = Date.now();
    if (existing) {
      set((s) => ({
        projects: {
          ...s.projects,
          [existing.id]: {
            ...existing,
            closedAt: null,
            ...(activate ? { lastActiveAt: now } : {}),
          },
        },
        ...(activate ? { activeProjectId: existing.id } : {}),
      }));
      schedulePersist();
      return existing.id;
    }
    const project: Project = {
      id: nanoid(8),
      dir: canon,
      name: uniqueProjectName(
        canon,
        Object.values(state.projects).map((p) => p.name),
      ),
      order: nextOrder(state.projects),
      lastActiveAt: now,
      createdAt: now,
      closedAt: null,
    };
    set((s) => ({
      projects: { ...s.projects, [project.id]: project },
      order: [...s.order, project.id],
      ...(activate ? { activeProjectId: project.id } : {}),
    }));
    schedulePersist();
    return project.id;
  },

  closeProject: (id) => {
    const state = get();
    const project = state.projects[id];
    if (!project || project.closedAt) return;
    // pick the neighbor BEFORE closing (position among the open tabs)
    let nextActive = state.activeProjectId;
    if (state.activeProjectId === id) {
      const open = openProjectsSorted(Object.values(state.projects));
      const idx = open.findIndex((p) => p.id === id);
      const neighbors = open.filter((p) => p.id !== id);
      nextActive =
        neighbors[Math.min(Math.max(idx, 0), neighbors.length - 1)]?.id ?? null;
    }
    set((s) => ({
      projects: {
        ...s.projects,
        [id]: { ...project, closedAt: Date.now() },
      },
      activeProjectId: nextActive,
    }));
    schedulePersist();
  },

  renameProject: (id, name) => {
    const trimmed = name.trim();
    const project = get().projects[id];
    if (!project || !trimmed || project.name === trimmed) return;
    set((s) => ({
      projects: { ...s.projects, [id]: { ...project, name: trimmed } },
    }));
    schedulePersist();
  },

  setActiveProject: (id) => {
    const project = get().projects[id];
    if (!project) return;
    set((s) => ({
      projects: {
        ...s.projects,
        [id]: { ...project, closedAt: null, lastActiveAt: Date.now() },
      },
      activeProjectId: id,
    }));
    schedulePersist();
  },

  moveProject: (id, toIndex) => {
    const state = get();
    const patches = reorderOpenProject(
      Object.values(state.projects),
      id,
      toIndex,
    );
    if (patches.length === 0) return;
    const projects = { ...state.projects };
    for (const { id: pid, order } of patches) {
      projects[pid] = { ...projects[pid], order };
    }
    set({ projects });
    schedulePersist();
  },

  adoptSessions: (sessions) => {
    if (sessions.length === 0) return {};
    const state = get();
    const { created, assignments } = assignSessionsToProjects(
      sessions,
      state.order
        .map((id) => state.projects[id])
        .filter((p): p is Project => !!p),
      Date.now(),
      () => nanoid(8),
    );
    if (created.length > 0) {
      const projects = { ...state.projects };
      for (const p of created) projects[p.id] = p;
      set({
        projects,
        order: [...state.order, ...created.map((p) => p.id)],
        activeProjectId: state.activeProjectId ?? fallbackActive(projects),
      });
      schedulePersist();
    }
    return assignments;
  },

  hydrate: async () => {
    let data: PersistedProjects | null = null;
    try {
      data = await loadProjects();
    } catch (error) {
      // load failed — `hydrated` stays false, downstream migrations skip
      persistence.hydrationFailed(error);
      set({
        hydrateStatus: "failed",
        hydrateError: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!data) {
      // fresh install: nothing persisted IS a successful hydration
      set({ hydrated: true, hydrateStatus: "ready", hydrateError: null });
      persistence.hydrationSucceeded();
      return;
    }
    // null-prototype map + own-property checks: a persisted id like
    // "__proto__" must neither pollute the map nor pass the active lookup
    const hasOwn = (o: object, k: string) =>
      Object.prototype.hasOwnProperty.call(o, k);
    const projects: Record<string, Project> = Object.create(null);
    const order: string[] = [];
    for (const raw of Array.isArray(data.projects) ? data.projects : []) {
      const p = sanitizeProject(raw);
      if (!p || hasOwn(projects, p.id)) continue;
      projects[p.id] = p;
      order.push(p.id);
    }
    const state = get();
    // a project opened before hydrate resolved wins (kept on top of persisted)
    for (const id of state.order) {
      if (!hasOwn(projects, id) && state.projects[id]) {
        projects[id] = state.projects[id];
        order.push(id);
      }
    }
    const persistedActive =
      typeof data.activeId === "string" && hasOwn(projects, data.activeId)
        ? data.activeId
        : null;
    const active = state.activeProjectId ?? persistedActive;
    set({
      projects,
      order,
      activeProjectId:
        active && hasOwn(projects, active) && !projects[active].closedAt
          ? active
          : fallbackActive(projects),
      hydrated: true,
      hydrateStatus: "ready",
      hydrateError: null,
    });
    persistence.hydrationSucceeded();
  },
}));

/** One persisted project, hardened field by field. */
function sanitizeProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string" || typeof p.dir !== "string") return null;
  const dir = normalizeDirKey(p.dir);
  if (!dir) return null;
  return {
    id: p.id,
    dir,
    name:
      typeof p.name === "string" && p.name.trim()
        ? p.name.trim()
        : dir.split("/").filter(Boolean).pop() || dir,
    order: typeof p.order === "number" && Number.isFinite(p.order) ? p.order : 0,
    lastActiveAt: typeof p.lastActiveAt === "number" ? p.lastActiveAt : 0,
    createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now(),
    closedAt: typeof p.closedAt === "number" ? p.closedAt : null,
  };
}

/** Hydrate entry point used by store.ts (kept symmetric with the other slices). */
export async function hydrateProjects(): Promise<void> {
  await useProjects.getState().hydrate();
}
