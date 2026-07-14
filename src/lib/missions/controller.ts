import { invoke } from "@tauri-apps/api/core";
import { schedule } from "@/lib/scheduler/core";
import type { ActiveLease, SchedulableTask } from "@/lib/scheduler/types";
import { addWorktree, listWorktrees, removeWorktree, resolveWorktreeMainRoot } from "@/lib/worktree";
import { autonomyTripped } from "@/lib/orchestrator/autonomy";
import { persistenceIssues } from "@/lib/persistence/coordinator";
import { useSwarm } from "@/store";
import {
  closeSession,
  interrupt,
  lastTurnOutcomeOf,
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
import { planMissionStarts, planReportSettlement } from "./runner-core";
import { envelopeStopAction, type StopAction } from "./envelope";
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
  taskHasSafeMissionPlacement,
  verifiedGateResults,
  workerOutcomeDisposition,
  exactPromptTurnId,
  missionTurnEvidence,
  missionHardStopReason,
  type ApprovedMissionScope,
} from "./controller-core";
import type { MissionTask, TaskAttempt } from "./types";

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
    !persistenceIssues().some((issue) =>
      issue.name === "missions" || issue.name === "missionOutbox" || issue.name === "vibeSessions",
    );
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

async function enqueueStart(scope: ApprovedMissionScope, task: MissionTask, command: ReturnType<typeof planMissionStarts>["commands"][number]): Promise<void> {
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
    `Approved base SHA: ${baseSha}\nFor report evidence use exactly this committed range: ${baseSha}..HEAD. Compute diff_sha256 from: git diff --no-ext-diff --no-textconv --binary ${baseSha}..HEAD | shasum -a 256. Compute files_changed from the same range.`,
    commands.length ? `Required verification commands (run exactly and report exit codes):\n${commands.map((item) => `- ${item}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");

  useMissions.getState().createAttempt(task.missionId, task.id, {
    id: command.attemptId,
    sessionId,
    workerLabel: command.worker.label,
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
  try {
    await ensureSpawnWorktree(claimed);
    const base = await gitEvidence(payload.cwd, null);
    if (payload.baseSha && base.head_sha.toLowerCase() !== payload.baseSha.toLowerCase()) {
      throw new Error("worktree start HEAD does not match the durable approved base SHA");
    }
    if (payload.branch && base.branch !== payload.branch) {
      throw new Error("worktree branch does not match the durable spawn command");
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
    const persistedTurnId = promptTurnId(sessionId, payload.prompt);
    if (persistedTurnId === undefined) {
      const ack = await sendMessageStrict(sessionId, payload.prompt, {
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
    await flushVibePersist();
    await useMissionOutbox.getState().deliver(claimed.id, claimed.lease.claimId, {
      sessionId,
      turnId,
      cwd: payload.cwd,
      branch: payload.branch ?? null,
      baseSha: payload.baseSha ?? base.head_sha,
    });
  } catch (error) {
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
    metadata: { tokens: tokenCount(attempt.sessionId), costUsd: null },
  }, { actor: "system", idempotencyKey: `usage:${attempt.id}` });
  await flushMissionOrThrow();
}

async function recordCommitEvidence(
  attempt: TaskAttempt,
  evidence: MissionGitEvidence,
): Promise<void> {
  const id = safeId(attempt.id, "commit");
  if (useMissions.getState().projection.artifacts[id]) return;
  useMissions.getState().recordArtifact(attempt.missionId, {
    id,
    taskId: attempt.taskId,
    attemptId: attempt.id,
    kind: "commit",
    label: "Verified attempt commit",
    uri: `git:${evidence.head_sha}`,
    metadata: {
      commit: evidence.head_sha,
      baseSha: evidence.base_sha,
      diffSha256: evidence.diff_sha256,
      filesChanged: evidence.files_changed,
    },
  }, { actor: "system", idempotencyKey: `commit-evidence:${attempt.id}` });
  await flushMissionOrThrow();
}

async function passRequiredGates(task: MissionTask, commands: Record<string, number>): Promise<void> {
  const store = useMissions.getState();
  const pending = task.qualityGateIds
    .map((gateId) => store.projection.qualityGates[gateId])
    .filter((gate) => gate?.required && gate.status !== "passed" && gate.status !== "waived");
  // Phase one is read-only. A later failed command must not leave the first
  // gate green and accidentally let a retry inherit another attempt's proof.
  const results = verifiedGateResults(pending, commands);
  // Phase two appends every result as one reducer batch and one durable flush.
  const latestAttemptId = task.attemptIds[task.attemptIds.length - 1] ?? "none";
  store.settleQualityGates(task.missionId, results, {
    actor: "system",
    idempotencyKey: `gate-results:${task.id}:${latestAttemptId}`,
  });
  await flushMissionOrThrow();
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
    const commands = turnEvidence.commands;
    const required = requiredCommands(scope, task);
    const observation: MissionReportObservation = {
      headSha: evidence.head_sha,
      baseSha: evidence.base_sha,
      diffSha256: evidence.diff_sha256,
      filesChanged: evidence.files_changed,
      commands,
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
    // Integration trains only consume commit evidence bound to this exact
    // successful attempt. Persist it before gates/settlement so a crash can
    // never expose success without its independently observed commit.
    await recordCommitEvidence(attempt, evidence);
    await passRequiredGates(task, commands);
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
    if (stop) for (const attempt of running) if (attempt.sessionId) interrupt(attempt.sessionId);
  }
}

async function admitStarts(): Promise<void> {
  const missionState = useMissions.getState();
  const scopes = approvedScopes();
  if (!scopes.length) return;
  const scopeByMission = new Map(scopes.map((scope) => [scope.missionId, scope]));
  const candidates: SchedulableTask[] = [];
  for (const task of Object.values(missionState.projection.tasks)) {
    const scope = scopeByMission.get(task.missionId);
    if (!scope || !taskIsInsideApprovedScope(scope, task) || !taskHasSafeMissionPlacement(task)) continue;
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
  const timer = setInterval(wake, TICK_MS);
  wake();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    missionUnsub();
    outboxUnsub();
    vibeUnsub();
    stopActiveController = null;
  };
  stopActiveController = stop;
  return stop;
}
