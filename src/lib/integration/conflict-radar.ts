import type { MissionTask } from "@/lib/missions/types";
import { pathIntentsOverlap } from "@/lib/scheduler/conflicts";
import type { ConflictRadarItem, ObservedChangeSet } from "./types";

function normalize(value: string): string {
  return value.trim().split("\\").join("/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

function globRegex(pattern: string): RegExp {
  let result = "^";
  const normalized = normalize(pattern);
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") {
      result += ".*";
      index += 1;
    } else if (char === "*") result += "[^/]*";
    else if (char === "?") result += "[^/]";
    else result += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${result}$`);
}

function exactEvidence(task: MissionTask, source: ObservedChangeSet): string[] {
  const sourceFiles = new Set(source.files.map(normalize));
  const evidence = task.declaredFiles.map(normalize).filter((file) => sourceFiles.has(file));
  for (const file of task.declaredFiles.map(normalize)) {
    if ((source.globs ?? []).some((glob) => globRegex(glob).test(file))) evidence.push(file);
  }
  for (const file of source.files.map(normalize)) {
    if (task.declaredGlobs.some((glob) => globRegex(glob).test(file))) evidence.push(file);
  }
  return [...new Set(evidence)].sort();
}

function criticalSurface(value: string): boolean {
  const path = normalize(value).toLowerCase();
  return (
    /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.lock)$/.test(path) ||
    /(^|\/)(migrations?|schema)(\/|\.|$)/.test(path) ||
    /(^|\/)(auth|permissions?|security)(\/|\.|$)/.test(path)
  );
}

const severityOrder: Record<ConflictRadarItem["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
};

/** Conservative pre-flight conflict prediction. It never executes git. */
export function buildConflictRadar(
  candidate: MissionTask,
  sources: readonly ObservedChangeSet[],
): ConflictRadarItem[] {
  const result: ConflictRadarItem[] = [];
  for (const source of [...sources].sort((a, b) => a.id.localeCompare(b.id))) {
    if (source.taskId === candidate.id) continue;
    if (
      !pathIntentsOverlap(
        candidate.declaredFiles,
        candidate.declaredGlobs,
        source.files,
        source.globs ?? [],
      )
    ) {
      continue;
    }
    const exact = exactEvidence(candidate, source);
    const critical = [...exact, ...candidate.declaredGlobs, ...(source.globs ?? [])].some(
      criticalSurface,
    );
    result.push({
      candidateTaskId: candidate.id,
      sourceId: source.id,
      ...(source.taskId ? { sourceTaskId: source.taskId } : {}),
      severity: critical ? "critical" : exact.length > 0 ? "high" : "medium",
      kind: critical ? "critical_surface" : exact.length > 0 ? "exact_file" : "glob_overlap",
      evidence:
        exact.length > 0
          ? exact
          : [...new Set([...candidate.declaredGlobs, ...(source.globs ?? [])])].sort(),
      message: critical
        ? `critical integration surface overlaps ${source.id}`
        : exact.length > 0
          ? `declared files overlap ${source.id}`
          : `declared globs may overlap ${source.id}`,
    });
  }
  return result.sort(
    (a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity] ||
      a.sourceId.localeCompare(b.sourceId),
  );
}
