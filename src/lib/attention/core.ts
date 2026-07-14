import type { ProjectGithub } from "@/lib/github/store";
import type {
  MissionProjection,
  MissionTask,
  TaskStatus,
} from "@/lib/missions/types";
import type { VibeTriageEntry } from "@/lib/vibe/triage";
import type { Project } from "@/types";

export type AttentionTone = "attention" | "blocked" | "failed";

/** One actionable item rendered by every global attention surface. */
export interface AttentionRow {
  key: string;
  source: "mission" | "train" | "worker" | "github";
  sourceId: string;
  projectId: string;
  missionId: string | null;
  title: string;
  place: string;
  detail: string;
  since: number;
  tone: AttentionTone;
  statusLabel: string;
}

export interface AttentionSnapshot {
  projection: MissionProjection;
  workers: readonly VibeTriageEntry[];
  githubByProject: Readonly<Record<string, ProjectGithub>>;
  projects: Readonly<Record<string, Project>>;
}

export const ATTENTION_TASK_STATUSES = new Set<TaskStatus>([
  "needs_human",
  "blocked",
  "failed",
]);

/**
 * The single product definition of "needs you". The TitleBar count and the
 * inbox rows both consume this exact projection, so a blocker cannot be
 * visible in one surface and silently absent in the other.
 */
export function buildAttentionRows(snapshot: AttentionSnapshot): AttentionRow[] {
  const { projection } = snapshot;
  const rows: AttentionRow[] = [];

  for (const task of Object.values(projection.tasks)) {
    if (!ATTENTION_TASK_STATUSES.has(task.status)) continue;
    const mission = projection.missions[task.missionId];
    rows.push(
      missionTaskRow(
        task,
        mission?.projectId ?? task.root.projectId,
        mission?.title ?? "Unknown mission",
        projection,
      ),
    );
  }

  for (const train of Object.values(projection.integrationTrains)) {
    if (train.status !== "blocked") continue;
    const mission = projection.missions[train.missionId];
    const fallbackProjectId = train.entries
      .map((entry) => projection.tasks[entry.taskId]?.root.projectId)
      .find((projectId): projectId is string => !!projectId);
    const projectId = mission?.projectId ?? fallbackProjectId;
    // A corrupt orphan remains visible in Mission recovery, but cannot form
    // a safe cross-project navigation target in the global inbox.
    if (!projectId) continue;
    const failed = train.entries.find((entry) => entry.status === "failed");
    rows.push({
      key: `train:${train.id}`,
      source: "train",
      sourceId: train.id,
      projectId,
      missionId: train.missionId,
      title: "Integration train blocked",
      place: `${mission?.title ?? "Unknown mission"} · ${train.integrationBranch}`,
      detail:
        failed?.detail ||
        "The integration branch needs review before the mission can complete.",
      since: train.updatedAt,
      tone: failed ? "failed" : "blocked",
      statusLabel: failed ? "conflict" : "blocked",
    });
  }

  for (const worker of snapshot.workers) {
    rows.push({
      key: `worker:${worker.id}`,
      source: "worker",
      sourceId: worker.id,
      projectId: worker.projectId,
      missionId: null,
      title: worker.name,
      place: `${worker.project} · worker`,
      detail:
        worker.summary ||
        (worker.kind === "approval"
          ? "A worker is waiting for an approval decision."
          : "A worker has a structured question that needs an answer."),
      since: worker.since ?? 0,
      tone: "attention",
      statusLabel: worker.kind === "approval" ? "approval" : "question",
    });
  }

  for (const [projectId, github] of Object.entries(snapshot.githubByProject)) {
    const project = snapshot.projects[projectId];
    if (!project) continue;
    for (const pr of github.prs) {
      const issue = githubIssue(pr);
      if (!issue) continue;
      const parsedUpdatedAt = Date.parse(pr.updated_at);
      rows.push({
        key: `github:${projectId}:${pr.number}`,
        source: "github",
        sourceId: String(pr.number),
        projectId,
        missionId: null,
        title: `PR #${pr.number} · ${pr.title}`,
        place: `${project.name} · GitHub`,
        detail: issue.detail,
        since: Number.isFinite(parsedUpdatedAt)
          ? parsedUpdatedAt
          : (github.prsFetchedAt ?? 0),
        tone: "failed",
        statusLabel: issue.label,
      });
    }
  }

  return rows.sort(
    (left, right) =>
      attentionRank(left.tone) - attentionRank(right.tone) ||
      left.since - right.since ||
      left.title.localeCompare(right.title),
  );
}

function missionTaskRow(
  task: MissionTask,
  projectId: string,
  missionTitle: string,
  projection: MissionProjection,
): AttentionRow {
  const tone: AttentionTone =
    task.status === "needs_human"
      ? "attention"
      : task.status === "failed"
        ? "failed"
        : "blocked";
  const taskAttempts = task.attemptIds
    .map((id) => projection.attempts[id])
    .filter(Boolean);
  const latestAttempt = taskAttempts[taskAttempts.length - 1];
  const failedGate = task.qualityGateIds
    .map((id) => projection.qualityGates[id])
    .find((gate) => gate?.status === "failed");
  const question = reportQuestion(latestAttempt?.report ?? null);
  return {
    key: `task:${task.id}`,
    source: "mission",
    sourceId: task.id,
    projectId,
    missionId: task.missionId,
    title: task.title,
    place: missionTitle,
    detail:
      question ||
      latestAttempt?.error ||
      failedGate?.details ||
      latestAttempt?.summary ||
      task.description ||
      (tone === "attention"
        ? "This task needs a human decision."
        : tone === "failed"
          ? "This task failed and needs review before it can continue."
          : "This task is blocked and cannot make progress."),
    since: Math.max(
      task.updatedAt,
      latestAttempt?.finishedAt ?? 0,
      failedGate?.updatedAt ?? 0,
    ),
    tone,
    statusLabel:
      tone === "attention"
        ? "needs you"
        : tone === "failed"
          ? "failed"
          : "blocked",
  };
}

function reportQuestion(report: Record<string, unknown> | null): string | null {
  const question = report?.question;
  return typeof question === "string" && question.trim()
    ? question.trim()
    : null;
}

function githubIssue(pr: ProjectGithub["prs"][number]): {
  label: string;
  detail: string;
} | null {
  const details: string[] = [];
  if (pr.checks.failing > 0) {
    details.push(
      `${pr.checks.failing} CI check${pr.checks.failing === 1 ? " is" : "s are"} failing`,
    );
  }
  if (pr.mergeable === "CONFLICTING") details.push("the PR has merge conflicts");
  if (pr.review_decision === "CHANGES_REQUESTED") {
    details.push("review changes are requested");
  }
  if (details.length === 0) return null;
  const label =
    pr.mergeable === "CONFLICTING"
      ? "conflict"
      : pr.checks.failing > 0
        ? "CI failed"
        : "changes requested";
  return {
    label,
    detail: `${details.join("; ")}. Open GitHub to inspect and resolve the PR.`,
  };
}

function attentionRank(tone: AttentionTone): number {
  return tone === "attention" ? 0 : tone === "failed" ? 1 : 2;
}
