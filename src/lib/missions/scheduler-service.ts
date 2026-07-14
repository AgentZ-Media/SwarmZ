import { retryAfterFailure, schedule } from "@/lib/scheduler/core";
import type { ActiveLease, SchedulableTask } from "@/lib/scheduler/types";
import { autonomyTripped } from "@/lib/orchestrator/autonomy";
import { interrupt } from "@/lib/vibe/controller";
import { useVibe } from "@/lib/vibe/session-store";
import { useMissions } from "./store";
import { useMissionOutbox } from "./outbox-store";
import { planMissionStarts, type StartAttemptCommand } from "./runner-core";
import { authorizeEnvelopeStart } from "./envelope";
import {
  deriveApprovedMissionScope,
  envelopeFromApprovedScope,
  taskIsInsideApprovedScope,
  taskHasSafeMissionPlacement,
  missionHardStopReason,
  type ApprovedMissionScope,
} from "./controller-core";
import type { MissionTask } from "./types";
import { resolveProjectMissionRuntime } from "./runtime-binding";
import {
  activeLease,
  approvedScopes,
  flushMissionOrThrow,
  missionUsage,
  safeId,
} from "./controller-shared";
import { branchPlacement, enqueueStart } from "./spawn-dispatch";
import { isOwnedMissionAttempt } from "./settlement-service";

export async function pauseMissionsWithRuntimeDrift(): Promise<void> {
  for (const scope of approvedScopes()) {
    const binding = scope.mission.policy.runtimeEnvironment;
    if (!binding) continue;
    try {
      resolveProjectMissionRuntime(scope.mission.projectId, binding);
    } catch (error) {
      const artifactId = safeId(`${scope.missionId}:${binding.environmentId}`, "runtime-drift");
      if (!useMissions.getState().projection.artifacts[artifactId]) {
        useMissions.getState().recordArtifact(scope.missionId, {
          id: artifactId,
          taskId: null,
          attemptId: null,
          kind: "other",
          label: "Runtime Environment approval drift",
          uri: null,
          metadata: {
            environmentId: binding.environmentId,
            expectedFingerprint: binding.specFingerprint,
            reason: error instanceof Error ? error.message : "runtime binding could not be verified",
          },
        }, { actor: "system", idempotencyKey: `runtime-drift:${scope.missionId}:${binding.specFingerprint}` });
      }
      useMissions.getState().pauseMission(scope.missionId, {
        actor: "system",
        idempotencyKey: `runtime-drift-pause:${scope.missionId}:${binding.specFingerprint}`,
      });
      await flushMissionOrThrow();
    }
  }
}

export async function enforceRunningStops(): Promise<void> {
  const state = useMissions.getState();
  for (const mission of Object.values(state.projection.missions)) {
    const running = Object.values(state.projection.attempts)
      .filter((attempt) => attempt.missionId === mission.id && attempt.status === "running" && isOwnedMissionAttempt(attempt));
    if (!running.length) continue;
    let stop = mission.status === "paused" || mission.status === "cancelled";
    if (mission.status === "active") {
      const scope = deriveApprovedMissionScope(state.events, mission.id);
      const envelope = scope ? envelopeFromApprovedScope(scope) : null;
      const reason = scope && envelope
        ? missionHardStopReason(envelope, missionUsage(scope, Date.now()), autonomyTripped(mission.projectId))
        : null;
      if (reason) {
        useMissions.getState().pauseMission(mission.id, {
          actor: "system",
          idempotencyKey: `hard-stop:${mission.id}:${scope?.approvalRevision ?? mission.revision}`,
        });
        await flushMissionOrThrow();
        stop = true;
      }
    }
    if (stop) for (const attempt of running) {
      // Do not tear services away from a turn that has not acknowledged the
      // interrupt yet. Terminal settlement/recovery owns cleanup.
      if (attempt.sessionId) interrupt(attempt.sessionId);
    }
  }
}

function candidateStartCommand(
  scope: ApprovedMissionScope,
  task: MissionTask,
  batchId: string,
  candidateIndex: number,
): StartAttemptCommand {
  const ordinal = task.attemptIds.length + 1;
  const stem = `${scope.missionId}:${task.id}:${batchId}:${candidateIndex}:r${scope.approvalRevision}`;
  const operationId = `candidate-start:${safeId(stem, "op")}`;
  return {
    kind: "start_fresh_attempt",
    operationId,
    missionId: scope.missionId,
    taskId: task.id,
    attemptId: safeId(`${operationId}:attempt`, "ma"),
    ordinal,
    envelopeId: `mission-envelope:${scope.missionId}:r${scope.approvalRevision}`,
    envelopeRevision: scope.approvalRevision,
    rootPath: task.root.path,
    lockKeys: [],
    worker: {
      lifecycle: "temporary_one_assignment",
      assignmentTaskId: task.id,
      resumeExistingSession: false,
      durableMemory: false,
      persona: false,
      workspaceOnly: true,
      closeAfterTerminalReport: true,
      label: `Task ${task.id} · candidate ${candidateIndex}`,
    },
  };
}

/** Admit explicitly human-approved A/B(/N) lanes without pretending they are
 * independent tasks. Each lane still passes the same revisioned envelope and
 * gets its own worktree/session/turn. */
