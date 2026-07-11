// Orchestrator sensing commands — native-only direct `invoke` wrappers, same
// pattern as lib/worktree.ts. All read-only.

import { invoke } from "@tauri-apps/api/core";
import { useSwarm, type SwarmState } from "@/store";
import { useVibe } from "@/lib/vibe/session-store";
import { useProjects } from "@/lib/projects/store";
import type {
  ConductorPlanDocument,
  ConductorPlanInfo,
  KnownFolder,
  ProjectDocs,
  ProjectEntry,
  TranscriptView,
} from "./types";

/**
 * Read the readable tail of a codex session file on disk (user/assistant
 * text, tool one-liners). The backend seek-tails huge files — safe to call
 * against any session size. (The orchestrator's read_agent tool renders
 * live sessions from the store instead — this reads rollout files.)
 */
export function readTranscript(args: {
  sessionId: string;
  /** return the LAST n messages (default 20) */
  tailMessages?: number;
  /** hard cap on bytes read from the file end (default 1 MiB) */
  maxBytes?: number;
  /** also extract the session's first real user message (default true) */
  includeFirstUserMessage?: boolean;
}): Promise<TranscriptView> {
  return invoke<TranscriptView>("transcript_read", {
    sessionId: args.sessionId,
    tailMessages: args.tailMessages,
    maxBytes: args.maxBytes,
    includeFirstUserMessage: args.includeFirstUserMessage,
  });
}

/**
 * README.md / AGENTS.md / CLAUDE.md of a project root (capped per file and in
 * total; missing files omitted). Worktree paths resolve to the main repo.
 */
export function projectDocs(root: string): Promise<ProjectDocs> {
  return invoke<ProjectDocs>("project_docs", { root });
}

/**
 * List the plan documents the Conductor wrote under `<projectDir>/.swarmz/plans/`
 * (read-only; same slug-confined area as the `list_plans` tool). Newest first
 * is up to the caller — the Rust command returns them as found.
 */
export function listPlans(projectDir: string): Promise<ConductorPlanInfo[]> {
  return invoke<ConductorPlanInfo[]>("conductor_plan_list", { projectDir });
}

/** Read one plan document's Markdown content (read-only; `read_plan` tool). */
export function readPlan(
  projectDir: string,
  slug: string,
): Promise<ConductorPlanDocument> {
  return invoke<ConductorPlanDocument>("conductor_plan_read", {
    projectDir,
    slug,
  });
}

/**
 * Every folder the app already knows about, deduped — what makes
 * `discover_projects` see projects the jsonl history alone wouldn't.
 */
export function collectKnownFolders(state: SwarmState): KnownFolder[] {
  const known: KnownFolder[] = [];
  const seen = new Set<string>();
  const add = (path: string | undefined, source: string) => {
    const p = path?.trim();
    if (!p || seen.has(p)) return;
    seen.add(p);
    known.push({ path: p, source });
  };
  // project tabs (open AND closed — a closed tab is still a known folder)
  const projects = useProjects.getState();
  for (const id of projects.order) add(projects.projects[id]?.dir, "project");
  // live session project dirs
  const vibe = useVibe.getState();
  for (const id of vibe.order)
    add(vibe.sessions[id]?.session.projectDir, "session");
  for (const folder of Object.keys(state.quickNotes.folders))
    add(folder, "notes");
  for (const root of state.settings.worktreeRepos ?? [])
    add(root, "worktree-repo");
  add(state.settings.lastCwd, "last-used");
  return known;
}

/**
 * Discover project folders: Codex session history + the app's known folders
 * (collected from the live stores) + an optional shallow scan of `scanRoots`
 * for git repos. Sorted by last activity, most recent first.
 */
export function discoverProjects(
  scanRoots: string[] = [],
): Promise<ProjectEntry[]> {
  const known = collectKnownFolders(useSwarm.getState());
  return invoke<ProjectEntry[]>("discover_projects", { scanRoots, known });
}
