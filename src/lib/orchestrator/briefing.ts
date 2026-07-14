// Workspace briefing for conductor-spawned agents — the PURE builder of the
// context preamble that precedes an agent's first task when it works in a git
// worktree. Without it the agent's only hint is its cwd (…/.worktrees/<slug>):
// it does not know the main checkout exists, that untracked files were copied
// in, or that dependency dirs were not — a class of confusion (relative-path
// assumptions, "why is node_modules missing?", stray reads of the main repo)
// this preamble eliminates. Unit-tested; the impure caller is
// executors.ts::spawnOneAgent.

import { clip } from "./triggers-core";

export interface WorktreeBriefingInput {
  /** the agent's cwd — the worktree checkout */
  worktreePath: string;
  /** the worktree's branch */
  branch: string;
  /** the main repository root the worktree belongs to */
  mainRepoRoot: string;
  /** true = other agents work in the same worktree (one writer at a time) */
  shared: boolean;
}

/**
 * The context preamble for an agent placed in a worktree. Every interpolated
 * field is single-line-flattened (`clip`) and JSON-quoted — paths/branches are
 * system-produced, but a folder name is still user-controlled input and must
 * never be able to fabricate a structural line in the agent's brief.
 */
export function worktreeBriefing(w: WorktreeBriefingInput): string {
  const worktree = JSON.stringify(clip(w.worktreePath, 300));
  const branch = JSON.stringify(clip(w.branch, 120));
  const root = JSON.stringify(clip(w.mainRepoRoot, 300));
  const lines = [
    `[workspace] You work in a git WORKTREE, not the main checkout: ${worktree} on branch ${branch}.`,
    `The main repository lives at ${root} — leave it untouched; all your work happens inside this worktree.`,
    "Untracked files (.env, local configs, keys) were copied in from the main checkout; dependency/build dirs (node_modules, target, dist, …) were NOT — install dependencies here first when your task needs builds, tests or a dev server.",
    "You may commit already-staged changes and push this worktree branch without asking when you use SwarmZ's exact safe Git forms below; staging and every other Git command stay approval-gated.",
    'Commit: git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.pager=cat -c protocol.allow=never -c commit.gpgSign=false commit --no-verify -m "<message>"',
    `Push: git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.pager=cat -c protocol.ext.allow=never -c core.sshCommand=ssh push -u origin ${branch}`,
  ];
  if (w.shared) {
    lines.push(
      "You SHARE this worktree with other agents — one writer at a time; keep commits small and report back before long-running rewrites.",
    );
  }
  return lines.join("\n");
}

/** Prepend the briefing (when any) to the agent's first task text. */
export function withWorktreeBriefing(
  task: string,
  w: WorktreeBriefingInput | null,
): string {
  if (!w) return task;
  return `${worktreeBriefing(w)}\n\n${task}`;
}
