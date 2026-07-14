import { closeSession, interrupt, lastTurnOutcomeOf } from "@/lib/vibe/controller";
import { flushVibePersist, useVibe } from "@/lib/vibe/session-store";
import { useMissions } from "./store";
import { useMissionOutbox } from "./outbox-store";
import type { MissionOutboxRecord } from "./outbox";
import { planReportSettlement } from "./runner-core";
import { envelopeStopAction, type StopAction } from "./envelope";
import { parseMissionReportV2, type MissionReportObservation } from "./report-v2";
import {
  deriveApprovedMissionScope,
  envelopeFromApprovedScope,
  taskIsInsideApprovedScope,
  unexpectedChangedFiles,
  missionTaskChangeIssue,
  workerOutcomeDisposition,
  missionTurnEvidence,
} from "./controller-core";
import type { TaskAttempt } from "./types";
import {
  flushMissionOrThrow,
  gitEvidence,
  safeId,
  spawnRecordForAttempt,
} from "./controller-shared";
import { cleanupAttemptRuntimeBestEffort } from "./runtime-lifecycle";
import { dispatchSpawn, requiredCommands } from "./spawn-dispatch";
import {
  baseShaForAttempt,
  recordCommitEvidence,
  recordIndependentReview,
  recordUsage,
  runIndependentGates,
  turnIdForAttempt,
} from "./verification-gates";

const OWNER_ID = "mission-controller";
const CLAIM_MS = 5 * 60_000;
const settling = new Set<string>();

async function durableSettle(
  attempt: TaskAttempt,
  status: Exclude<TaskAttempt["status"], "queued" | "running">,
  summary: string,
  report: Record<string, unknown> | null,
): Promise<void> {
  const completionId = safeId(`${attempt.id}:${status}`, "completion");
  const record = await useMissionOutbox.getState().enqueue({
    kind: "settle",
    missionId: attempt.missionId,
    idempotencyKey: `settle:${attempt.id}`,
    payload: {
      taskId: attempt.taskId,
      attemptId: attempt.id,
      status,
      summary,
      error: status === "failed" ? summary : null,
      completionId,
      report,
    },
  }, { recordId: safeId(`settle:${attempt.id}`, "outbox") });
  await dispatchSettle(record);
}

async function applyStopAction(attempt: TaskAttempt, action: StopAction): Promise<void> {
  if (action === "continue" || action === "needs_human") return;
  const current = useMissions.getState().projection.attempts[attempt.id];
  if (!current || current.status === "running") return;
  const mission = useMissions.getState().projection.missions[attempt.missionId];
  if (!mission || mission.status !== "active") return;
  for (const running of Object.values(useMissions.getState().projection.attempts)) {
    if (running.missionId === attempt.missionId && running.status === "running" &&
      running.id !== attempt.id && running.sessionId) {
      interrupt(running.sessionId);
    }
  }
  if (action === "pause_mission") {
    useMissions.getState().pauseMission(attempt.missionId, {
      actor: "system",
      idempotencyKey: `stop-policy:pause:${attempt.id}`,
    });
  } else if (action === "cancel_mission") {
    useMissions.getState().cancelMission(attempt.missionId, {
      actor: "system",
      idempotencyKey: `stop-policy:cancel:${attempt.id}`,
    });
  }
  await flushMissionOrThrow();
}

async function settleFailure(
  attempt: TaskAttempt,
  summary: string,
  report: Record<string, unknown> | null,
  kind: "runtime" | "regression",
): Promise<void> {
  const task = useMissions.getState().projection.tasks[attempt.taskId];
  const scope = deriveApprovedMissionScope(useMissions.getState().events, attempt.missionId);
  const envelope = scope ? envelopeFromApprovedScope(scope) : null;
  const exhaustedCritical = kind === "runtime" &&
    !!task &&
    task.attemptIds.length >= task.maxAttempts &&
    scope?.mission.policy.stopOnCriticalFailure === true;
  const action = envelope
    ? envelopeStopAction(envelope, {
        regression: kind === "regression",
        conflict: false,
        criticalFailure: exhaustedCritical,
      })
    : "continue";
  await durableSettle(
    attempt,
    action === "needs_human" ? "needs_human" : "failed",
    summary,
    report,
  );
  await applyStopAction(attempt, action);
}

