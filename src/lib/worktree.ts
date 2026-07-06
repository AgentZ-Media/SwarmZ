// Git worktree support — branch-name generator + the native commands.
// Native-only direct `invoke` (skips the backend interface, like openrouter.ts
// and dnd.ts).
// Pure module on purpose: the store imports it, so it must not import the store.

import { invoke } from "@tauri-apps/api/core";
import type { WorktreeInfo, WorktreeScan, WorktreeStatus } from "@/types";

// ---- random branch names ----

const PREFIXES = [
  "amber", "ancient", "bold", "brave", "bright", "brisk", "calm", "cheery",
  "chilly", "clever", "cosmic", "crimson", "curious", "daring", "dashing",
  "dusty", "eager", "early", "electric", "fancy", "fearless", "fierce",
  "floating", "gentle", "gilded", "happy", "hazy", "hidden", "humble",
  "jolly", "keen", "lively", "lucky", "lunar", "mellow", "mighty", "misty",
  "noble", "polar", "proud", "quick", "quiet", "rapid", "rustic", "silent",
  "solar", "swift", "velvet", "wild", "witty",
];

const SUFFIXES = [
  "badger", "beacon", "comet", "condor", "coral", "crane", "delta", "dingo",
  "ember", "falcon", "fern", "finch", "fjord", "fox", "gecko", "glacier",
  "grove", "harbor", "heron", "ibis", "jaguar", "koala", "lagoon", "lark",
  "lemur", "lynx", "mango", "maple", "marmot", "meadow", "mesa", "nebula",
  "newt", "orchid", "osprey", "otter", "panda", "pebble", "pine", "quartz",
  "raven", "reef", "ridge", "river", "sparrow", "summit", "thistle", "tundra",
  "walrus", "wren",
];

/** `my-repo` from a repo folder name — lowercase, branch-safe. */
function repoSlug(repoName: string): string {
  const s = repoName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "repo";
}

/**
 * Random worktree branch like `swarmz/brave-falcon-7341` — repo name in
 * front, then prefix × suffix × a 4-digit code (the dialog's reroll button
 * just calls this again).
 */
export function generateBranchName(repoName: string): string {
  const pre = PREFIXES[Math.floor(Math.random() * PREFIXES.length)];
  const suf = SUFFIXES[Math.floor(Math.random() * SUFFIXES.length)];
  const num = 1000 + Math.floor(Math.random() * 9000);
  return `${repoSlug(repoName)}/${pre}-${suf}-${num}`;
}

// ---- native commands ----

/**
 * Create `<repo>/.worktrees/<slug>` on a new branch off the current HEAD.
 * `cwd` may be anywhere inside the repo (also inside another worktree) — the
 * backend resolves the main root. With `copyEnv` every untracked file of the
 * main checkout (.env, local configs, …) is copied over, minus the
 * heavyweight cache/build dirs. Rejects with a readable git error message.
 */
export function addWorktree(args: {
  cwd: string;
  branch: string;
  copyEnv: boolean;
  gitBin?: string;
}): Promise<WorktreeInfo> {
  return invoke<WorktreeInfo>("worktree_add", {
    cwd: args.cwd,
    branch: args.branch,
    copyEnv: args.copyEnv,
    bin: args.gitBin,
  });
}

/** Would closing this worktree lose work? (dirty files / local-only commits) */
export function worktreeStatus(
  path: string,
  gitBin?: string,
): Promise<WorktreeStatus> {
  return invoke<WorktreeStatus>("worktree_status", { path, bin: gitBin });
}

/** Remove worktree folder + branch. Callers gate this on status/confirmation. */
export function removeWorktree(args: {
  root: string;
  path: string;
  branch: string;
  gitBin?: string;
}): Promise<void> {
  return invoke<void>("worktree_remove", {
    root: args.root,
    path: args.path,
    branch: args.branch,
    bin: args.gitBin,
  });
}

/** All SwarmZ worktrees of the given repo roots, with live status, plus
 * which roots actually scanned (see WorktreeScan). */
export function listWorktrees(
  roots: string[],
  gitBin?: string,
): Promise<WorktreeScan> {
  return invoke<WorktreeScan>("worktree_list", { roots, bin: gitBin });
}
