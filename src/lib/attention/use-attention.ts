import { useMemo } from "react";
import { useGithub } from "@/lib/github/store";
import { useMissions } from "@/lib/missions/store";
import { useProjects } from "@/lib/projects/store";
import { useVibe } from "@/lib/vibe/session-store";
import { useSwarm } from "@/store";
import { vibeTriageEntries } from "@/lib/vibe/triage";
import { buildAttentionRows, type AttentionRow } from "./core";
import { isAttentionAcknowledged } from "./acknowledgement";

/**
 * Reactive global attention projection. Every Zustand selector returns only
 * a primitive signature; rows are created after selection to remain stable
 * under React 19's external-store contract.
 */
export function useAttentionRows(): AttentionRow[] {
  const missionSignature = useMissions((state) => {
    const parts: string[] = [];
    for (const task of Object.values(state.projection.tasks)) {
      if (!["needs_human", "blocked", "failed"].includes(task.status)) continue;
      const taskAttempts = task.attemptIds
        .map((id) => state.projection.attempts[id])
        .filter(Boolean);
      const latestAttempt = taskAttempts[taskAttempts.length - 1];
      const failedGate = task.qualityGateIds
        .map((id) => state.projection.qualityGates[id])
        .find((gate) => gate?.status === "failed");
      const mission = state.projection.missions[task.missionId];
      parts.push(
        [
          "task",
          task.id,
          task.status,
          task.updatedAt,
          task.title,
          task.description,
          task.root.projectId,
          mission?.projectId ?? "",
          mission?.title ?? "",
          latestAttempt?.status ?? "",
          latestAttempt?.finishedAt ?? "",
          latestAttempt?.error ?? "",
          latestAttempt?.summary ?? "",
          reportQuestion(latestAttempt?.report ?? null) ?? "",
          failedGate?.updatedAt ?? "",
          failedGate?.details ?? "",
        ].join(":"),
      );
    }
    for (const train of Object.values(state.projection.integrationTrains)) {
      if (train.status !== "blocked") continue;
      const mission = state.projection.missions[train.missionId];
      parts.push(
        [
          "train",
          train.id,
          train.updatedAt,
          train.integrationBranch,
          train.missionId,
          mission?.projectId ?? "",
          mission?.title ?? "",
          train.entries
            .map((entry) =>
              `${entry.taskId}:${entry.status}:${entry.detail ?? ""}`,
            )
            .join(","),
        ].join(":"),
      );
    }
    return parts.sort().join("|");
  });
  const workerSignature = useVibe((state) =>
    vibeTriageEntries(state)
      .map(
        (entry) =>
          `${entry.id}:${entry.projectId}:${entry.kind}:${entry.since ?? ""}:${entry.name}:${entry.project}:${entry.summary ?? ""}`,
      )
      .join("|"),
  );
  const githubSignature = useGithub((state) =>
    Object.entries(state.byProject)
      .map(([projectId, project]) =>
        [
          projectId,
          project.prsFetchedAt ?? "",
          ...project.prs.map(
            (pr) =>
              `${pr.number}:${pr.title}:${pr.updated_at}:${pr.checks.failing}:${pr.mergeable}:${pr.review_decision}`,
          ),
        ].join(":"),
      )
      .sort()
      .join("|"),
  );
  const projectSignature = useProjects((state) =>
    Object.values(state.projects)
      .map((project) => `${project.id}:${project.name}`)
      .sort()
      .join("|"),
  );
  const acknowledgementSignature = useSwarm((state) =>
    Object.entries(state.settings.githubAttentionAcknowledged ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, revision]) => `${key}:${revision}`)
      .join("|"),
  );

  return useMemo(
    () => {
      const rows = buildAttentionRows({
        projection: useMissions.getState().projection,
        workers: vibeTriageEntries(useVibe.getState()),
        githubByProject: useGithub.getState().byProject,
        projects: useProjects.getState().projects,
      });
      const acknowledged = useSwarm.getState().settings.githubAttentionAcknowledged;
      return rows.filter((row) => !isAttentionAcknowledged(row, acknowledged));
    },
    [
      missionSignature,
      workerSignature,
      githubSignature,
      projectSignature,
      acknowledgementSignature,
    ],
  );
}

/** Primitive count consumed by compact badge surfaces. */
export function useAttentionCount(): number {
  return useAttentionRows().length;
}

function reportQuestion(report: Record<string, unknown> | null): string | null {
  const question = report?.question;
  return typeof question === "string" && question.trim()
    ? question.trim()
    : null;
}
