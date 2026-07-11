// GitHub state — a small standalone zustand store (the events.ts/limits.ts
// pattern), IN-MEMORY only: the local gh CLI is the source of truth, a
// restart just re-detects. Per project: repo info + open PRs (+ fetch state);
// globally: the gh auth digest and the Conductor's watched-PR sets.
//
// Selector contract (AGENTS.md): components select PRIMITIVES or stable
// references from here — the arrays/objects are replaced wholesale per fetch,
// so a stored reference is stable across getSnapshot calls.

import { create } from "zustand";
import type { GhAuthStatus, GhPr, GhRepoInfo } from "./types";

export type RepoStatus =
  | "unknown"
  | "loading"
  | "ok"
  | "not_installed"
  | "not_authenticated"
  | "no_remote"
  | "error";

export interface ProjectGithub {
  repoStatus: RepoStatus;
  /** message for repoStatus "error" */
  repoError: string | null;
  repo: GhRepoInfo | null;
  prs: GhPr[];
  /** last successful PR fetch, epoch ms (null = never) */
  prsFetchedAt: number | null;
  /**
   * PR-list fetch failure, tracked INDEPENDENTLY of the repo detection: a
   * rate-limited/failed `gh pr list` must not masquerade as "no open PRs"
   * (repo ok + empty list). null = the last PR fetch succeeded.
   */
  prsError: string | null;
}

export const EMPTY_PROJECT_GITHUB: ProjectGithub = {
  repoStatus: "unknown",
  repoError: null,
  repo: null,
  prs: [],
  prsFetchedAt: null,
  prsError: null,
};

interface GithubState {
  /** gh auth digest (null = not fetched yet) */
  auth: GhAuthStatus | null;
  /** per project id */
  byProject: Record<string, ProjectGithub>;
  /** PR numbers the Conductor watches, per project (in-memory, this app run) */
  watched: Record<string, number[]>;

  setAuth: (auth: GhAuthStatus) => void;
  patchProject: (projectId: string, patch: Partial<ProjectGithub>) => void;
  setWatched: (projectId: string, numbers: number[]) => void;
}

export const useGithub = create<GithubState>((set) => ({
  auth: null,
  byProject: {},
  watched: {},

  setAuth: (auth) => set({ auth }),

  patchProject: (projectId, patch) =>
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: {
          ...(s.byProject[projectId] ?? EMPTY_PROJECT_GITHUB),
          ...patch,
        },
      },
    })),

  setWatched: (projectId, numbers) =>
    set((s) => ({ watched: { ...s.watched, [projectId]: numbers } })),
}));

/** The project's github slice (stable reference; EMPTY for unknown ids). */
export function projectGithub(
  s: Pick<GithubState, "byProject">,
  projectId: string | null,
): ProjectGithub {
  return (projectId && s.byProject[projectId]) || EMPTY_PROJECT_GITHUB;
}

/** Is this PR number watched in the project? */
export function isWatched(
  s: Pick<GithubState, "watched">,
  projectId: string,
  number: number,
): boolean {
  return (s.watched[projectId] ?? []).includes(number);
}