/** Replay-safe projection + receipt application for a durable settle command. */
async function dispatchSettle(record: MissionOutboxRecord): Promise<void> {
  if (record.command.kind !== "settle" || record.status === "dead_letter") return;
  const payload = record.command.payload;
  if (record.status === "delivered") {
    const current = useMissions.getState().projection.attempts[payload.attemptId];
    if (current?.status === "running") {
      useMissions.getState().settleAttempt(record.missionId, payload.attemptId, {
        status: payload.status,
        summary: payload.summary ?? null,
        error: payload.error ?? null,
        report: payload.report ?? null,
      }, { actor: "system", idempotencyKey: `settle-event:${payload.completionId}` });
      await flushMissionOrThrow();
    }
    if (current) await cleanupAttemptRuntimeBestEffort(current);
    if (current?.sessionId && useVibe.getState().sessions[current.sessionId]) {
      await closeSession(current.sessionId);
      await flushVibePersist();
    }
    return;
  }
  const claimed = await useMissionOutbox.getState().claim(record.id, OWNER_ID, { leaseMs: CLAIM_MS });
  if (!claimed || claimed.command.kind !== "settle" || !claimed.lease) return;
  try {
    const current = useMissions.getState().projection.attempts[payload.attemptId];
    if (!current) throw new Error("settle attempt is missing");
    if (current.status !== "running" && current.status !== payload.status) {
      throw new Error(`settle status conflicts with terminal attempt (${current.status})`);
    }
    if (current?.status === "running") {
      useMissions.getState().settleAttempt(record.missionId, payload.attemptId, {
        status: payload.status,
        summary: payload.summary ?? null,
        error: payload.error ?? null,
        report: payload.report ?? null,
      }, { actor: "system", idempotencyKey: `settle-event:${payload.completionId}` });
      await flushMissionOrThrow();
    }
    await useMissionOutbox.getState().deliver(claimed.id, claimed.lease.claimId, {
      completionId: payload.completionId,
      attemptId: payload.attemptId,
      status: payload.status,
    });
    await cleanupAttemptRuntimeBestEffort(current);
    if (current.sessionId && useVibe.getState().sessions[current.sessionId]) {
      await closeSession(current.sessionId);
      await flushVibePersist();
    }
  } catch (error) {
    await useMissionOutbox.getState().fail(
      claimed.id,
      claimed.lease.claimId,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function settleCompletedAttempt(attempt: TaskAttempt): Promise<void> {
  if (!attempt.sessionId || settling.has(attempt.id)) return;
  const entry = useVibe.getState().sessions[attempt.sessionId];
  if (!entry || useVibe.getState().busy[attempt.sessionId]) return;
  const expectedTurnId = turnIdForAttempt(attempt.id);
  if (!expectedTurnId) return;
  const transientOutcome = lastTurnOutcomeOf(attempt.sessionId);
  const turnEvidence = missionTurnEvidence(entry.order, entry.items, expectedTurnId);
  const report = parseMissionReportV2(turnEvidence.assistantText);
  const outcome = transientOutcome?.turnId === expectedTurnId
    ? transientOutcome.outcome
    : (turnEvidence.reportStamped ? "completed" : null);
  if (!outcome) {
    const spawn = spawnRecordForAttempt(attempt.id);
    const deliveredAt = spawn?.delivery?.deliveredAt ?? Date.now();
    // After restart transient outcome state is gone. A persistently idle lane
    // with no report cannot be called successful; allow a short event-replay
    // grace, then settle failed so bounded retry can use a fresh worker.
    if (Date.now() - deliveredAt < 2 * 60_000) return;
    await settleFailure(attempt, "Worker became idle without completion evidence for its bound turn", report as unknown as Record<string, unknown> | null, "runtime");
    return;
  }
  settling.add(attempt.id);
  try {
    await recordUsage(attempt);
    const disposition = workerOutcomeDisposition(outcome);
    if (disposition === "cancelled" || disposition === "failed") {
      if (disposition === "cancelled") {
        await durableSettle(attempt, "cancelled", `Worker turn ended as ${outcome}`, report as unknown as Record<string, unknown> | null);
      } else {
        await settleFailure(
          attempt,
          `Worker turn ended as ${outcome}`,
          report as unknown as Record<string, unknown> | null,
          "runtime",
        );
      }
      return;
    }
    if (!report) {
      await settleFailure(attempt, "Worker completed without a valid Mission Report v2", null, "runtime");
      return;
    }
    const task = useMissions.getState().projection.tasks[attempt.taskId];
    const scope = deriveApprovedMissionScope(useMissions.getState().events, attempt.missionId);
    if (!task || !scope || !taskIsInsideApprovedScope(scope, task)) {
      await durableSettle(attempt, "failed", "Task changed outside its approved Mission scope", report as unknown as Record<string, unknown>);
      return;
    }
    if (report.status !== "succeeded") {
      const decision = planReportSettlement({
        projection: useMissions.getState().projection,
        report,
        observation: null,
        finishedAt: Date.now(),
        operationId: `settle:${attempt.id}`,
        completedOperationIds: new Set(),
      });
      if (!decision.ok) throw new Error(decision.reason);
      await durableSettle(attempt, report.status, report.summary, report as unknown as Record<string, unknown>);
      return;
    }
    const base = baseShaForAttempt(attempt.id);
    if (!base) throw new Error("durable base SHA evidence is missing");
    const evidence = await gitEvidence(base.cwd, base.baseSha);
    if (evidence.dirty) throw new Error("worktree is dirty; success requires committed evidence");
    if (!evidence.base_is_ancestor) throw new Error("approved base SHA is not an ancestor of worker HEAD");
    if (base.branch && evidence.branch !== base.branch) {
      throw new Error("worker HEAD is no longer on its approved worktree branch");
    }
    const outsideScope = unexpectedChangedFiles(task, evidence.files_changed);
    if (outsideScope.length > 0) {
      throw new Error(`worker changed files outside the approved task scope: ${outsideScope.slice(0, 20).join(", ")}`);
    }
    const changeIssue = missionTaskChangeIssue(task, evidence);
    if (changeIssue) throw new Error(changeIssue);
    const required = requiredCommands(scope, task);
    // Persist Git/review evidence before running commands. Both are bound to
    // the exact final HEAD and remain immutable attempt history.
    await recordCommitEvidence(attempt, evidence);
    const reviewArtifactId = await recordIndependentReview(attempt, task, evidence);
    const gateEvidence = await runIndependentGates(
      scope,
      attempt,
      task,
      evidence,
      reviewArtifactId,
    );
    const observation: MissionReportObservation = {
      headSha: evidence.head_sha,
      baseSha: evidence.base_sha,
      diffSha256: evidence.diff_sha256,
      filesChanged: evidence.files_changed,
      commands: gateEvidence.commands,
      requiredCommands: required,
    };
    const decision = planReportSettlement({
      projection: useMissions.getState().projection,
      report,
      observation,
      finishedAt: Date.now(),
      operationId: `settle:${attempt.id}`,
      completedOperationIds: new Set(),
    });
    if (!decision.ok) throw new Error(decision.reason);
    if (gateEvidence.failed.length > 0) {
      throw new Error(`native quality gates failed: ${gateEvidence.failed.join(", ")}`);
    }
    await durableSettle(attempt, "succeeded", report.summary, report as unknown as Record<string, unknown>);
  } catch (error) {
    await settleFailure(
      attempt,
      error instanceof Error ? error.message : String(error),
      report ? report as unknown as Record<string, unknown> : null,
      report?.status === "succeeded" ? "regression" : "runtime",
    );
  } finally {
    settling.delete(attempt.id);
  }
}

export async function recoverOutboxAndAttempts(): Promise<void> {
  const outbox = Object.values(useMissionOutbox.getState().snapshot.records);
  const records = outbox
    .filter((record) => record.command.kind === "spawn" &&
      record.status !== "delivered" && record.status !== "dead_letter" &&
      record.nextAttemptAt <= Date.now())
    .sort((left, right) => left.createdAt - right.createdAt);
  for (const record of records) await dispatchSpawn(record);

  const settlements = outbox
    .filter((record) => record.command.kind === "settle" &&
      record.status !== "dead_letter" &&
      (record.status === "delivered" || record.nextAttemptAt <= Date.now()))
    .sort((left, right) => left.createdAt - right.createdAt);
  for (const record of settlements) await dispatchSettle(record);

  for (const attempt of Object.values(useMissions.getState().projection.attempts)) {
    if (attempt.status !== "running") {
      await cleanupAttemptRuntimeBestEffort(attempt);
      const spawn = spawnRecordForAttempt(attempt.id);
      const ownedSessionId = spawn?.command.kind === "spawn"
        ? (spawn.command.payload.sessionId ?? safeId(attempt.id, "ms"))
        : null;
      if (attempt.sessionId && attempt.sessionId === ownedSessionId &&
        useVibe.getState().sessions[attempt.sessionId]) {
        await closeSession(attempt.sessionId);
        await flushVibePersist();
      }
      continue;
    }
    const spawn = spawnRecordForAttempt(attempt.id);
    if (!spawn || spawn.status === "dead_letter" ||
      (spawn.status === "delivered" &&
        (!attempt.sessionId || !useVibe.getState().sessions[attempt.sessionId]))) {
      await durableSettle(attempt, "failed", "Recovered running attempt has no deliverable spawn command", null);
    }
  }
}

export function isOwnedMissionAttempt(attempt: TaskAttempt): boolean {
  if (!attempt.sessionId) return false;
  const spawn = spawnRecordForAttempt(attempt.id);
  return spawn?.command.kind === "spawn" &&
    attempt.sessionId === (spawn.command.payload.sessionId ?? safeId(attempt.id, "ms"));
}
