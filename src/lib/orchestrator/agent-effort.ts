/**
 * Worker reasoning policy: high is the quality ceiling for ordinary work.
 * The two above-high tiers survive only behind an explicit critical-work flag
 * so an Orchestrator cannot spend them accidentally on routine lanes.
 */
export function resolveSpawnEffort(
  raw: unknown,
  criticalReasoning: boolean,
): string {
  const requested = typeof raw === "string" ? raw.trim() : "";
  const effort = requested || "high";
  const normalized = effort.toLowerCase();
  if (!criticalReasoning && (normalized === "xhigh" || normalized === "max")) {
    return "high";
  }
  return effort;
}
