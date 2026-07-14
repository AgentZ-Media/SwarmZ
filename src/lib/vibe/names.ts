// Temporary worker-lane name generator — pure, no store access. Names are
// deliberately neutral and operational: workers have no persona or reusable
// identity. A lane is retired after its one assignment is complete.

/** Enough neutral lane labels for the current per-project session capacity. */
export const AGENT_NAME_POOL: readonly string[] = Array.from(
  { length: 128 },
  (_, index) => `Lane ${String(index + 1).padStart(2, "0")}`,
);

/**
 * Pick the lowest free lane number. Temporary workers are operational slots,
 * not collectible identities, so assignment is deliberately deterministic.
 * Exhausted pool → Lane 01 receives the lowest free numeric suffix.
 */
export function pickAgentName(
  takenNames: Iterable<string>,
): string {
  const taken = new Set<string>();
  for (const n of takenNames) taken.add(n.trim().toLowerCase());
  const free = AGENT_NAME_POOL.find((n) => !taken.has(n.toLowerCase()));
  if (free) return free;
  const base = AGENT_NAME_POOL[0];
  let n = 2;
  while (taken.has(`${base} ${n}`.toLowerCase())) n++;
  return `${base} ${n}`;
}

/** Max characters the task part of a branch slug contributes. */
const TASK_SLUG_MAX = 24;

/**
 * ASCII-slug a free-text fragment: diacritics are stripped via NFKD,
 * lowercased, and non-alphanumeric runs collapse to one hyphen.
 */
export function asciiSlug(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Branch name for a task lane's worktree: `swarm/<lane>` or
 * `swarm/<lane>-<task>`, all ASCII. The task fragment is capped at a word
 * boundary so branches remain readable.
 */
export function branchSlugForAgent(name: string, task?: string): string {
  const nameSlug = asciiSlug(name) || "agent";
  let taskSlug = task ? asciiSlug(task) : "";
  if (taskSlug.length > TASK_SLUG_MAX) {
    const cut = taskSlug.lastIndexOf("-", TASK_SLUG_MAX);
    taskSlug = taskSlug.slice(0, cut > 0 ? cut : TASK_SLUG_MAX);
  }
  return taskSlug ? `swarm/${nameSlug}-${taskSlug}` : `swarm/${nameSlug}`;
}