async function admitCandidateStarts(scopes: readonly ApprovedMissionScope[]): Promise<void> {
  const scopeByMission = new Map(scopes.map((scope) => [scope.missionId, scope]));
  const batches = Object.values(useMissions.getState().projection.candidateBatches)
    .filter((batch) => !batch.selectedAttemptId && batch.attemptIds.length < batch.count)
    .sort((left, right) => left.requestedAt - right.requestedAt || left.id.localeCompare(right.id));
  for (const candidate of batches) {
    const scope = scopeByMission.get(candidate.missionId);
    if (!scope || autonomyTripped(scope.mission.projectId)) continue;
    const envelope = envelopeFromApprovedScope(scope);
    if (!envelope) continue;
    while (true) {
      const projection = useMissions.getState().projection;
      const batch = projection.candidateBatches[candidate.id];
      const task = projection.tasks[candidate.taskId];
      if (!batch || !task || batch.selectedAttemptId || batch.attemptIds.length >= batch.count ||
        !taskIsInsideApprovedScope(scope, task) || !taskHasSafeMissionPlacement(task)) break;
      const globalActive = Object.values(projection.attempts).filter((attempt) => attempt.status === "running").length;
      const usage = missionUsage(scope, Date.now());
      if (globalActive >= 8 || useVibe.getState().order.length >= 48 ||
        usage.activeAttempts >= Math.min(8, scope.mission.policy.maxParallelAttempts)) break;
      const verdict = authorizeEnvelopeStart(envelope, usage, {
        missionId: scope.missionId,
        envelopeRevision: envelope.revision,
        rootPath: task.root.path,
        requiredTools: ["workspace_sandbox"],
        isFirstTaskStart: task.attemptIds.length === 0,
        now: Date.now(),
        breakerOpen: false,
      });
      if (!verdict.ok) break;
      const command = candidateStartCommand(scope, task, batch.id, batch.attemptIds.length + 1);
      await enqueueStart(scope, task, command, batch.id, batch.instruction);
    }
  }
}

export async function admitStarts(): Promise<void> {
  const scopes = approvedScopes();
  if (!scopes.length) return;
  await admitCandidateStarts(scopes);
  const missionState = useMissions.getState();
  const scopeByMission = new Map(scopes.map((scope) => [scope.missionId, scope]));
  const candidates: SchedulableTask[] = [];
  for (const task of Object.values(missionState.projection.tasks)) {
    const scope = scopeByMission.get(task.missionId);
    const openCandidateBatch = Object.values(missionState.projection.candidateBatches)
      .some((batch) => batch.taskId === task.id && !batch.selectedAttemptId);
    if (openCandidateBatch || !scope || !taskIsInsideApprovedScope(scope, task) || !taskHasSafeMissionPlacement(task)) continue;
    const ordinal = task.attemptIds.length + 1;
    let placement: ReturnType<typeof branchPlacement>;
    try {
      placement = branchPlacement(task, ordinal);
    } catch {
      continue;
    }
    candidates.push({
      task,
      enqueuedAt: task.updatedAt,
      nextEligibleAt: (() => {
        const latestId = task.attemptIds[task.attemptIds.length - 1];
        const latest = latestId ? missionState.projection.attempts[latestId] : null;
        if (latest?.status !== "failed" || latest.finishedAt === null) return null;
        return retryAfterFailure(task, latest.finishedAt, true, {
          baseDelayMs: 5_000,
          maxDelayMs: 5 * 60_000,
          jitterRatio: 0.1,
        }).nextEligibleAt;
      })(),
      worktreePath: placement.cwd === task.root.path ? null : placement.cwd,
    });
  }
  const leases = Object.values(missionState.projection.attempts)
    .map(activeLease)
    .filter((lease): lease is ActiveLease => !!lease);
  const recentTerminal = Object.values(missionState.projection.attempts)
    .filter((attempt) => attempt.status !== "running")
    .sort((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0))
    .slice(0, 20);
  const recentFailureRatio = recentTerminal.length === 0
    ? 0
    : recentTerminal.filter((attempt) => attempt.status === "failed").length / recentTerminal.length;
  const vibe = useVibe.getState();
  const decision = schedule({
    tasks: candidates,
    attempts: Object.values(missionState.projection.attempts),
    activeLeases: leases,
    backendActiveCount: vibe.order.length,
    now: Date.now(),
    limits: {
      globalConcurrency: 8,
      perProjectConcurrency: 8,
      perMissionConcurrency: Object.fromEntries([
        ["default", 1],
        ...scopes.map((scope) => [scope.missionId, Math.min(8, Math.max(1, scope.mission.policy.maxParallelAttempts))]),
      ]) as { default: number } & Record<string, number>,
      hardBackendCap: 48,
      agingIntervalMs: 60_000,
    },
    signals: { recentFailureRatio },
    pausedMissionIds: new Set(
      scopes.filter((scope) => autonomyTripped(scope.mission.projectId)).map((scope) => scope.missionId),
    ),
  });
  const grouped = new Map<string, typeof decision.starts>();
  for (const start of decision.starts) {
    grouped.set(start.missionId, [...(grouped.get(start.missionId) ?? []), start]);
  }
  for (const [missionId, starts] of grouped) {
    const scope = scopeByMission.get(missionId);
    if (!scope) continue;
    const envelope = envelopeFromApprovedScope(scope);
    if (!envelope) continue;
    const plan = planMissionStarts({
      projection: useMissions.getState().projection,
      scheduler: { starts },
      envelope,
      usage: missionUsage(scope, Date.now()),
      now: Date.now(),
      breakerOpen: autonomyTripped(scope.mission.projectId),
      // These are the only capabilities the workspace-only harness actually
      // provides today. Network/GitHub authority is rejected while deriving
      // the envelope instead of being advertised but unenforced.
      capabilitiesForTask: () => ({
        tools: ["workspace_sandbox"],
      }),
      completedOperationIds: new Set(
        Object.values(useMissionOutbox.getState().snapshot.records)
          .filter((record) => record.status === "delivered")
          .map((record) => record.idempotencyKey),
      ),
    });
    for (const command of plan.commands) {
      const task = useMissions.getState().projection.tasks[command.taskId];
      if (task) await enqueueStart(scope, task, command);
    }
  }
}
