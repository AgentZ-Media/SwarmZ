import { invoke } from "@tauri-apps/api/core";
import { retryAfterFailure, schedule } from "@/lib/scheduler/core";
import type { ActiveLease, SchedulableTask } from "@/lib/scheduler/types";
import { addWorktree, listWorktrees, removeWorktree, resolveWorktreeMainRoot } from "@/lib/worktree";
import { autonomyTripped } from "@/lib/orchestrator/autonomy";
import { persistenceIssues } from "@/lib/persistence/coordinator";
import { useSwarm } from "@/store";
import {
  closeSession,
  interrupt,
  lastTurnOutcomeOf,
  reviewSession,
  sendMessageStrict,
  startSession,
} from "@/lib/vibe/controller";
import { flushVibePersist, useVibe } from "@/lib/vibe/session-store";
import {
  flushMissionsPersist,
  useMissions,
} from "./store";
import { useMissionOutbox } from "./outbox-store";
import type { MissionOutboxRecord } from "./outbox";
import { planMissionStarts, planReportSettlement, type StartAttemptCommand } from "./runner-core";
import { authorizeEnvelopeStart, envelopeStopAction, type StopAction } from "./envelope";
import {
  MISSION_REPORT_V2_SCHEMA,
  parseMissionReportV2,
  type MissionReportObservation,
} from "./report-v2";
import {
  deriveApprovedMissionScope,
  deterministicMissionBranch,
  envelopeFromApprovedScope,
  missionAttemptPrompt,
  predictedWorktreePath,
  taskIsInsideApprovedScope,
  unexpectedChangedFiles,
  taskHasSafeMissionPlacement,
  missionTaskChangeIssue,
  finalHeadEvidenceMatches,
  workerOutcomeDisposition,
  exactPromptTurnId,
  missionTurnEvidence,
  missionHardStopReason,
  shouldCleanupRuntimeAfterSpawnFailure,
  type ApprovedMissionScope,
} from "./controller-core";
import type { MissionArtifact, MissionTask, TaskAttempt } from "./types";
import type { MissionRuntimeBinding } from "./types";
import { useRuntimeEnvironments } from "@/lib/runtime/store";
import {
  cleanupBoundMissionRuntime,
  prepareBoundMissionRuntime,
  resumePreparedBoundMissionRuntime,
  resolveProjectMissionRuntime,
  type MissionRuntimeContext,
} from "./runtime-binding";
import { runtimeEnvironmentInstanceId, type RuntimeLaunchResult } from "@/lib/runtime/controller";
import { parseApprovedArgv } from "@/lib/integration/controller-core";
import { runAcceptanceCommand } from "@/lib/integration/native";

const TICK_MS = 1_000;
const OWNER_ID = "mission-controller";
const CLAIM_MS = 5 * 60_000;

interface MissionGitEvidence {
  base_sha: string;
  head_sha: string;
  diff_sha256: string;
  files_changed: string[];
  dirty: boolean;
  branch: string | null;
  base_is_ancestor: boolean;
}

let stopActiveController: (() => void) | null = null;
let tickRunning = false;
const settling = new Set<string>();

