import { useSwarm } from "@/store";
import { useVibe } from "@/lib/vibe/session-store";
import { assignWorktreeToSession } from "@/lib/vibe/controller";
import {
  addWorktree,
  listWorktrees,
  removeWorktree,
  worktreeStatus,
} from "@/lib/worktree";
import type { ExecutorFamily } from "./executor-types";
import { requireProject, requireSession } from "./executor-agents";
import { gitBin } from "./executor-guards";
import {
  findWorktreeEntry,
  sessionsInPath,
  withWorktreeLock,
} from "./executor-worktrees";

type WorktreeTool =
  | "create_worktree"
  | "assign_worktree"
  | "worktree_status"
  | "cleanup_worktree";

export const worktreeExecutors: ExecutorFamily<WorktreeTool> = {
  create_worktree: async (args, ctx) => {
    const { dir } = requireProject(ctx);
    const branch =
      (typeof args.branch === "string" && args.branch.trim()) ||
      `swarm/lane-${1000 + Math.floor(Math.random() * 9000)}`;
    const info = await addWorktree({
      cwd: dir,
      branch,
      copyEnv: true,
      gitBin: gitBin(),
    });
    useSwarm.getState().registerWorktreeRepo(info.root);
    return {
      root: info.root,
      path: info.path,
      branch: info.branch,
      copied_env_files: info.copied,
    };
  },

  assign_worktree: async (args, ctx) => {
    const entry = requireSession(args.agent, ctx);
    const path = String(args.path ?? "").trim();
    if (!path) throw new Error("path must not be empty");
    return withWorktreeLock(path, async () => {
      const worktree = await findWorktreeEntry(path, ctx);
      if (!worktree)
        throw new Error(
          `no SwarmZ worktree at ${path} in this project — create one first (create_worktree / spawn_agents worktree:"new")`,
        );
      if (worktree.missing)
        throw new Error(`the worktree folder is gone: ${path}`);
      const others = sessionsInPath(worktree.path).filter(
        (candidate) => candidate.session.id !== entry.session.id,
      );
      const shared = others.length > 0;
      await assignWorktreeToSession(entry.session.id, {
        path: worktree.path,
        root: worktree.root,
        branch: worktree.branch,
        shared,
      });
      if (shared) {
        for (const other of others)
          useVibe.getState().setWorktreeShared(other.session.id, true);
      }
      return {
        agent: { id: entry.session.id, name: entry.session.name },
        path: worktree.path,
        branch: worktree.branch,
        shared,
        note: "the agent works there from its next turn on",
      };
    });
  },

  worktree_status: async (_args, ctx) => {
    const { dir } = requireProject(ctx);
    const scan = await listWorktrees([dir], gitBin());
    return {
      worktrees: scan.entries.map((entry) => ({
        path: entry.path,
        branch: entry.branch,
        dirty: entry.dirty,
        ahead: entry.ahead,
        ...(entry.ahead_unknown ? { ahead_unknown: true } : {}),
        missing: entry.missing,
        agents: sessionsInPath(entry.path).map((session) => session.session.name),
      })),
    };
  },

  cleanup_worktree: async (args, ctx) => {
    const path = String(args.path ?? "").trim();
    if (!path) throw new Error("path must not be empty");
    return withWorktreeLock(path, async () => {
      const worktree = await findWorktreeEntry(path, ctx);
      if (!worktree)
        throw new Error(`no SwarmZ worktree at ${path} in this project`);
      const occupants = sessionsInPath(worktree.path);
      if (occupants.length > 0)
        throw new Error(
          `refused: agent${occupants.length === 1 ? "" : "s"} ${occupants
            .map((entry) => `"${entry.session.name}"`)
            .join(", ")} still work${occupants.length === 1 ? "s" : ""} in this worktree — close or re-home them first`,
        );
      const status = await worktreeStatus(worktree.path, gitBin());
      if (status.exists && status.dirty)
        throw new Error(
          "refused: the worktree has uncommitted changes — commit, merge or explicitly discard them first (or ask the user)",
        );
      if (
        (status.exists && status.ahead_unknown) ||
        (!status.exists && worktree.ahead_unknown)
      )
        throw new Error(
          `refused: could not verify whether branch "${worktree.branch}" holds unmerged commits — resolve manually (or ask the user)`,
        );
      const ahead = status.exists ? status.ahead : worktree.ahead;
      if (ahead > 0)
        throw new Error(
          `refused: branch "${worktree.branch}" holds ${ahead} commit${ahead === 1 ? "" : "s"} no other branch has — merge or push it first (or ask the user)`,
        );
      await removeWorktree({
        root: worktree.root,
        path: worktree.path,
        branch: worktree.branch,
        force: false,
        gitBin: gitBin(),
      });
      void useSwarm.getState().refreshWorktrees();
      return { removed: true, path: worktree.path, branch: worktree.branch };
    });
  },
};
