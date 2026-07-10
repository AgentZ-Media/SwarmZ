// Pure project-model logic — no store, no Tauri. The zustand store
// (store.ts in this folder) and the vibe hydration call into these; keeping
// them pure makes dedupe, naming and the schema-v2 session migration
// unit-testable (the chat-reuse.ts / snapshot.ts pattern).

import type { Project } from "@/types";

/**
 * Normalize a directory path into the DEDUPE KEY two dirs are compared by:
 * trimmed, trailing slashes stripped (the filesystem root stays "/").
 * Symlink resolution happens before this (the store canonicalizes via Rust);
 * this is the last, always-available normalization layer.
 */
export function normalizeDirKey(dir: string): string {
  const trimmed = dir.trim();
  if (!trimmed) return "";
  const stripped = trimmed.replace(/\/+$/, "");
  return stripped === "" ? "/" : stripped;
}

/**
 * Is `child` the same dir as `parent` or inside it? Segment-boundary-aware
 * (`/a/bc` is NOT within `/a/b`), on normalized keys — callers canonicalize
 * (symlinks, `/private` aliasing) BEFORE comparing when they can. Used by the
 * orchestrator's create_panes to keep sessions spawned into a subfolder of
 * the Conductor's project attached to that project.
 */
export function isDirWithin(parent: string, child: string): boolean {
  const p = normalizeDirKey(parent);
  const c = normalizeDirKey(child);
  if (!p || !c) return false;
  if (p === c) return true;
  const prefix = p === "/" ? "/" : `${p}/`;
  return c.startsWith(prefix);
}

/** Last path segment of a dir — the base for a project's display name. */
export function dirBasename(dir: string): string {
  const key = normalizeDirKey(dir);
  const seg = key.split("/").filter(Boolean).pop();
  return seg ?? key ?? "project";
}

/**
 * Collision-free display name for a new project: the folder basename, with
 * the lowest free numeric suffix when another project already uses it
 * ("api", "api 2", "api 3" — two different parents both named `api`).
 */
export function uniqueProjectName(
  dir: string,
  takenNames: Iterable<string>,
): string {
  const taken = new Set<string>();
  for (const n of takenNames) taken.add(n.trim().toLowerCase());
  const base = dirBasename(dir) || "project";
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`.toLowerCase())) n++;
  return `${base} ${n}`;
}

/** Open projects in tab order (ascending `order`, stable by createdAt). */
export function openProjectsSorted(projects: Iterable<Project>): Project[] {
  const open: Project[] = [];
  for (const p of projects) if (!p.closedAt) open.push(p);
  open.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  return open;
}

/**
 * Reorder one OPEN project to `toIndex` among the open tabs. Returns the
 * projects whose `order` changed (patch list); closed projects keep theirs.
 */
export function reorderOpenProject(
  projects: Iterable<Project>,
  id: string,
  toIndex: number,
): { id: string; order: number }[] {
  const open = openProjectsSorted(projects);
  const from = open.findIndex((p) => p.id === id);
  if (from < 0) return [];
  const to = Math.max(0, Math.min(open.length - 1, toIndex));
  if (from === to) return [];
  const next = [...open];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  const patches: { id: string; order: number }[] = [];
  next.forEach((p, i) => {
    if (p.order !== i) patches.push({ id: p.id, order: i });
  });
  return patches;
}

// ---- schema-v2 session migration ----

/** The slice of a session the migration needs. */
export interface MigratableSession {
  id: string;
  projectDir: string;
  /** null/"" = pre-v2 session without a project */
  projectId: string | null;
}

export interface SessionProjectMigration {
  /** projects to ADD (deduped per dir; open, appended to the tab order) */
  created: Project[];
  /** sessionId → projectId for every input session */
  assignments: Record<string, string>;
}

/**
 * Assign every session to a project (the v2 hydrate migration, also the
 * self-healing path for sessions whose project record was lost):
 *
 * - a session whose `projectId` exists keeps it;
 * - otherwise its `projectDir` is matched (normalized) against existing
 *   projects — including CLOSED ones (the sessions belong there and show up
 *   again when the tab reopens);
 * - otherwise a new OPEN project is created for the dir (deduped across the
 *   input sessions, named collision-free, appended to the tab order).
 *
 * Pure: `now` and `newId` are injected.
 */
export function assignSessionsToProjects(
  sessions: MigratableSession[],
  existing: Project[],
  now: number,
  newId: () => string,
): SessionProjectMigration {
  const byId = new Map(existing.map((p) => [p.id, p]));
  const byDir = new Map(existing.map((p) => [normalizeDirKey(p.dir), p]));
  const takenNames = new Set(existing.map((p) => p.name.toLowerCase()));
  let nextOrder =
    existing.reduce((m, p) => Math.max(m, p.order), -1) + 1;

  const created: Project[] = [];
  const createdByDir = new Map<string, Project>();
  const assignments: Record<string, string> = {};

  for (const s of sessions) {
    if (s.projectId && byId.has(s.projectId)) {
      assignments[s.id] = s.projectId;
      continue;
    }
    const key = normalizeDirKey(s.projectDir);
    const match = byDir.get(key) ?? createdByDir.get(key);
    if (match) {
      assignments[s.id] = match.id;
      continue;
    }
    const name = uniqueProjectName(key, takenNames);
    takenNames.add(name.toLowerCase());
    const project: Project = {
      id: newId(),
      dir: key,
      name,
      order: nextOrder++,
      lastActiveAt: now,
      createdAt: now,
      closedAt: null,
    };
    created.push(project);
    createdByDir.set(key, project);
    assignments[s.id] = project.id;
  }

  return { created, assignments };
}