function safeId(value: string, prefix: string): string {
  const slug = value.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 70) || "item";
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${prefix}-${slug}-${(hash >>> 0).toString(36)}`;
}

function missionPersistenceReady(): boolean {
  const missions = useMissions.getState();
  const outbox = useMissionOutbox.getState();
  return missions.hydrateStatus === "ready" &&
    missions.hydrated &&
    outbox.hydrateStatus === "ready" &&
    outbox.snapshot.hydration === "ready" &&
    useVibe.getState().hydrateStatus === "ready" &&
    useRuntimeEnvironments.getState().hydrated &&
    !persistenceIssues().some((issue) =>
      issue.name === "missions" || issue.name === "missionOutbox" ||
      issue.name === "vibeSessions" || issue.name === "runtimeEnvironments",
    );
}

function runtimeBindingForMission(missionId: string): MissionRuntimeBinding | null {
  return useMissions.getState().projection.missions[missionId]?.policy.runtimeEnvironment ?? null;
}

function runtimeContextForAttempt(attempt: TaskAttempt): MissionRuntimeContext | null {
  const spawn = spawnRecordForAttempt(attempt.id);
  const mission = useMissions.getState().projection.missions[attempt.missionId];
  if (!mission || !spawn || spawn.command.kind !== "spawn" || !spawn.command.payload.root) return null;
  return {
    projectId: mission.projectId,
    mainRoot: spawn.command.payload.root,
    projectRoot: spawn.command.payload.cwd,
    missionId: attempt.missionId,
    attemptId: attempt.id,
  };
}

async function cleanupAttemptRuntimeBestEffort(attempt: TaskAttempt): Promise<void> {
  const binding = runtimeBindingForMission(attempt.missionId);
  const context = runtimeContextForAttempt(attempt);
  if (!binding || !context) return;
  const artifactId = safeId(attempt.id, "runtime-cleanup");
  if (useMissions.getState().projection.artifacts[artifactId]) return;
  try {
    await cleanupBoundMissionRuntime(binding, context);
    useMissions.getState().recordArtifact(attempt.missionId, {
      id: artifactId,
      taskId: attempt.taskId,
      attemptId: attempt.id,
      kind: "other",
      label: "Runtime Environment cleaned",
      uri: null,
      metadata: {
        environmentId: binding.environmentId,
        specFingerprint: binding.specFingerprint,
      },
    }, { actor: "system", idempotencyKey: `runtime-cleanup:${attempt.id}` });
    await flushMissionOrThrow();
  } catch (error) {
    console.warn("[missions] runtime cleanup will retry:", error instanceof Error ? error.message : "unknown error");
  }
}

function runtimePreparedReceipt(
  attemptId: string,
  binding: MissionRuntimeBinding,
  context: MissionRuntimeContext,
): boolean {
  const artifact = useMissions.getState().projection.artifacts[safeId(attemptId, "runtime-prepared")];
  if (!artifact) return false;
  const expectedInstance = runtimeEnvironmentInstanceId(context, binding.environmentId);
  if (artifact.attemptId !== attemptId ||
    artifact.metadata.environmentId !== binding.environmentId ||
    artifact.metadata.specFingerprint !== binding.specFingerprint ||
    artifact.metadata.instanceId !== expectedInstance ||
    artifact.metadata.projectRoot !== context.projectRoot ||
    artifact.metadata.mainRoot !== context.mainRoot ||
    artifact.metadata.projectId !== context.projectId) {
    throw new Error("durable Runtime Environment receipt conflicts with this attempt");
  }
  return true;
}

async function recordRuntimePrepared(
  attempt: TaskAttempt,
  binding: MissionRuntimeBinding,
  context: MissionRuntimeContext,
  result: RuntimeLaunchResult,
): Promise<void> {
  const id = safeId(attempt.id, "runtime-prepared");
  if (useMissions.getState().projection.artifacts[id]) return;
  useMissions.getState().recordArtifact(attempt.missionId, {
    id,
    taskId: attempt.taskId,
    attemptId: attempt.id,
    kind: "other",
    label: "Runtime Environment prepared",
    uri: null,
    // Receipt intentionally excludes argv, env maps, secret references,
    // output and port-variable names. All are resolved again from the
    // fingerprint-checked spec and native service leases.
    metadata: {
      environmentId: binding.environmentId,
      specFingerprint: binding.specFingerprint,
      instanceId: result.instanceId,
      projectId: context.projectId,
      mainRoot: context.mainRoot,
      projectRoot: context.projectRoot,
      serviceIds: result.services.map((service) => service.serviceId).sort(),
    },
  }, { actor: "system", idempotencyKey: `runtime-prepared:${attempt.id}` });
  await flushMissionOrThrow();
}

async function flushMissionOrThrow(): Promise<void> {
  await flushMissionsPersist();
  const issue = persistenceIssues().find((value) => value.name === "missions");
  if (issue) throw new Error("Mission event log is not durable");
}

function approvedScopes(): ApprovedMissionScope[] {
  const state = useMissions.getState();
  return Object.values(state.projection.missions)
    .filter((mission) => mission.status === "active")
    .map((mission) => deriveApprovedMissionScope(state.events, mission.id))
    .filter((scope): scope is ApprovedMissionScope => !!scope)
    .sort((left, right) => left.approvedAt - right.approvedAt || left.missionId.localeCompare(right.missionId));
}

function spawnRecordForAttempt(attemptId: string): MissionOutboxRecord | null {
  return Object.values(useMissionOutbox.getState().snapshot.records).find((record) =>
    record.command.kind === "spawn" && record.command.payload.attemptId === attemptId,
  ) ?? null;
}

function activeLease(attempt: TaskAttempt): ActiveLease | null {
  if (attempt.status !== "running" || !attempt.sessionId) return null;
  const entry = useVibe.getState().sessions[attempt.sessionId];
  const task = useMissions.getState().projection.tasks[attempt.taskId];
  if (!task) return null;
  const spawn = spawnRecordForAttempt(attempt.id);
  const cwd = entry?.session.projectDir ??
    (spawn?.command.kind === "spawn" ? spawn.command.payload.cwd : task.root.path);
  return {
    taskId: task.id,
    attemptId: attempt.id,
    missionId: task.missionId,
    projectId: task.root.projectId,
    backendId: attempt.sessionId,
    rootPath: task.root.path,
    worktreePath: cwd === task.root.path ? null : cwd,
    acquiredAt: attempt.startedAt ?? 0,
    declaredFiles: task.declaredFiles,
    declaredGlobs: task.declaredGlobs,
    resourceKeys: [],
  };
}

function tokenCount(sessionId: string | null): number {
  if (!sessionId) return 0;
  const total = useVibe.getState().sessions[sessionId]?.tokenUsage?.total;
  if (!total) return 0;
  const explicit = total.total_tokens;
  if (typeof explicit === "number" && Number.isFinite(explicit)) return Math.max(0, explicit);
  return ["input_tokens", "output_tokens", "cached_input_tokens"]
    .reduce((sum, key) => sum + (typeof total[key] === "number" ? Math.max(0, total[key]) : 0), 0);
}

function missionUsage(scope: ApprovedMissionScope, now: number) {
  const projection = useMissions.getState().projection;
  const attempts = Object.values(projection.attempts).filter((attempt) =>
    attempt.missionId === scope.missionId && scope.tasks[attempt.taskId],
  );
  const historicalTokens = Object.values(projection.artifacts)
    .filter((artifact) => artifact.missionId === scope.missionId && artifact.label === "mission-usage")
    .reduce((sum, artifact) => sum +
      (typeof artifact.metadata.tokens === "number" ? Math.max(0, artifact.metadata.tokens) : 0), 0);
  const active = attempts.filter((attempt) => attempt.status === "running");
  return {
    tasksStarted: new Set(attempts.map((attempt) => attempt.taskId)).size,
    attemptsStarted: attempts.length,
    tokensUsed: historicalTokens + active.reduce((sum, attempt) => sum + tokenCount(attempt.sessionId), 0),
    activeMs: attempts.reduce((sum, attempt) =>
      sum + Math.max(0, (attempt.finishedAt ?? now) - (attempt.startedAt ?? now)), 0),
    // SwarmZ has no trustworthy price feed. A configured cost cap therefore
    // pauses starts fail-closed instead of pretending unknown cost is zero.
    costUsd: scope.mission.budget.maxCostUsd === null ? 0 : Number.NaN,
    activeAttempts: active.length,
  };
}

function requiredCommands(scope: ApprovedMissionScope, task: MissionTask): string[] {
  const projection = useMissions.getState().projection;
  return [...new Set([
    ...(scope.mission.policy.qualityCommands ?? []),
    ...task.qualityGateIds
      .map((id) => projection.qualityGates[id])
      .filter((gate) => gate?.required && gate.command)
      .map((gate) => gate.command as string),
  ])];
}

async function ensureRequiredGates(scope: ApprovedMissionScope, task: MissionTask): Promise<void> {
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

function branchPlacement(task: MissionTask, ordinal: number, resolvedRoot?: string): {
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

async function enqueueStart(
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

async function ensureSpawnWorktree(record: MissionOutboxRecord): Promise<void> {
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

async function gitEvidence(cwd: string, baseSha: string | null): Promise<MissionGitEvidence> {
  return invoke<MissionGitEvidence>("mission_git_evidence", {
    cwd,
    baseSha,
    bin: useSwarm.getState().settings.gitPath?.trim() || null,
  });
}

function promptTurnId(sessionId: string, prompt: string): string | null | undefined {
  const entry = useVibe.getState().sessions[sessionId];
  return entry ? exactPromptTurnId(entry.order, entry.items, prompt) : undefined;
}

async function dispatchSpawn(record: MissionOutboxRecord): Promise<void> {
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
    if (!useVibe.getState().sessions[sessionId]) {
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

function baseShaForAttempt(attemptId: string): { cwd: string; baseSha: string; branch: string | null } | null {
  const record = spawnRecordForAttempt(attemptId);
  if (!record || record.command.kind !== "spawn" || record.status !== "delivered") return null;
  const baseSha = record.delivery?.receipt.baseSha;
  return typeof baseSha === "string"
    ? { cwd: record.command.payload.cwd, baseSha, branch: record.command.payload.branch ?? null }
    : null;
}

function turnIdForAttempt(attemptId: string): string | null {
  const record = spawnRecordForAttempt(attemptId);
  const turnId = record?.delivery?.receipt.turnId;
  return typeof turnId === "string" && turnId ? turnId : null;
}

async function recordUsage(attempt: TaskAttempt): Promise<void> {
  const id = safeId(attempt.id, "usage");
  if (useMissions.getState().projection.artifacts[id]) return;
  useMissions.getState().recordArtifact(attempt.missionId, {
    id,
    taskId: attempt.taskId,
    attemptId: attempt.id,
    kind: "other",
    label: "mission-usage",
    uri: null,
    metadata: {
      authority: "swarmz_native",
      evidenceKind: "usage",
      tokens: tokenCount(attempt.sessionId),
      costUsd: null,
    },
  }, { actor: "system", idempotencyKey: `usage:${attempt.id}` });
  await flushMissionOrThrow();
}

async function recordCommitEvidence(
  attempt: TaskAttempt,
  evidence: MissionGitEvidence,
): Promise<void> {
  const id = safeId(attempt.id, "commit");
  const existing = useMissions.getState().projection.artifacts[id];
  if (existing) {
    if (existing.metadata.commit !== evidence.head_sha ||
      existing.metadata.baseSha !== evidence.base_sha ||
      existing.metadata.diffSha256 !== evidence.diff_sha256 ||
      JSON.stringify(existing.metadata.filesChanged) !== JSON.stringify(evidence.files_changed)) {
      throw new Error("attempt commit evidence conflicts with the previously durable final HEAD");
    }
    return;
  }
  useMissions.getState().recordArtifact(attempt.missionId, {
    id,
    taskId: attempt.taskId,
    attemptId: attempt.id,
    kind: "commit",
    label: "Verified attempt commit",
    uri: `git:${evidence.head_sha}`,
    metadata: {
      authority: "swarmz_native",
      evidenceKind: "commit",
      commit: evidence.head_sha,
      finalHead: evidence.head_sha,
      baseSha: evidence.base_sha,
      diffSha256: evidence.diff_sha256,
      filesChanged: evidence.files_changed,
    },
  }, { actor: "system", idempotencyKey: `commit-evidence:${attempt.id}` });
  await flushMissionOrThrow();
}

interface IndependentGateEvidence {
  commands: Record<string, number>;
  failed: string[];
}

function exactAttemptArtifact(
  attemptId: string,
  label: string,
  finalHead: string,
): MissionArtifact | null {
  return Object.values(useMissions.getState().projection.artifacts).find((artifact) =>
    artifact.attemptId === attemptId &&
    artifact.label === label &&
    artifact.metadata.authority === "swarmz_native" &&
    artifact.metadata.finalHead === finalHead,
  ) ?? null;
}

async function recordIndependentReview(
  attempt: TaskAttempt,
  task: MissionTask,
  evidence: MissionGitEvidence,
): Promise<string> {
  const label = "Independent final-HEAD review";
  const existing = exactAttemptArtifact(attempt.id, label, evidence.head_sha);
  if (existing) {
    if (existing.metadata.evidenceKind !== "review" ||
      existing.metadata.baseSha !== evidence.base_sha ||
      existing.metadata.diffSha256 !== evidence.diff_sha256) {
      throw new Error("independent review artifact conflicts with the durable final HEAD");
    }
    return existing.id;
  }
  let reviewStatus: "passed" | "failed" = "passed";
  let reviewDetail = "Independent clean/scope/ancestry verification passed";
  let reviewThreadId: string | null = null;
  if (attempt.candidateBatchId && attempt.sessionId) {
    try {
      const result = await reviewSession(attempt.sessionId, `commit:${evidence.head_sha}`, {
        requireWorkspace: true,
      });
      reviewThreadId = result.review_thread_id;
      const text = result.review?.slice(0, 4_000) ?? "Detached review returned no findings";
      const hasFinding = /\[P[0-3]\]/i.test(text) || /"findings"\s*:\s*\[\s*\{/i.test(text);
      reviewStatus = result.status === "completed" && !hasFinding ? "passed" : "failed";
      reviewDetail = result.status !== "completed"
        ? `Detached review ended as ${result.status}`
        : hasFinding
          ? "Detached review found actionable P0-P3 findings"
          : "Detached review completed without actionable P0-P3 findings";
    } catch (error) {
      reviewStatus = "failed";
      reviewDetail = error instanceof Error ? error.message : String(error);
    }
  }
  const id = safeId(`${attempt.id}:review:${evidence.head_sha}`, "review");
  useMissions.getState().recordArtifact(attempt.missionId, {
    id,
    taskId: task.id,
    attemptId: attempt.id,
    kind: "other",
    label,
    uri: null,
    metadata: {
      authority: "swarmz_native",
      evidenceKind: "review",
      status: reviewStatus,
      finalHead: evidence.head_sha,
      baseSha: evidence.base_sha,
      diffSha256: evidence.diff_sha256,
      filesChanged: evidence.files_changed,
      allowNoop: task.allowNoop === true,
      clean: !evidence.dirty,
      baseIsAncestor: evidence.base_is_ancestor,
      reviewThreadId,
      detail: reviewDetail,
    },
  }, { actor: "system", idempotencyKey: `review-evidence:${attempt.id}:${evidence.head_sha}` });
  await flushMissionOrThrow();
  return id;
}

/** Run every required command through the native argv-only acceptance runner.
 * Worker transcript command items are intentionally ignored as authority. */
async function runIndependentGates(
  scope: ApprovedMissionScope,
  attempt: TaskAttempt,
  task: MissionTask,
  evidence: MissionGitEvidence,
  reviewArtifactId: string,
): Promise<IndependentGateEvidence> {
  const gates = task.qualityGateIds
    .map((gateId) => useMissions.getState().projection.qualityGates[gateId])
    .filter((gate) => gate?.required && gate.status !== "waived");
  const byCommand = new Map<string, typeof gates>();
  for (const gate of gates) {
    if (!gate.command?.trim()) continue;
    const command = gate.command.trim();
    byCommand.set(command, [...(byCommand.get(command) ?? []), gate]);
  }
  const commands: Record<string, number> = Object.create(null);
  const results: Array<{
    gateId: string;
    status: "passed" | "failed";
    details: string;
    artifactIds: string[];
  }> = [];
  const failed: string[] = [];

  for (const [command, commandGates] of byCommand) {
    const label = `Native acceptance · ${command.slice(0, 220)}`;
    let artifact = exactAttemptArtifact(attempt.id, label, evidence.head_sha);
    if (artifact && (artifact.metadata.evidenceKind !== "test" ||
      artifact.metadata.command !== command ||
      artifact.metadata.baseSha !== evidence.base_sha)) {
      throw new Error("native quality artifact conflicts with the approved command or final HEAD");
    }
    if (!artifact) {
      let status: "passed" | "failed" = "failed";
      let exitCode: number | null = null;
      let durationMs = 0;
      let detail = "native acceptance command failed before completion";
      try {
        const cwd = baseShaForAttempt(attempt.id)?.cwd ?? task.root.path;
        const before = await gitEvidence(cwd, evidence.base_sha);
        if (!finalHeadEvidenceMatches(evidence, before)) {
          throw new Error("final HEAD changed before native quality verification");
        }
        const argv = parseApprovedArgv(command);
        const result = await runAcceptanceCommand({
          runId: safeId(`${attempt.id}:${evidence.head_sha}:${command}`, "mission-gate"),
          approvalId: scope.approvalEventId,
          cwd,
          // The generated worktree itself is the native sandbox authority;
          // the quality process cannot touch the mutable main checkout.
          approvedRoots: [cwd],
          argv,
          timeoutMs: 15 * 60_000,
        });
        exitCode = result.exitCode;
        durationMs = result.durationMs;
        status = result.status === "completed" && result.exitCode === 0 ? "passed" : "failed";
        detail = result.status === "completed"
          ? `native argv exited ${result.exitCode ?? "without code"}`
          : `native argv ${result.status}`;
        const after = await gitEvidence(cwd, evidence.base_sha);
        if (!finalHeadEvidenceMatches(evidence, after)) {
          status = "failed";
          detail = "quality command changed the verified final HEAD or tracked diff";
        }
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
      }
      const id = safeId(`${attempt.id}:gate:${command}:${evidence.head_sha}`, "test");
      useMissions.getState().recordArtifact(attempt.missionId, {
        id,
        taskId: task.id,
        attemptId: attempt.id,
        kind: "test_result",
        label,
        uri: null,
        metadata: {
          authority: "swarmz_native",
          evidenceKind: "test",
          status,
          command,
          exitCode,
          durationMs,
          finalHead: evidence.head_sha,
          baseSha: evidence.base_sha,
          detail: detail.slice(0, 1_000),
        },
      }, { actor: "system", idempotencyKey: `gate-evidence:${attempt.id}:${evidence.head_sha}:${safeId(command, "cmd")}` });
      await flushMissionOrThrow();
      artifact = useMissions.getState().projection.artifacts[id] ?? null;
    }
    if (!artifact) throw new Error("native gate artifact was not persisted");
    const exitCode = typeof artifact.metadata.exitCode === "number" ? artifact.metadata.exitCode : 1;
    const passed = artifact.metadata.status === "passed" && exitCode === 0;
    commands[command] = exitCode;
    if (!passed) failed.push(command);
    for (const gate of commandGates) {
      results.push({
        gateId: gate.id,
        status: passed ? "passed" : "failed",
        details: `${passed ? "Passed" : "Failed"} natively at ${evidence.head_sha.slice(0, 12)} · ${String(artifact.metadata.detail ?? "direct argv")}`,
        artifactIds: [artifact.id],
      });
    }
  }
  for (const gate of gates.filter((candidate) => !candidate.command?.trim())) {
    results.push({
      gateId: gate.id,
      status: "passed",
      details: `Independent clean/scope/ancestry review at ${evidence.head_sha.slice(0, 12)}`,
      artifactIds: [reviewArtifactId],
    });
  }
  const changedResults = results.filter((result) => {
    const gate = useMissions.getState().projection.qualityGates[result.gateId];
    return gate?.status !== result.status ||
      gate.details !== result.details ||
      gate.artifactIds.join("\u001f") !== result.artifactIds.join("\u001f");
  });
  if (changedResults.length) {
    useMissions.getState().settleQualityGates(task.missionId, changedResults, {
      actor: "system",
      idempotencyKey: `gate-results:${attempt.id}:${evidence.head_sha}`,
    });
    await flushMissionOrThrow();
  }
  return { commands, failed };
}

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

async function settleCompletedAttempt(attempt: TaskAttempt): Promise<void> {
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

async function recoverOutboxAndAttempts(): Promise<void> {
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

function isOwnedMissionAttempt(attempt: TaskAttempt): boolean {
  if (!attempt.sessionId) return false;
  const spawn = spawnRecordForAttempt(attempt.id);
  return spawn?.command.kind === "spawn" &&
    attempt.sessionId === (spawn.command.payload.sessionId ?? safeId(attempt.id, "ms"));
}

async function pauseMissionsWithRuntimeDrift(): Promise<void> {
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

async function enforceRunningStops(): Promise<void> {
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

async function admitStarts(): Promise<void> {
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

async function controllerTick(): Promise<void> {
  if (tickRunning || !missionPersistenceReady()) return;
  tickRunning = true;
  try {
    await pauseMissionsWithRuntimeDrift();
    await enforceRunningStops();
    await recoverOutboxAndAttempts();
    for (const attempt of Object.values(useMissions.getState().projection.attempts)) {
      if (attempt.status === "running") await settleCompletedAttempt(attempt);
    }
    await admitStarts();
  } catch (error) {
    console.error("[missions] controller tick failed:", error);
  } finally {
    tickRunning = false;
  }
}

/** Start the single outside-React Mission scheduler/worker lifecycle. */
export function startMissionController(): () => void {
  if (stopActiveController) return stopActiveController;
  let stopped = false;
  const wake = () => {
    if (!stopped) void controllerTick();
  };
  const missionUnsub = useMissions.subscribe(wake);
  const outboxUnsub = useMissionOutbox.subscribe(wake);
  const vibeUnsub = useVibe.subscribe(wake);
  const runtimeUnsub = useRuntimeEnvironments.subscribe(wake);
  const timer = setInterval(wake, TICK_MS);
  wake();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    missionUnsub();
    outboxUnsub();
    vibeUnsub();
    runtimeUnsub();
    stopActiveController = null;
  };
  stopActiveController = stop;
  return stop;
}
