import { addWorktree, listWorktrees, removeWorktree, resolveWorktreeMainRoot } from "@/lib/worktree";
import { useSwarm } from "@/store";
import {
  sendMessageStrict,
  startSession,
} from "@/lib/vibe/controller";
import { flushVibePersist, useVibe } from "@/lib/vibe/session-store";
import { useMissions } from "./store";
import { useMissionOutbox } from "./outbox-store";
import type { MissionOutboxRecord } from "./outbox";
import type { StartAttemptCommand } from "./runner-core";
import { MISSION_REPORT_V2_SCHEMA } from "./report-v2";
import {
  deterministicMissionBranch,
  missionAttemptPrompt,
  predictedWorktreePath,
  taskHasSafeMissionPlacement,
  exactPromptTurnId,
  shouldCleanupRuntimeAfterSpawnFailure,
  type ApprovedMissionScope,
} from "./controller-core";
import type { MissionTask } from "./types";
import {
  cleanupBoundMissionRuntime,
  prepareBoundMissionRuntime,
  resumePreparedBoundMissionRuntime,
  type MissionRuntimeContext,
} from "./runtime-binding";
import {
  runtimeBindingForMission,
  runtimePreparedReceipt,
  recordRuntimePrepared,
} from "./runtime-lifecycle";
import {
  flushMissionOrThrow,
  gitEvidence,
  safeId,
  spawnRecordForAttempt,
} from "./controller-shared";
import { sessionMatchesSpawn, spawnProjectionIssue } from "./recovery-core";

const OWNER_ID = "mission-controller";
const CLAIM_MS = 5 * 60_000;

export function requiredCommands(scope: ApprovedMissionScope, task: MissionTask): string[] {
  const projection = useMissions.getState().projection;
  return [...new Set([
    ...(scope.mission.policy.qualityCommands ?? []),
    ...task.qualityGateIds
      .map((id) => projection.qualityGates[id])
      .filter((gate) => gate?.required && gate.command)
      .map((gate) => gate.command as string),
  ])];
}

export async function ensureRequiredGates(scope: ApprovedMissionScope, task: MissionTask): Promise<void> {
  const store = useMissions.getState();
  const projection = store.projection;
  const existing = task.qualityGateIds.map((id) => projection.qualityGates[id]).filter(Boolean);
  const commands = scope.mission.policy.qualityCommands ?? [];
  for (const command of commands) {
    if (existing.some((gate) => gate.command === command && gate.required)) continue;
    store.addQualityGate(task.missionId, {
      id: safeId(`${task.id}:${command}`, "gate"),
      taskId: task.id,
      kind: "custom",
      label: `Approved quality command: ${command.slice(0, 120)}`,
      command,
      required: true,
    }, { actor: "system", idempotencyKey: `gate:${task.id}:${command}` });
  }
  if (scope.mission.policy.requireQualityGates &&
    !task.qualityGateIds.some((id) => projection.qualityGates[id]?.required) && commands.length === 0) {
    store.addQualityGate(task.missionId, {
      id: safeId(`${task.id}:git-evidence`, "gate"),
      taskId: task.id,
      kind: "review",
      label: "Independent Git evidence",
      command: null,
      required: true,
    }, { actor: "system", idempotencyKey: `gate:${task.id}:git-evidence` });
  }
  await flushMissionOrThrow();
}

export function branchPlacement(task: MissionTask, ordinal: number, resolvedRoot?: string): {
  cwd: string;
  root?: string;
  branch?: string;
} {
  if (task.worktreePolicy.mode === "none") return { cwd: task.root.path };
  if (task.worktreePolicy.mode === "shared") {
    const sharedWithTaskId = task.worktreePolicy.sharedWithTaskId;
    const shared = Object.values(useMissions.getState().projection.attempts)
      .filter((attempt) => attempt.taskId === sharedWithTaskId)
      .sort((left, right) => right.ordinal - left.ordinal)[0];
    const record = shared ? spawnRecordForAttempt(shared.id) : null;
    if (!record || record.command.kind !== "spawn") {
      throw new Error("shared worktree is not durably known");
    }
    return { cwd: record.command.payload.cwd };
  }
  const branch = deterministicMissionBranch(task.missionId, task.id, ordinal);
  const root = resolvedRoot ?? task.root.path;
  return {
    cwd: predictedWorktreePath(root, branch),
    root,
    branch,
  };
}

