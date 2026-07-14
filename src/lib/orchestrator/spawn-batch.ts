import type { SpawnAgentSpec, SpawnAgentResult } from "./types";

/**
 * Multiple `none` placements all target the same mutable main checkout. The
 * old implementation created every empty worker first, started only one task
 * and then waited for that turn to finish. If the Conductor turn was steered
 * or interrupted during the wait, the remaining workers stayed unassigned.
 * Refuse that ambiguous batch before any side effect; independent work uses
 * one fresh worktree per agent, deliberate sequential work uses later calls.
 */
export function assertSafeSpawnBatch(specs: readonly SpawnAgentSpec[]): void {
  const direct = specs.filter((spec) => String(spec?.worktree ?? "").trim() === "none");
  if (direct.length > 1) {
    throw new Error(
      `spawn batch refused before creating agents: ${direct.length} assignments target the same project checkout (worktree "none"). For parallel work, retry with worktree "new" on every independent agent. For sequential work, spawn only the first agent now and start the next after it finishes.`,
    );
  }
}

export function spawnBatchSummary(results: readonly SpawnAgentResult[]): string {
  const created = results.filter((result) => result.id && !result.error).length;
  const started = results.filter((result) => result.delivery === "started").length;
  const failed = results.filter((result) => result.error).length;
  const undelivered = results.filter(
    (result) => result.id && !result.error && result.delivery !== "started",
  ).length;
  const parts = [
    `created ${created} agent${created === 1 ? "" : "s"}`,
    `backend-acknowledged ${started} initial task${started === 1 ? "" : "s"}`,
  ];
  if (undelivered) parts.push(`${undelivered} task${undelivered === 1 ? "" : "s"} not delivered`);
  if (failed) parts.push(`${failed} spawn${failed === 1 ? "" : "s"} failed`);
  return parts.join("; ");
}
