import type { AttentionRow } from "./core";

const MAX_ACKNOWLEDGED_GITHUB_ITEMS = 200;

export function isAttentionAcknowledged(
  row: AttentionRow,
  acknowledged: Readonly<Record<string, string>> | undefined,
): boolean {
  return row.source === "github" && acknowledged?.[row.key] === row.revision;
}

/**
 * Mark the exact currently-observed GitHub failures read. Mission blockers
 * and worker decisions remain actionable and can never be dismissed this way.
 */
export function acknowledgeGithubAttention(
  acknowledged: Readonly<Record<string, string>> | undefined,
  rows: readonly AttentionRow[],
): Record<string, string> {
  const next: Record<string, string> = { ...(acknowledged ?? {}) };
  for (const row of rows) {
    if (row.source === "github") next[row.key] = row.revision;
  }
  const entries = Object.entries(next);
  if (entries.length <= MAX_ACKNOWLEDGED_GITHUB_ITEMS) return next;
  return Object.fromEntries(entries.slice(entries.length - MAX_ACKNOWLEDGED_GITHUB_ITEMS));
}