export async function enqueueStart(
  scope: ApprovedMissionScope,
  task: MissionTask,
  command: StartAttemptCommand,
  candidateBatchId: string | null = null,
  candidateInstruction = "",
): Promise<void> {
  if (!taskHasSafeMissionPlacement(task)) {
    throw new Error("autonomous Mission workers require a new or explicitly shared worktree");
  }
  await ensureRequiredGates(scope, task);
  const sessionId = safeId(command.attemptId, "ms");
  const gitBin = useSwarm.getState().settings.gitPath?.trim() || undefined;
  const resolvedRoot = task.worktreePolicy.mode === "new"
    ? await resolveWorktreeMainRoot(task.root.path, gitBin)
    : undefined;
  const placement = branchPlacement(task, command.ordinal, resolvedRoot);
  const initialEvidence = await gitEvidence(placement.root ?? placement.cwd, null);
  const baseSha = initialEvidence.head_sha;
  const commands = requiredCommands(scope, useMissions.getState().projection.tasks[task.id]);
  const prompt = [
    missionAttemptPrompt(task, command.attemptId),
    candidateBatchId
      ? `Candidate comparison run ${candidateBatchId}. Produce an independent solution in this fresh worktree. Human comparison instruction: ${candidateInstruction}`
      : "",
    `Approved base SHA: ${baseSha}\nFor report evidence use exactly this committed range: ${baseSha}..HEAD. Compute diff_sha256 from: git diff --no-ext-diff --no-textconv --binary ${baseSha}..HEAD | shasum -a 256. Compute files_changed from the same range.`,
    commands.length ? `Required verification commands (run exactly and report exit codes):\n${commands.map((item) => `- ${item}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  useMissions.getState().createAttempt(task.missionId, task.id, {
    id: command.attemptId,
    sessionId,
    workerLabel: command.worker.label,
    candidateBatchId,
  }, {
    actor: "scheduler",
    idempotencyKey: command.operationId,
    occurredAt: Date.now(),
  });
  await flushMissionOrThrow();
  const record = await useMissionOutbox.getState().enqueue({
    kind: "spawn",
    missionId: task.missionId,
    idempotencyKey: command.operationId,
    payload: {
      taskId: task.id,
      attemptId: command.attemptId,
      sessionId,
      projectId: task.root.projectId,
      cwd: placement.cwd,
      root: placement.root,
      branch: placement.branch,
      baseSha,
      copyEnv: false,
      prompt,
    },
  }, { recordId: safeId(command.operationId, "outbox") });
  await dispatchSpawn(record);
}

export async function ensureSpawnWorktree(record: MissionOutboxRecord): Promise<void> {
  if (record.command.kind !== "spawn") return;
  const payload = record.command.payload;
  if (!payload.root || !payload.branch) return;
  const gitBin = useSwarm.getState().settings.gitPath?.trim() || undefined;
  const scan = await listWorktrees([payload.root], gitBin);
  if (scan.entries.some((entry) => entry.branch === payload.branch && entry.path === payload.cwd)) return;
  const created = await addWorktree({
    cwd: payload.root,
    branch: payload.branch,
    copyEnv: payload.copyEnv ?? false,
    baseSha: payload.baseSha,
    gitBin,
  });
  if (created.path !== payload.cwd || created.branch !== payload.branch) {
    try {
      await removeWorktree({
        root: created.root,
        path: created.path,
        branch: created.branch,
        force: false,
        gitBin,
      });
    } catch {
      // Preserve the original deterministic-placement failure. The removal
      // itself is gated/non-force and never broadens cleanup authority.
    }
    throw new Error("created worktree does not match its durable spawn command");
  }
}

export function promptTurnId(sessionId: string, prompt: string): string | null | undefined {
  const entry = useVibe.getState().sessions[sessionId];
  return entry ? exactPromptTurnId(entry.order, entry.items, prompt) : undefined;
}

export async function dispatchSpawn(record: MissionOutboxRecord): Promise<void> {
  if (record.command.kind !== "spawn" || record.status === "delivered") return;
  const claimed = await useMissionOutbox.getState().claim(record.id, OWNER_ID, { leaseMs: CLAIM_MS });
  if (!claimed || claimed.command.kind !== "spawn" || !claimed.lease) return;
  const payload = claimed.command.payload;
  const runtimeBinding = runtimeBindingForMission(record.missionId);
  let runtimeContext: MissionRuntimeContext | null = null;
  let runtimeLaunched = false;
  let turnStarted = false;
  let runtimePreparedDurable = false;
  try {
    const projectionIssue = spawnProjectionIssue(
      useMissions.getState().projection,
      claimed,
    );
    if (projectionIssue) throw new Error(projectionIssue);
    await ensureSpawnWorktree(claimed);
    const base = await gitEvidence(payload.cwd, null);
    if (payload.baseSha && base.head_sha.toLowerCase() !== payload.baseSha.toLowerCase()) {
      throw new Error("worktree start HEAD does not match the durable approved base SHA");
    }
    if (payload.branch && base.branch !== payload.branch) {
      throw new Error("worktree branch does not match the durable spawn command");
    }
    let effectivePrompt = payload.prompt;
    if (runtimeBinding) {
      const mission = useMissions.getState().projection.missions[record.missionId];
      if (!mission) throw new Error("Mission runtime cannot resolve its project");
      if (!payload.root) throw new Error("Mission runtime requires an owned main repository root");
      const boundRuntimeContext: MissionRuntimeContext = {
        projectId: mission.projectId,
        mainRoot: payload.root,
        projectRoot: payload.cwd,
        missionId: record.missionId,
        attemptId: payload.attemptId,
      };
      runtimeContext = boundRuntimeContext;
      const prepared = runtimePreparedReceipt(payload.attemptId, runtimeBinding, boundRuntimeContext);
      runtimePreparedDurable = prepared;
      if (!prepared) {
        const preparedResult = await prepareBoundMissionRuntime(runtimeBinding, boundRuntimeContext);
        runtimeLaunched = true;
        const attempt = useMissions.getState().projection.attempts[payload.attemptId];
        if (!attempt) throw new Error("Mission runtime attempt disappeared before its receipt");
        await recordRuntimePrepared(attempt, runtimeBinding, boundRuntimeContext, preparedResult);
        runtimePreparedDurable = true;
      }
      const launched = await resumePreparedBoundMissionRuntime(runtimeBinding, boundRuntimeContext);
      runtimeLaunched = true;
      effectivePrompt = `${payload.prompt}\n\n${launched.prompt}`;
    }
    const sessionId = payload.sessionId ?? safeId(payload.attemptId, "ms");
    const existingSession = useVibe.getState().sessions[sessionId]?.session;
    if (existingSession && !sessionMatchesSpawn(existingSession, claimed)) {
      throw new Error("persisted session disagrees with the durable Mission spawn command");
    }
    if (!existingSession) {
      await startSession({
        id: sessionId,
        name: `Task ${payload.taskId}`,
        agentName: `Task ${payload.taskId}`,
        projectDir: payload.cwd,
        projectId: payload.projectId,
        // Mission lanes have their own durable lifecycle and must never wake
        // the generic Conductor finish/approval autonomy loop.
        spawnedBy: "mission",
        worktree: payload.root && payload.branch
          ? { root: payload.root, branch: payload.branch, shared: false }
          : null,
        access: "workspace",
      });
    }
    let turnId: string | null = null;
    const persistedTurnId = promptTurnId(sessionId, effectivePrompt);
    if (persistedTurnId === undefined) {
      const ack = await sendMessageStrict(sessionId, effectivePrompt, {
        outputSchema: MISSION_REPORT_V2_SCHEMA as unknown as Record<string, unknown>,
        via: "conductor",
        requireWorkspace: true,
        missionController: true,
      });
      turnId = ack.turnId;
    } else if (persistedTurnId === null) {
      throw new Error("persisted Mission prompt is not yet bound to an acknowledged turn");
    } else {
      // Success-before-outbox-ack crash window: the exact durable prompt is
      // authoritative enough to adopt its already acknowledged turn.
      turnId = persistedTurnId;
    }
    if (!turnId) throw new Error("Mission turn start did not return a durable turn id");
    turnStarted = true;
    await flushVibePersist();
    await useMissionOutbox.getState().deliver(claimed.id, claimed.lease.claimId, {
      sessionId,
      turnId,
      cwd: payload.cwd,
      branch: payload.branch ?? null,
      baseSha: payload.baseSha ?? base.head_sha,
    });
  } catch (error) {
    // `recordArtifact` mutates the projection before its awaited save. If the
    // save fails, that dirty prepared receipt may later become durable via the
    // coordinator retry. Never tear setup down beneath such a receipt: doing
    // so would persist a setup-done claim for an environment we just removed.
    let preparedRecorded = runtimePreparedDurable;
    if (!preparedRecorded && runtimeBinding && runtimeContext) {
      try {
        preparedRecorded = runtimePreparedReceipt(payload.attemptId, runtimeBinding, runtimeContext);
      } catch {
        preparedRecorded = true;
      }
    }
    if (shouldCleanupRuntimeAfterSpawnFailure({
      runtimeLaunched,
      preparedRecorded,
      turnStarted,
    }) && runtimeBinding && runtimeContext) {
      try {
        await cleanupBoundMissionRuntime(runtimeBinding, runtimeContext);
      } catch {
        // Spawn remains retryable and the deterministic instance is reconciled
        // on the next dispatch without touching unrelated processes.
      }
    }
    await useMissionOutbox.getState().fail(
      claimed.id,
      claimed.lease.claimId,
      error instanceof Error ? error.message : String(error),
    );
  }
}
