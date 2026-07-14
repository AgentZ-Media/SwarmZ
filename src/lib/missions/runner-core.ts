import type { SchedulerDecision, StartDecision } from "@/lib/scheduler/types";
import type {
  MissionEventPayload,
  MissionProjection,
  MissionTask,
} from "./types";
import {
  authorizeEnvelopeStart,
  type EnvelopeVerdict,
  type MissionEnvelopeUsage,
  type MissionExecutionEnvelope,
  type NetworkAuthority,
  type GithubAuthority,
} from "./envelope";
import type {
  MissionReportObservation,
  MissionReportV2,
} from "./report-v2";
import { assessMissionReportV2 } from "./report-v2";

export interface TaskCapabilityRequest {
  tools: readonly string[];
  network?: Exclude<NetworkAuthority, "deny">;
  github?: Exclude<GithubAuthority, "deny">;
}

export interface TemporaryWorkerSpec {
  lifecycle: "temporary_one_assignment";
  assignmentTaskId: string;
  /** Worker/session reuse is structurally forbidden. */
  resumeExistingSession: false;
  durableMemory: false;
  persona: false;
  workspaceOnly: true;
  closeAfterTerminalReport: true;
  label: string;
}

export interface StartAttemptCommand {
  kind: "start_fresh_attempt";
  operationId: string;
  missionId: string;
  taskId: string;
  attemptId: string;
  ordinal: number;
  envelopeId: string;
  envelopeRevision: number;
  rootPath: string;
  lockKeys: readonly string[];
  worker: TemporaryWorkerSpec;
}

type EnvelopeRejectionCode = Extract<EnvelopeVerdict, { ok: false }>["code"];

export interface RunnerRejection {
  taskId: string;
  code: EnvelopeRejectionCode
    | "mission_missing"
    | "mission_not_active"
    | "task_missing"
    | "scheduler_mismatch"
    | "task_not_ready"
    | "already_dispatched";
  reason: string;
}

export interface MissionRunnerInput {
  projection: MissionProjection;
  scheduler: Pick<SchedulerDecision, "starts">;
  envelope: MissionExecutionEnvelope;
  usage: MissionEnvelopeUsage;
  now: number;
  breakerOpen: boolean;
  breakerReason?: string;
  completedOperationIds: ReadonlySet<string>;
  capabilitiesForTask?: (task: MissionTask) => TaskCapabilityRequest;
}

export interface MissionRunnerPlan {
  commands: StartAttemptCommand[];
  rejected: RunnerRejection[];
  projectedUsage: MissionEnvelopeUsage;
}

