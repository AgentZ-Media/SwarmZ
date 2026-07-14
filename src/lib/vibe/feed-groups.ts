import type { VibeItem } from "@/types";

export type WorkerFeedEntry =
  | { kind: "item"; id: string }
  | { kind: "activity"; key: string; ids: string[] };

/** Commands, searches and file edits are implementation activity, not chat messages. */
export function isWorkerActivity(item: VibeItem | undefined): boolean {
  return (
    item?.kind === "command" ||
    item?.kind === "webSearch" ||
    item?.kind === "fileChange"
  );
}

/**
 * Fold adjacent technical events into one stable activity row. Human-readable
 * agent messages keep their own rows and therefore stay visually primary.
 */
export function groupWorkerFeed(
  order: readonly string[],
  items: Readonly<Record<string, VibeItem>>,
): WorkerFeedEntry[] {
  const out: WorkerFeedEntry[] = [];
  let activity: string[] = [];
  const flush = () => {
    if (!activity.length) return;
    out.push({
      kind: "activity",
      key: `activity:${activity[0]}`,
      ids: activity,
    });
    activity = [];
  };

  for (const id of order) {
    const item = items[id];
    if (!item) continue;
    if (isWorkerActivity(item)) {
      activity.push(id);
      continue;
    }
    flush();
    out.push({ kind: "item", id });
  }
  flush();
  return out;
}

/** Prefer conversation/status rows over shell noise in compact Fleet cards. */
export function compactWorkerFeedIds(
  order: readonly string[],
  items: Readonly<Record<string, VibeItem>>,
  limit = 3,
): string[] {
  const ids: string[] = [];
  for (let index = order.length - 1; index >= 0 && ids.length < limit; index--) {
    const id = order[index];
    const item = items[id];
    if (item && !isWorkerActivity(item)) ids.push(id);
  }
  return ids.reverse();
}

/** Number of technical steps since the worker last spoke or emitted a result. */
export function trailingWorkerActivityCount(
  order: readonly string[],
  items: Readonly<Record<string, VibeItem>>,
): number {
  let count = 0;
  for (let index = order.length - 1; index >= 0; index--) {
    const item = items[order[index]];
    if (!item) continue;
    if (!isWorkerActivity(item)) break;
    count++;
  }
  return count;
}

/** A compact card preview should not expose raw Markdown punctuation. */
export function markdownPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/([*_~`])([^\n]*?)\1/g, "$2")
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, "")
    .replace(/^\s*\|\s?/gm, "")
    .replace(/\s?\|\s?/g, " · ")
    .replace(/\s+/g, " ")
    .trim();
}
