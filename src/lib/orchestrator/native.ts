// Orchestrator sensing commands (Phase 1) — native-only direct `invoke`
// wrappers, same pattern as lib/worktree.ts. All read-only.

import { invoke } from "@tauri-apps/api/core";
import { useSwarm, type SwarmState } from "@/store";
import type { AgentRuntime, PresetLayoutNode } from "@/types";
import type {
  KnownFolder,
  ProjectDocs,
  ProjectEntry,
  TranscriptView,
} from "./types";

/**
 * Read the readable tail of an agent session (user/assistant text, tool
 * one-liners, compaction summaries, the first user prompt). The backend
 * seek-tails huge files — safe to call against any session size.
 */
export function readTranscript(args: {
  cwd: string;
  sessionId: string;
  runtime: AgentRuntime | string;
  /** return the LAST n messages (default 20) */
  tailMessages?: number;
  /** hard cap on bytes read from the file end (default 1 MiB) */
  maxBytes?: number;
  /** also extract the session's first real user message (default true) */
  includeFirstUserMessage?: boolean;
}): Promise<TranscriptView> {
  return invoke<TranscriptView>("transcript_read", {
    cwd: args.cwd,
    sessionId: args.sessionId,
    runtime: args.runtime,
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

/** Every preset pane cwd in a preset layout tree. */
function presetCwds(node: PresetLayoutNode, out: string[]): void {
  if (node.type === "pane") {
    if (node.cwd) out.push(node.cwd);
    return;
  }
  for (const child of node.children) presetCwds(child, out);
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
  for (const id of state.workspaceOrder)
    add(state.workspaces[id]?.defaultCwd, "workspace");
  for (const profile of state.profiles) add(profile.defaultCwd, "profile");
  for (const preset of state.workspacePresets) {
    const cwds: string[] = [];
    presetCwds(preset.layout, cwds);
    for (const cwd of cwds) add(cwd, "preset");
  }
  for (const folder of Object.keys(state.quickNotes.folders))
    add(folder, "notes");
  for (const root of state.settings.worktreeRepos ?? [])
    add(root, "worktree-repo");
  add(state.settings.lastCwd, "last-used");
  return known;
}

/**
 * Discover project folders: Claude/Codex session history + the app's known
 * folders (collected from the live store) + an optional shallow scan of
 * `scanRoots` for git repos. Sorted by last activity, most recent first.
 */
export function discoverProjects(
  scanRoots: string[] = [],
): Promise<ProjectEntry[]> {
  const known = collectKnownFolders(useSwarm.getState());
  return invoke<ProjectEntry[]>("discover_projects", { scanRoots, known });
}