function commandIdentity(
  envelope: MissionExecutionEnvelope,
  task: MissionTask,
  ordinal: number,
): { operationId: string; attemptId: string } {
  const stem = `${envelope.missionId}:${task.id}:${ordinal}:r${envelope.revision}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < stem.length; index += 1) {
    hash ^= stem.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  const digest = (hash >>> 0).toString(36);
  const taskSlug = task.id.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 32) || "task";
  return {
    operationId: `mission-start:${taskSlug}:a${ordinal}:r${envelope.revision}:${digest}`,
    attemptId: `ma-${taskSlug}-a${ordinal}-r${envelope.revision}-${digest}`,
  };
}

function reject(
  rejected: RunnerRejection[],
  start: StartDecision,
  code: RunnerRejection["code"],
  reason: string,
): void {
  rejected.push({ taskId: start.taskId, code, reason });
}

/**
 * Convert scheduler admissions into side-effect-free launch commands. The
 * executor must durably append `attempt.started` with the same operation id
 * before spawning; replaying this plan then returns `already_dispatched`.
 */
export function planMissionStarts(input: MissionRunnerInput): MissionRunnerPlan {
  const commands: StartAttemptCommand[] = [];
  const rejected: RunnerRejection[] = [];
  const mission = input.projection.missions[input.envelope.missionId];
  const usage = { ...input.usage };
  const plannedOperations = new Set<string>();
  if (!mission) {
    return {
      commands,
      rejected: input.scheduler.starts.map((start) => ({
        taskId: start.taskId,
        code: "mission_missing" as const,
        reason: "envelope mission does not exist",
      })),
      projectedUsage: usage,
    };
  }

  for (const start of input.scheduler.starts) {
    const task = input.projection.tasks[start.taskId];
    if (!task) {
      reject(rejected, start, "task_missing", "scheduler selected an unknown task");
      continue;
    }
    if (
      start.missionId !== mission.id ||
      task.missionId !== mission.id ||
      task.root.projectId !== start.projectId
    ) {
      reject(rejected, start, "scheduler_mismatch", "scheduler admission identity does not match the projection");
      continue;
    }
    if (["paused", "cancelled", "archived", "failed", "succeeded", "needs_human", "blocked"].includes(mission.status)) {
      reject(rejected, start, "mission_not_active", `mission cannot launch work from ${mission.status}`);
      continue;
    }
    if (task.status !== "ready") {
      reject(rejected, start, "task_not_ready", `task cannot launch from ${task.status}`);
      continue;
    }
    const ordinal = task.attemptIds.length + 1;
    const identity = commandIdentity(input.envelope, task, ordinal);
    if (
      input.completedOperationIds.has(identity.operationId) ||
      plannedOperations.has(identity.operationId) ||
      input.projection.attempts[identity.attemptId]
    ) {
      reject(rejected, start, "already_dispatched", "this fresh attempt was already dispatched");
      continue;
    }
    const capabilities = input.capabilitiesForTask?.(task) ?? { tools: [] };
    const verdict = authorizeEnvelopeStart(input.envelope, usage, {
      missionId: mission.id,
      envelopeRevision: input.envelope.revision,
      rootPath: task.root.path,
      requiredTools: capabilities.tools,
      network: capabilities.network,
      github: capabilities.github,
      isFirstTaskStart: task.attemptIds.length === 0,
      now: input.now,
      breakerOpen: input.breakerOpen,
      breakerReason: input.breakerReason,
    });
    if (!verdict.ok) {
      reject(rejected, start, verdict.code, verdict.reason);
      continue;
    }
    commands.push({
      kind: "start_fresh_attempt",
      operationId: identity.operationId,
      missionId: mission.id,
      taskId: task.id,
      attemptId: identity.attemptId,
      ordinal,
      envelopeId: input.envelope.id,
      envelopeRevision: input.envelope.revision,
      rootPath: task.root.path,
      lockKeys: [...start.lockKeys],
      worker: {
        lifecycle: "temporary_one_assignment",
        assignmentTaskId: task.id,
        resumeExistingSession: false,
        durableMemory: false,
        persona: false,
        workspaceOnly: true,
        closeAfterTerminalReport: true,
        label: `Task ${task.id} · attempt ${ordinal}`,
      },
    });
    plannedOperations.add(identity.operationId);
    if (task.attemptIds.length === 0) usage.tasksStarted += 1;
    usage.attemptsStarted += 1;
    usage.activeAttempts += 1;
  }
  return { commands, rejected, projectedUsage: usage };
}

export interface ReportSettlementInput {
  projection: MissionProjection;
  report: MissionReportV2;
  observation: MissionReportObservation | null;
  finishedAt: number;
  operationId: string;
  completedOperationIds: ReadonlySet<string>;
}

export type ReportSettlementDecision =
  | {
      ok: true;
      operationId: string;
      event: Extract<MissionEventPayload, { type: "attempt.finished" }>;
    }
  | { ok: false; code: "already_settled" | "identity_mismatch" | "attempt_not_running" | "success_unverified"; reason: string };

/** Create the terminal event only after binding and independent verification. */
export function planReportSettlement(
  input: ReportSettlementInput,
): ReportSettlementDecision {
  if (input.completedOperationIds.has(input.operationId)) {
    return { ok: false, code: "already_settled", reason: "report operation was already applied" };
  }
  const attempt = input.projection.attempts[input.report.attemptId];
  const assessment = assessMissionReportV2(
    input.report,
    {
      missionId: attempt?.missionId ?? "",
      taskId: attempt?.taskId ?? "",
      attemptId: attempt?.id ?? "",
    },
    input.observation,
  );
  if (!attempt ||
    attempt.missionId !== input.report.missionId ||
    attempt.taskId !== input.report.taskId ||
    !assessment.bound) {
    return { ok: false, code: "identity_mismatch", reason: "report does not bind to the persisted attempt" };
  }
  if (attempt.status !== "running") {
    return { ok: false, code: "attempt_not_running", reason: "attempt is already terminal" };
  }
  if (input.report.status === "succeeded" && !assessment.verifiedSuccess) {
    return { ok: false, code: "success_unverified", reason: assessment.issues.join("; ") || "success evidence is unverified" };
  }
  return {
    ok: true,
    operationId: input.operationId,
    event: {
      type: "attempt.finished",
      data: {
        attemptId: attempt.id,
        status: input.report.status,
        finishedAt: input.finishedAt,
        summary: input.report.summary,
        error: input.report.status === "failed" ? input.report.summary : null,
        report: input.report as unknown as Record<string, unknown>,
      },
    },
  };
}
