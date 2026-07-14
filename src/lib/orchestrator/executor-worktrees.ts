import { invoke } from "@tauri-apps/api/core";
import type { VibeSessionEntry } from "@/lib/vibe/session-store";
import { listWorktrees } from "@/lib/worktree";
import { orderedSessions, requireProject, type ToolCallContext } from "./executor-agents";
import { gitBin } from "./executor-guards";

export function samePath(left: string, right: string): boolean {
  return left.replace(/\/+$/, "") === right.replace(/\/+$/, "");
}

export function sessionsInPath(path: string): VibeSessionEntry[] {
  return orderedSessions(null).filter((entry) =>
    samePath(entry.session.projectDir, path),
  );
}

export function busyLaneBlocker(
  entries: readonly VibeSessionEntry[],
  path: string,
  targetSessionId: string,
  busy: Readonly<Record<string, boolean>>,
): VibeSessionEntry | null {
  return entries.find((entry) =>
    entry.session.id !== targetSessionId &&
    samePath(entry.session.projectDir, path) &&
    busy[entry.session.id],
  ) ?? null;
}

/** Mutating worktree operations must never split a lock through path aliases. */
export function canonicalizePath(path: string): Promise<string> {
  return invoke<string>("canonicalize_path", { path });
}

export async function findWorktreeEntry(
  path: string,
  ctx: ToolCallContext,
) {
  const { dir } = requireProject(ctx);
  const canonical = await canonicalizePath(path);
  const scan = await listWorktrees([dir], gitBin());
  return (
    scan.entries.find(
      (entry) => samePath(entry.path, canonical) || samePath(entry.path, path),
    ) ?? null
  );
}

const worktreeLocks = new Map<string, Promise<unknown>>();

export async function withWorktreeLock<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = (await canonicalizePath(path)).replace(/\/+$/, "");
  const tail = worktreeLocks.get(key) ?? Promise.resolve();
  const run = tail.then(fn, fn);
  const tracked = run.catch(() => {});
  worktreeLocks.set(key, tracked);
  try {
    return await run;
  } finally {
    // Do not delete a newer waiter that was appended while this operation
    // ran. Once the final waiter settles, the key is released completely.
    if (worktreeLocks.get(key) === tracked) worktreeLocks.delete(key);
  }
}
