import { replayMissionEvents } from "./core";
import type {
  Mission,
  MissionEvent,
  MissionProjection,
  MissionTask,
  QualityGate,
} from "./types";
import type { VibeItem } from "@/types";
import type { MissionExecutionEnvelope } from "./envelope";
import type { MissionEnvelopeUsage } from "./envelope";

export interface ApprovedMissionScope {
  missionId: string;
  approvalEventId: string;
  approvalRevision: number;
  approvedAt: number;
  mission: Mission;
  tasks: Record<string, MissionTask>;
  taskFingerprints: Record<string, string>;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}

/** Fields whose post-approval mutation changes execution authority. */
export function missionTaskAuthorityFingerprint(task: MissionTask): string {
  return JSON.stringify(stable({
    id: task.id,
    missionId: task.missionId,
    title: task.title,
    description: task.description,
    priority: task.priority,
    role: task.role,
    risk: task.risk,
    acceptanceCriteria: task.acceptanceCriteria,
    root: task.root,
    worktreePolicy: task.worktreePolicy,
    dependencyIds: task.dependencyIds,
    declaredFiles: task.declaredFiles,
    declaredGlobs: task.declaredGlobs,
    maxAttempts: task.maxAttempts,
    archivedAt: task.archivedAt,
    pausedAt: task.pausedAt,
    resumeInstruction: task.resumeInstruction,
    requeuedAfterAttemptId: task.requeuedAfterAttemptId,
  }));
}

/**
 * Latest HUMAN activate/resume event defines the complete approved snapshot.
 * Events after that revision never silently expand or mutate its task scope.
 */
export function deriveApprovedMissionScope(
  events: readonly MissionEvent[],
  missionId: string,
): ApprovedMissionScope | null {
  const approval = events
    .filter((event) =>
      event.missionId === missionId &&
      event.actor === "human" &&
      (event.type === "mission.activated" || event.type === "mission.resumed"),
    )
    .sort((left, right) => right.revision - left.revision)[0];
  if (!approval) return null;
  const prefix = events.filter((event) =>
    event.missionId !== missionId || event.revision <= approval.revision,
  );
  let projection: MissionProjection;
  try {
    projection = replayMissionEvents(prefix);
  } catch {
    return null;
  }
  const mission = projection.missions[missionId];
  if (!mission) return null;
  const tasks: Record<string, MissionTask> = Object.create(null);
  const taskFingerprints: Record<string, string> = Object.create(null);
  for (const taskId of mission.taskIds) {
    const task = projection.tasks[taskId];
    if (!task) continue;
    tasks[taskId] = task;
    taskFingerprints[taskId] = missionTaskAuthorityFingerprint(task);
  }
  return {
    missionId,
    approvalEventId: approval.eventId,
    approvalRevision: approval.revision,
    approvedAt: approval.occurredAt,
    mission,
    tasks,
    taskFingerprints,
  };
}

export function taskIsInsideApprovedScope(
  scope: ApprovedMissionScope,
  current: MissionTask,
): boolean {
  const approved = scope.tasks[current.id];
  if (!approved) return false;
  if (scope.taskFingerprints[current.id] === missionTaskAuthorityFingerprint(current)) return true;
  // `attempt.started` consumes approved retry context from the Task and
  // copies it into immutable Attempt history. That one state transition must
  // not be mistaken for an unauthorized edit while settling the attempt.
  if (approved.resumeInstruction &&
    current.resumeInstruction == null && current.requeuedAfterAttemptId == null) {
    return scope.taskFingerprints[current.id] === missionTaskAuthorityFingerprint({
      ...current,
      resumeInstruction: approved.resumeInstruction,
      requeuedAfterAttemptId: approved.requeuedAfterAttemptId,
    });
  }
  return false;
}

export function taskHasSafeMissionPlacement(task: MissionTask): boolean {
  return task.worktreePolicy.mode === "new" || task.worktreePolicy.mode === "shared";
}

export function envelopeFromApprovedScope(
  scope: ApprovedMissionScope,
): MissionExecutionEnvelope | null {
  const tasks = Object.values(scope.tasks).filter((task) => task.archivedAt === null);
  if (tasks.length === 0) return null;
  const policy = scope.mission.policy;
  // The current workspace-only Codex harness enforces networkAccess:false
  // and exposes no autonomous GitHub write surface. Keep richer authorities
  // in the versioned model for future runtimes, but never pretend this
  // controller can grant them today.
  if ((policy.networkAuthority ?? "deny") !== "deny" ||
    (policy.githubAuthority ?? "deny") !== "deny") return null;
  const attemptSum = tasks.reduce((sum, task) => sum + task.maxAttempts, 0);
  const maxTasks = tasks.length;
  const maxAttempts = scope.mission.budget.maxAttemptsTotal ?? attemptSum;
  if (maxAttempts < maxTasks) return null;
  return {
    id: `envelope:${scope.missionId}:r${scope.approvalRevision}`,
    missionId: scope.missionId,
    revision: scope.approvalRevision,
    issuedAt: scope.approvedAt,
    expiresAt: null,
    limits: {
      maxTasks,
      maxAttempts,
      maxTokens: scope.mission.budget.maxTokens,
      maxActiveMs: scope.mission.budget.maxActiveMinutes === null
        ? null
        : scope.mission.budget.maxActiveMinutes * 60_000,
      maxCostUsd: scope.mission.budget.maxCostUsd,
      maxParallel: Math.min(8, Math.max(1, policy.maxParallelAttempts)),
    },
    capabilities: {
      allowedTools: [...(policy.allowedTools ?? ["workspace_sandbox"])],
      allowedRoots: [...new Set(tasks.map((task) => task.root.path))],
      network: policy.networkAuthority ?? "deny",
      github: policy.githubAuthority ?? "deny",
    },
    stopPolicy: {
      regression: policy.stopOnRegression ?? "needs_human",
      conflict: policy.stopOnConflict ?? "pause_mission",
      criticalFailure: "cancel_mission",
    },
    approval: {
      approvalId: scope.approvalEventId,
      envelopeRevision: scope.approvalRevision,
      approvedAt: scope.approvedAt,
      approvedBy: "human",
    },
  };
}

function shortHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function deterministicMissionBranch(
  missionId: string,
  taskId: string,
  ordinal: number,
): string {
  const task = taskId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "task";
  return `swarmz/mission-${shortHash(missionId)}-${task}-a${ordinal}`;
}

export function predictedWorktreePath(root: string, branch: string): string {
  const slug = branch.split("/").pop()?.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "worktree";
  return `${root.replace(/\/+$/, "")}/.worktrees/${slug}`;
}

export function missionAttemptPrompt(
  task: MissionTask,
  attemptId: string,
): string {
  return [
    `Mission task ${JSON.stringify(task.title)}.`,
    task.description,
    `Mission ID: ${JSON.stringify(task.missionId)}`,
    `Task ID: ${JSON.stringify(task.id)}`,
    `Attempt ID: ${JSON.stringify(attemptId)}`,
    `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
    task.resumeInstruction
      ? `Human retry instruction (authoritative for this fresh attempt): ${JSON.stringify(task.resumeInstruction)}`
      : "",
    "Work only on this one assignment. Do not adopt a persona or retain identity for later work.",
    "Commit the completed changes before reporting success. Your final response must fill Mission Report Schema v2; claims are independently verified against Git and command exit codes.",
  ].filter(Boolean).join("\n\n");
}

export function verifiedGateResults(
  gates: readonly QualityGate[],
  commands: Readonly<Record<string, number>>,
): { gateId: string; status: "passed"; details: string }[] {
  for (const gate of gates) {
    if (gate.command && commands[gate.command] !== 0) {
      throw new Error(`required gate did not pass independently: ${gate.command}`);
    }
  }
  return gates.map((gate) => ({
    gateId: gate.id,
    status: "passed",
    details: gate.command
      ? "Observed exit code 0 in the worker transcript"
      : "Independent Git evidence verified",
  }));
}

export function workerOutcomeDisposition(
  outcome: "completed" | "interrupted" | "failed" | "exited" | "compacted" | null,
): "inspect_report" | "cancelled" | "failed" | "wait" {
  if (outcome === null) return "wait";
  if (outcome === "completed") return "inspect_report";
  if (outcome === "interrupted" || outcome === "compacted") return "cancelled";
  return "failed";
}

export function exactPromptTurnId(
  order: readonly string[],
  items: Readonly<Record<string, VibeItem>>,
  prompt: string,
): string | null | undefined {
  for (const id of order) {
    const item = items[id];
    if (item?.kind === "user" && item.text === prompt) return item.turnId ?? null;
  }
  return undefined;
}

export function missionTurnEvidence(
  order: readonly string[],
  items: Readonly<Record<string, VibeItem>>,
  turnId: string,
): { assistantText: string | null; reportStamped: boolean; commands: Record<string, number> } {
  let assistantText: string | null = null;
  let reportStamped = false;
  const commands: Record<string, number> = Object.create(null);
  for (const id of order) {
    const item = items[id];
    if (!item) continue;
    if (item.kind === "assistant" && item.turnId === turnId && !item.streaming) {
      assistantText = item.text;
      reportStamped = item.report === true;
    } else if (item.kind === "command" && item.turnId === turnId && typeof item.exitCode === "number") {
      commands[item.command] = item.exitCode;
    }
  }
  return { assistantText, reportStamped, commands };
}

export function missionHardStopReason(
  envelope: MissionExecutionEnvelope,
  usage: MissionEnvelopeUsage,
  breakerOpen: boolean,
): string | null {
  if (breakerOpen) return "autonomy circuit breaker is open";
  if (envelope.limits.maxTokens !== null && usage.tokensUsed >= envelope.limits.maxTokens) {
    return "Mission token budget is exhausted";
  }
  if (envelope.limits.maxActiveMs !== null && usage.activeMs >= envelope.limits.maxActiveMs) {
    return "Mission active-time budget is exhausted";
  }
  if (envelope.limits.maxCostUsd !== null &&
    (!Number.isFinite(usage.costUsd) || usage.costUsd >= envelope.limits.maxCostUsd)) {
    return "Mission cost budget cannot be safely continued";
  }
  return null;
}
