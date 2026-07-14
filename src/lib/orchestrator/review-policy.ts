import type {
  AppSettings,
  ReviewIterationCounter,
  VibeSession,
} from "@/types";

export const DEFAULT_MAX_REVIEW_ITERATIONS = 2;
export const MAX_REVIEW_ITERATIONS = 10;
export const MAX_REVIEW_COUNTERS = 128;

export function normalizeReviewIterationLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_REVIEW_ITERATIONS;
  }
  return Math.min(MAX_REVIEW_ITERATIONS, Math.max(1, Math.trunc(value)));
}

/** One feature lane = one managed worktree branch (or one direct checkout). */
export function reviewLaneKey(session: VibeSession): string {
  return session.worktree
    ? `worktree:${JSON.stringify([
        session.worktree.root,
        session.worktree.branch,
      ])}`
    : `session:${session.id}`;
}

export function normalizeReviewIterationCounters(
  value: unknown,
): ReviewIterationCounter[] {
  if (!Array.isArray(value)) return [];
  const counters: ReviewIterationCounter[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const counter = raw as Partial<ReviewIterationCounter>;
    if (
      typeof counter.laneKey !== "string" ||
      !counter.laneKey ||
      counter.laneKey.length > 1_024 ||
      /[\r\n]/.test(counter.laneKey) ||
      typeof counter.count !== "number" ||
      !Number.isInteger(counter.count) ||
      counter.count < 1 ||
      counter.count > 1_000 ||
      seen.has(counter.laneKey)
    )
      continue;
    seen.add(counter.laneKey);
    counters.push({
      laneKey: counter.laneKey,
      count: counter.count,
      updatedAt:
        typeof counter.updatedAt === "number" &&
        Number.isFinite(counter.updatedAt)
          ? counter.updatedAt
          : 0,
    });
  }
  return counters
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_REVIEW_COUNTERS);
}

/** The existing setting is now the master switch for the whole review loop. */
export function reviewLoopConfig(settings: AppSettings): {
  enabled: boolean;
  maxIterations: number;
} {
  return {
    enabled: settings.autoReviewFinishedLanes === true,
    maxIterations: normalizeReviewIterationLimit(
      settings.autoReviewMaxIterations,
    ),
  };
}
