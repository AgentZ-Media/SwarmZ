import { invoke } from "@tauri-apps/api/core";
import { useSwarm } from "@/store";
import type { NoteItem } from "@/types";
import { fetchGitInfo } from "@/lib/transport";
import { useProjects } from "@/lib/projects/store";
import { renderSessionTranscript } from "@/lib/vibe/transcript";
import { discoverProjects, projectDocs } from "./native";
import { fetchCodexModelCatalog } from "./models";
import { fleetSummaryLine, worktreeOccupancy } from "./snapshot";
import { listTimers } from "./timers";
import { describeRemaining } from "./timers-core";
import type { ToolNoteItem } from "./types";
import type { ExecutorFamily } from "./executor-types";
import {
  allowedProjectNotePaths,
  fleetSessions,
  requireProject,
  requireSession,
} from "./executor-agents";
import { gitBin, redactRemoteUrl } from "./executor-guards";

type SensingTool =
  | "fleet_snapshot"
  | "read_agent"
  | "read_project_docs"
  | "read_notes"
  | "git_status"
  | "list_files"
  | "read_file"
  | "list_projects"
  | "list_models";

function stripNotes(items: NoteItem[]): ToolNoteItem[] {
  return items.map((note) => ({ text: note.text, done: note.done }));
}

export const sensingExecutors: ExecutorFamily<SensingTool> = {
  fleet_snapshot: async (_args, ctx) => {
    const sessions = fleetSessions(ctx.projectId);
    const project = ctx.projectId
      ? (useProjects.getState().projects[ctx.projectId] ?? null)
      : null;
    const now = Date.now();
    const timers = ctx.projectId
      ? listTimers(ctx.projectId).map((timer) => ({
          id: timer.id,
          note: timer.note,
          fires_at: new Date(timer.at).toISOString(),
          remaining: describeRemaining(timer.at, now),
        }))
      : [];
    return {
      project: project
        ? { id: project.id, name: project.name, dir: project.dir }
        : null,
      summary: fleetSummaryLine(sessions),
      sessions,
      worktrees: worktreeOccupancy(sessions),
      timers,
    };
  },

  read_agent: async (args, ctx) => {
    const entry = requireSession(args.agent, ctx);
    const items = entry.order
      .map((id) => entry.items[id])
      .filter((item): item is NonNullable<typeof item> => !!item);
    const tail =
      typeof args.tail_messages === "number" ? args.tail_messages : undefined;
    return {
      agent: {
        id: entry.session.id,
        name: entry.session.name,
        cwd: entry.session.projectDir,
        model: entry.session.model ?? null,
        effort: entry.session.effort ?? null,
        access: entry.session.access,
        worktree: entry.session.worktree,
      },
      transcript: renderSessionTranscript(items, { tail }),
    };
  },

  read_project_docs: async (args, ctx) => {
    const hasAgent = typeof args.agent === "string" && args.agent.trim();
    const hasPath = typeof args.path === "string" && args.path.trim();
    if (!!hasAgent === !!hasPath)
      throw new Error('exactly one of "agent" or "path" is required');
    const root = hasAgent
      ? requireSession(args.agent, ctx).session.projectDir
      : (args.path as string).trim();
    if (!root)
      throw new Error('the agent has no working directory — pass "path" instead');
    return projectDocs(root);
  },

  read_notes: async (_args, ctx) => {
    const { quickNotes } = useSwarm.getState();
    const allowed = allowedProjectNotePaths(ctx);
    const folders: Record<string, ToolNoteItem[]> = {};
    if (allowed) {
      for (const [path, items] of Object.entries(quickNotes.folders)) {
        if (allowed.has(path.replace(/\/+$/, ""))) folders[path] = stripNotes(items);
      }
    }
    return { global: stripNotes(quickNotes.global), folders };
  },

  git_status: async (args, ctx) => {
    const hasAgent = typeof args.agent === "string" && args.agent.trim();
    const hasPath = typeof args.path === "string" && args.path.trim();
    if (!!hasAgent === !!hasPath)
      throw new Error('exactly one of "agent" or "path" is required');
    let cwd: string;
    let agent: { id: string; name: string } | null = null;
    if (hasAgent) {
      const entry = requireSession(args.agent, ctx);
      cwd = entry.session.projectDir;
      agent = { id: entry.session.id, name: entry.session.name };
    } else {
      cwd = (args.path as string).trim();
    }
    const git = await fetchGitInfo(cwd, gitBin()).catch(() => null);
    if (!git)
      return { agent, cwd, git: null, note: `not a git repository: ${cwd}` };
    return {
      agent,
      cwd,
      git: {
        repo: git.repo,
        branch: git.branch,
        insertions: git.insertions,
        deletions: git.deletions,
        untracked: git.untracked,
        dirty: git.insertions + git.deletions + git.untracked > 0,
        remote_url: redactRemoteUrl(git.remote_url),
      },
    };
  },

  list_files: async (args, ctx) => {
    const { dir } = requireProject(ctx);
    const path = typeof args.path === "string" ? args.path : "";
    const depth =
      typeof args.depth === "number" && Number.isFinite(args.depth)
        ? Math.max(1, Math.min(3, Math.trunc(args.depth)))
        : 2;
    return invoke("conductor_fs_list", { projectDir: dir, path, depth });
  },

  read_file: async (args, ctx) => {
    const { dir } = requireProject(ctx);
    return invoke("conductor_fs_read", {
      projectDir: dir,
      path: String(args.path ?? ""),
    });
  },

  list_projects: async (args) => {
    const scanRoots = Array.isArray(args.scan_roots)
      ? args.scan_roots.filter((root): root is string => typeof root === "string")
      : (useSwarm.getState().settings.orchestratorScanRoots ?? []);
    return discoverProjects(scanRoots);
  },

  list_models: async () => {
    const models = await fetchCodexModelCatalog(true);
    return {
      catalog_default: models.find((entry) => entry.isDefault)?.model ?? null,
      models,
      note: "Use the exact model value and one of that model's supportedReasoningEfforts. Omit model to use the user's Codex configuration.",
    };
  },
};
