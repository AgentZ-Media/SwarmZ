import type {
  ActiveLease,
  SchedulableTask,
  SchedulerReason,
} from "./types";

function normalize(value: string): string {
  return value
    .trim()
    .split("\\")
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map(normalize).filter(Boolean))].sort();
}

function globRegex(pattern: string): RegExp {
  let source = "^";
  const value = normalize(pattern);
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      // Character classes add little value to conflict prediction. Treat them
      // conservatively as one arbitrary path character rather than parsing an
      // attacker-controlled regular expression.
      const close = value.indexOf("]", index + 1);
      source += "[^/]";
      if (close >= 0) index = close;
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  source += "$";
  return new RegExp(source);
}

function hasWildcard(value: string): boolean {
  return /[*?[\]]/.test(value);
}

function staticPrefix(pattern: string): string {
  const value = normalize(pattern);
  const wildcard = value.search(/[*?[\]]/);
  return wildcard < 0 ? value : value.slice(0, wildcard);
}

function segmentPrefixCouldOverlap(left: string, right: string): boolean {
  const a = staticPrefix(left);
  const b = staticPrefix(right);
  if (!a || !b) return true;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Conservative glob intersection. It deliberately prefers a false-positive
 * serialization over letting two workers concurrently edit a possibly shared
 * file. Exact-file/glob checks remain precise for the common cases.
 */
export function pathIntentsOverlap(
  leftFiles: readonly string[],
  leftGlobs: readonly string[],
  rightFiles: readonly string[],
  rightGlobs: readonly string[],
): boolean {
  const aFiles = uniqueSorted(leftFiles);
  const bFiles = uniqueSorted(rightFiles);
  const aGlobs = uniqueSorted(leftGlobs);
  const bGlobs = uniqueSorted(rightGlobs);

  const bFileSet = new Set(bFiles);
  if (aFiles.some((file) => bFileSet.has(file))) return true;

  for (const file of aFiles) {
    if (bGlobs.some((glob) => globRegex(glob).test(file))) return true;
  }
  for (const file of bFiles) {
    if (aGlobs.some((glob) => globRegex(glob).test(file))) return true;
  }
  for (const left of aGlobs) {
    for (const right of bGlobs) {
      if (left === right) return true;
      if (!hasWildcard(left) && globRegex(right).test(left)) return true;
      if (!hasWildcard(right) && globRegex(left).test(right)) return true;
      if (segmentPrefixCouldOverlap(left, right)) return true;
    }
  }
  return false;
}

export function lockKeysForTask(candidate: SchedulableTask): string[] {
  const keys = uniqueSorted(
    (candidate.resourceKeys ?? []).map((key) => `resource:${key}`),
  );
  const worktree = normalize(candidate.worktreePath ?? "");
  if (worktree) keys.push(`worktree:${worktree}`);
  else keys.push(`root:${normalize(candidate.task.root.path)}`);
  return uniqueSorted(keys);
}

export function lockKeysForLease(lease: ActiveLease): string[] {
  const keys = uniqueSorted(lease.resourceKeys.map((key) => `resource:${key}`));
  const worktree = normalize(lease.worktreePath ?? "");
  if (worktree) keys.push(`worktree:${worktree}`);
  else keys.push(`root:${normalize(lease.rootPath)}`);
  return uniqueSorted(keys);
}

function resourceReason(keys: readonly string[], blocker: ActiveLease): SchedulerReason | null {
  const conflict = keys.find((key) => lockKeysForLease(blocker).includes(key));
  if (!conflict) return null;
  const code = conflict.startsWith("worktree:")
    ? "worktree_lock"
    : conflict.startsWith("root:")
      ? "root_lock"
      : "resource_lock";
  return {
    code,
    blockers: [blocker.taskId],
    message: `${conflict} is held by task ${blocker.taskId}`,
  };
}

/** First deterministic conflict between a candidate and already granted leases. */
export function conflictWithLeases(
  candidate: SchedulableTask,
  leases: readonly ActiveLease[],
): SchedulerReason | null {
  const keys = lockKeysForTask(candidate);
  const sorted = [...leases].sort((a, b) => a.taskId.localeCompare(b.taskId));
  for (const lease of sorted) {
    const locked = resourceReason(keys, lease);
    if (locked) return locked;
    if (
      candidate.task.root.projectId === lease.projectId &&
      pathIntentsOverlap(
        candidate.task.declaredFiles,
        candidate.task.declaredGlobs,
        lease.declaredFiles,
        lease.declaredGlobs,
      )
    ) {
      return {
        code: "declared_file_conflict",
        blockers: [lease.taskId],
        message: `declared file ranges overlap task ${lease.taskId}`,
      };
    }
  }
  return null;
}

/** Convert a selected task to a provisional lease for same-tick conflict checks. */
export function provisionalLease(candidate: SchedulableTask): ActiveLease {
  return {
    taskId: candidate.task.id,
    attemptId: `pending:${candidate.task.id}`,
    missionId: candidate.task.missionId,
    projectId: candidate.task.root.projectId,
    backendId: `pending:${candidate.task.id}`,
    rootPath: candidate.task.root.path,
    worktreePath: candidate.worktreePath ?? null,
    acquiredAt: candidate.enqueuedAt,
    declaredFiles: candidate.task.declaredFiles,
    declaredGlobs: candidate.task.declaredGlobs,
    resourceKeys: candidate.resourceKeys ?? [],
  };
}
