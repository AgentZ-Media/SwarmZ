import {
  deriveApprovedMissionScope,
  taskIsInsideApprovedScope,
} from "@/lib/missions/controller-core";
import type { MissionOutboxRecord } from "@/lib/missions/outbox";
import type {
  IntegrationTrain,
  IntegrationTrainEntry,
  MissionArtifact,
  MissionTask,
  QualityGate,
} from "@/lib/missions/types";
import {
  integrationIdentity,
} from "./controller-core";
import {
  planCombinedRegression,
  planIntegration,
} from "./core";
import type { IntegrationRollbackResult } from "./native";
import {
  productionIntegrationControllerPorts,
  type IntegrationControllerPorts,
  type MissionGitEvidence,
} from "./controller-ports";
import {
  checkpointFromArtifact,
  commitForTask,
  completedRegressionPlans,
  controllerStopPolicy,
  errorMessage,
  gateGreen,
  integrationReceiptEffective,
  integrationRecordsFor,
  outboxRecords,
  regressionGates,
  sameEntries,
  stableId,
  trainEntries,
} from "./controller-support";
import { runRegressionPlan } from "./controller-regression";
import type {
  IntegrationCheckpoint,
  IntegrationInput,
} from "./types";

const TICK_MS = 1_000;
const CLAIM_MS = 5 * 60_000;
const OWNER_ID = "integration-controller";
export interface HumanRollbackRequest {
  missionId: string;
  trainId: string;
  /** The human chooses the exact durable checkpoint; the controller never guesses. */
  checkpointId: string;
  approval: {
    approvalId: string;
    approvedBy: "human";
    approvedAt: number;
  };
}

export interface IntegrationTrainController {
  tick(): Promise<void>;
  start(): () => void;
  stop(): void;
  humanApprovedRollback(request: HumanRollbackRequest): Promise<IntegrationRollbackResult>;
}

interface TrainContext {
  missionId: string;
  approvalId: string;
  root: string;
  worktreePath: string;
  train: IntegrationTrain;
}

export function createIntegrationTrainController(
  ports: IntegrationControllerPorts,
): IntegrationTrainController {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function persistArtifact(
    missionId: string,
    artifact: Omit<MissionArtifact, "missionId" | "createdAt"> & { createdAt?: number },
  ): Promise<void> {
    if (ports.snapshot().projection.artifacts[artifact.id]) return;
    ports.recordArtifact(missionId, artifact, `integration-artifact:${artifact.id}`);
    await ports.flushMissions();
  }

  async function updateTrain(
    missionId: string,
    train: IntegrationTrain,
    patch: { status?: IntegrationTrain["status"]; entries?: IntegrationTrainEntry[] },
    reason: string,
  ): Promise<void> {
    const unchangedStatus = patch.status === undefined || patch.status === train.status;
    const unchangedEntries = patch.entries === undefined || sameEntries(patch.entries, train.entries);
    if (unchangedStatus && unchangedEntries) return;
    ports.updateTrain(
      missionId,
      train.id,
      patch,
      stableId("integration-update", train.id, reason, JSON.stringify(patch)),
    );
    await ports.flushMissions();
  }

  async function blockTrain(context: TrainContext, detail: string, taskId?: string): Promise<void> {
    const snapshot = ports.snapshot();
    const train = snapshot.projection.integrationTrains[context.train.id] ?? context.train;
    const normalized = errorMessage(detail);
    const entries = train.entries.map((entry) => entry.taskId === taskId
      ? { ...entry, status: "failed" as const, detail: normalized }
      : entry);
    await updateTrain(context.missionId, train, {
      status: "blocked",
      ...(taskId ? { entries } : {}),
    }, `blocked:${taskId ?? "train"}:${normalized}`);
    await persistArtifact(context.missionId, {
      id: stableId("intblocked", train.id, taskId ?? "train", normalized),
      taskId: taskId ?? null,
      attemptId: null,
      kind: "log",
      label: "integration-blocked",
      uri: null,
      metadata: { trainId: train.id, root: context.root, detail: normalized },
    });
  }

  async function ensureWorktree(
    root: string,
    branch: string,
    gitBin?: string,
  ): Promise<string> {
    const scan = await ports.scanWorktrees([root], gitBin);
    const matches = scan.entries.filter((entry) => entry.branch === branch);
    if (matches.length > 1) throw new Error(`multiple worktrees claim integration branch ${branch}`);
    const existing = matches[0];
    if (existing) {
      if (existing.missing) throw new Error(`integration worktree for ${branch} is registered but missing`);
      if (existing.root !== root) throw new Error("integration worktree escaped its canonical root");
      return existing.path;
    }
    const created = await ports.createWorktree({ cwd: root, branch, copyEnv: false, gitBin });
    if (created.root !== root || created.branch !== branch) {
      throw new Error("created integration worktree does not match its deterministic identity");
    }
    return created.path;
  }

  async function ensureTrain(
    missionId: string,
    approvalId: string,
    root: string,
    tasks: readonly MissionTask[],
    gitBin?: string,
  ): Promise<TrainContext> {
    const identity = integrationIdentity(missionId, root);
    let train = ports.snapshot().projection.integrationTrains[identity.trainId];
    if (!train) {
      const base = await ports.gitEvidence(root, null, gitBin);
      ports.createTrain(missionId, {
        id: identity.trainId,
        baseBranch: base.branch ?? "HEAD",
        integrationBranch: identity.branch,
        status: "open",
        entries: trainEntries(tasks),
      }, `integration-train:${identity.trainId}`);
      await ports.flushMissions();
      train = ports.snapshot().projection.integrationTrains[identity.trainId];
      if (!train) throw new Error("integration train was not durably projected");
    }
    if (train.missionId !== missionId || train.integrationBranch !== identity.branch) {
      throw new Error("deterministic integration train identity collides with another train");
    }
    const expectedTaskIds = new Set(tasks.map((task) => task.id));
    if (train.entries.length !== expectedTaskIds.size ||
      train.entries.some((entry) => !expectedTaskIds.has(entry.taskId))) {
      throw new Error("approved task-root membership changed after integration train creation");
    }
    const worktreePath = await ensureWorktree(root, train.integrationBranch, gitBin);
    const evidence = await ports.gitEvidence(worktreePath, null, gitBin);
    if (evidence.branch !== train.integrationBranch) {
      throw new Error("integration worktree is not on its recorded branch");
    }
    await persistArtifact(missionId, {
      id: stableId("intworktree", train.id),
      taskId: null,
      attemptId: null,
      kind: "other",
      label: "integration-worktree",
      uri: worktreePath,
      metadata: { trainId: train.id, root, branch: train.integrationBranch },
    });
    train = ports.snapshot().projection.integrationTrains[train.id] ?? train;
    if (train.status === "open") {
      await updateTrain(missionId, train, { status: "running" }, "worktree-ready");
      train = ports.snapshot().projection.integrationTrains[train.id] ?? train;
    }
    return { missionId, approvalId, root, worktreePath, train };
  }

  async function recordCheckpoint(
    context: TrainContext,
    checkpoint: NonNullable<ReturnType<typeof planIntegration>["checkpoint"]>,
  ): Promise<void> {
    const snapshot = ports.snapshot();
    const completedOperationIds = outboxRecords(snapshot, context.missionId, "integrate")
      .filter((record) => record.status === "delivered" && record.command.kind === "integrate" &&
        record.command.payload.trainId === context.train.id)
      .map((record) => record.command.kind === "integrate" ? record.command.payload.operationId : "")
      .filter(Boolean);
    const passedGateIds = outboxRecords(snapshot, context.missionId, "gate")
      .filter((record) => record.command.kind === "gate" && gateGreen(record))
      .map((record) => record.command.kind === "gate" ? record.command.payload.gateId : "")
      .filter(Boolean);
    await persistArtifact(context.missionId, {
      id: checkpoint.checkpointId,
      taskId: null,
      attemptId: null,
      kind: "commit",
      label: "integration-checkpoint",
      uri: `git:${checkpoint.headCommit}`,
      metadata: {
        trainId: context.train.id,
        root: context.root,
        worktreePath: context.worktreePath,
        branch: context.train.integrationBranch,
        headCommit: checkpoint.headCommit,
        integratedTaskIds: [...checkpoint.integratedTaskIds],
        completedOperationIds,
        passedGateIds,
        reason: checkpoint.reason,
      },
    });
  }

  async function deliverReconciledIntegration(
    record: MissionOutboxRecord,
    evidence: MissionGitEvidence,
    detail: string,
  ): Promise<boolean> {
    if (record.status === "delivered") return true;
    const claimed = await ports.claim(record.id, OWNER_ID, CLAIM_MS);
    if (!claimed?.lease || claimed.command.kind !== "integrate") return false;
    await ports.deliver(claimed.id, claimed.lease.claimId, {
      status: "reconciled",
      operationId: claimed.command.payload.operationId,
      commit: claimed.command.payload.commit,
      headBefore: claimed.command.payload.expectedHead,
      headAfter: evidence.head_sha,
      branch: evidence.branch,
      headVerified: true,
      detail,
    });
    return true;
  }

  async function markEntryIntegrated(
    context: TrainContext,
    taskId: string,
    commit: string,
    detail: string,
  ): Promise<void> {
    const train = ports.snapshot().projection.integrationTrains[context.train.id] ?? context.train;
    const entries = train.entries.map((entry) => entry.taskId === taskId
      ? { ...entry, status: "integrated" as const, commit, detail }
      : entry);
    await updateTrain(context.missionId, train, { status: "running", entries },
      `integrated:${taskId}:${commit}:${detail}`);
  }

  async function reconcileEntries(context: TrainContext): Promise<void> {
    let snapshot = ports.snapshot();
    let train = snapshot.projection.integrationTrains[context.train.id] ?? context.train;
    for (const entry of train.entries) {
      const task = snapshot.projection.tasks[entry.taskId];
      if (!task) continue;
      const commit = entry.commit ?? commitForTask(task, snapshot.projection);
      if (!commit) continue;
      const records = integrationRecordsFor(snapshot, train.id, task.id, commit);
      const delivered = [...records].reverse().find((record) => record.status === "delivered");
      if (entry.status === "integrated") {
        // A crash may leave the first exact-HEAD command unacknowledged while
        // a later patch-equivalence probe proves the same cherry-pick. Adopt
        // every older record so the durable outbox does not rot indefinitely.
        if (delivered) {
          const current = await ports.gitEvidence(context.worktreePath, null, snapshot.gitBin);
          for (const stale of records.filter((record) => record.status !== "delivered")) {
            await deliverReconciledIntegration(
              stale,
              current,
              `superseded by delivered operation ${delivered.command.kind === "integrate" ? delivered.command.payload.operationId : "unknown"}`,
            );
          }
        }
        continue;
      }
      if (["failed", "skipped"].includes(entry.status)) continue;
      if (delivered) {
        if (delivered.delivery?.receipt.status === "blocked") {
          await blockTrain(context, String(delivered.delivery.receipt.detail ?? "git conflict"), task.id);
          return;
        }
        if (!integrationReceiptEffective(delivered)) {
          await blockTrain(context, "Durable integration receipt failed commit/HEAD verification", task.id);
          return;
        }
        await markEntryIntegrated(context, task.id, commit, "reconciled from durable integration receipt");
        snapshot = ports.snapshot();
        train = snapshot.projection.integrationTrains[train.id] ?? train;
        continue;
      }
      const evidence = await ports.gitEvidence(context.worktreePath, commit, snapshot.gitBin);
      if (!evidence.base_is_ancestor) continue;
      let record = records[records.length - 1];
      if (!record) {
        const operationId = stableId("intreconcile", train.id, task.id, commit, evidence.head_sha);
        record = await ports.enqueue({
          kind: "integrate",
          missionId: context.missionId,
          idempotencyKey: operationId,
          payload: {
            trainId: train.id,
            taskId: task.id,
            operationId,
            strategy: "cherry_pick",
            commit,
            expectedHead: evidence.head_sha,
          },
        }, stableId("outbox", operationId));
      }
      if (await deliverReconciledIntegration(record, evidence, "source commit is already an ancestor of integration HEAD")) {
        await markEntryIntegrated(context, task.id, commit, "reconciled from Git ancestor evidence");
        snapshot = ports.snapshot();
        train = snapshot.projection.integrationTrains[train.id] ?? train;
      }
    }
  }

  function integrationInput(
    context: TrainContext,
    evidence: MissionGitEvidence,
    qualityGates?: Readonly<Record<string, QualityGate>>,
  ): IntegrationInput {
    const snapshot = ports.snapshot();
    const records = outboxRecords(snapshot, context.missionId);
    const checkpoints = Object.values(snapshot.projection.artifacts)
      .map(checkpointFromArtifact)
      .filter((checkpoint): checkpoint is IntegrationCheckpoint => checkpoint?.trainId === context.train.id);
    const completedOperationIds = new Set(records
      .filter((record) => record.status === "delivered" && record.command.kind === "integrate" &&
        record.command.payload.trainId === context.train.id)
      .map((record) => record.command.kind === "integrate" ? record.command.payload.operationId : "")
      .filter(Boolean));
    return {
      train: snapshot.projection.integrationTrains[context.train.id] ?? context.train,
      tasks: snapshot.projection.tasks,
      attempts: snapshot.projection.attempts,
      artifacts: snapshot.projection.artifacts,
      qualityGates: qualityGates ?? snapshot.projection.qualityGates,
      strategy: "cherry_pick",
      currentHead: evidence.head_sha,
      completedOperationIds,
      activeOperationIds: new Set(records
        .filter((record) => record.status === "claimed" && record.command.kind === "integrate")
        .map((record) => record.command.kind === "integrate" ? record.command.payload.operationId : "")
        .filter(Boolean)),
      integratedCommits: new Set((snapshot.projection.integrationTrains[context.train.id]?.entries ?? [])
        .filter((entry) => entry.status === "integrated" && entry.commit)
        .map((entry) => entry.commit as string)),
      checkpoints,
      stopPolicy: controllerStopPolicy(),
      now: ports.now(),
    };
  }

  async function executeIntegration(
    context: TrainContext,
    operation: NonNullable<ReturnType<typeof planIntegration>["operation"]>,
  ): Promise<void> {
    const record = await ports.enqueue({
      kind: "integrate",
      missionId: context.missionId,
      idempotencyKey: operation.operationId,
      payload: {
        trainId: context.train.id,
        taskId: operation.taskId,
        operationId: operation.operationId,
        strategy: operation.operation.kind,
        commit: operation.commit,
        expectedHead: operation.operation.expectedHead,
      },
    }, stableId("outbox", operation.operationId));
    const train = ports.snapshot().projection.integrationTrains[context.train.id] ?? context.train;
    const entries = train.entries.map((entry) => entry.taskId === operation.taskId
      ? { ...entry, status: "integrating" as const, commit: operation.commit, detail: operation.explanation }
      : entry);
    await updateTrain(context.missionId, train, { status: "running", entries },
      `integrating:${operation.operationId}`);
    if (record.status === "delivered") {
      if (!integrationReceiptEffective(record)) {
        await blockTrain(context, "Durable integration receipt failed commit/HEAD verification", operation.taskId);
        return;
      }
      await markEntryIntegrated(context, operation.taskId, operation.commit, "reconciled from durable integration receipt");
      return;
    }
    if (record.status === "dead_letter") {
      await blockTrain(context, record.lastError ?? "Integration operation exhausted all retries", operation.taskId);
      return;
    }
    const claimed = await ports.claim(record.id, OWNER_ID, CLAIM_MS);
    if (!claimed?.lease || claimed.command.kind !== "integrate") return;
    try {
      const fresh = await ports.gitEvidence(context.worktreePath, null, ports.snapshot().gitBin);
      if (fresh.branch !== context.train.integrationBranch || fresh.dirty) {
        throw new Error("integration checkout changed branch or became dirty before apply");
      }
      if (fresh.head_sha !== claimed.command.payload.expectedHead.toLowerCase()) {
        const ancestry = await ports.gitEvidence(
          context.worktreePath,
          claimed.command.payload.commit,
          ports.snapshot().gitBin,
        );
        if (ancestry.base_is_ancestor) {
          await ports.deliver(claimed.id, claimed.lease.claimId, {
            status: "reconciled",
            operationId: claimed.command.payload.operationId,
            commit: claimed.command.payload.commit,
            headBefore: claimed.command.payload.expectedHead,
            headAfter: ancestry.head_sha,
            branch: ancestry.branch,
            headVerified: true,
            detail: "commit became an ancestor before durable acknowledgement",
          });
          await markEntryIntegrated(context, operation.taskId, operation.commit, "reconciled after interrupted acknowledgement");
          return;
        }
        throw new Error("integration HEAD changed before the durable operation could run");
      }
      const result = await ports.apply({
        root: context.root,
        worktreePath: context.worktreePath,
        integrationBranch: context.train.integrationBranch,
        expectedHead: claimed.command.payload.expectedHead,
        commit: claimed.command.payload.commit,
        strategy: claimed.command.payload.strategy === "merge" ? "merge" : "cherry_pick",
        gitBin: ports.snapshot().gitBin,
      });
      const detail = result.status === "blocked"
        ? `Git conflict in ${result.conflictFiles.join(", ") || "unknown files"}; checkout restored: ${result.checkoutRestored}`
        : `${result.status}: ${result.headBefore} -> ${result.headAfter}`;
      await ports.deliver(claimed.id, claimed.lease.claimId, {
        ...result,
        operationId: claimed.command.payload.operationId,
        headVerified: true,
        detail,
      });
      if (result.status === "blocked") {
        await blockTrain(context, detail, operation.taskId);
        return;
      }
      await markEntryIntegrated(context, operation.taskId, operation.commit, detail);
    } catch (error) {
      await ports.fail(claimed.id, claimed.lease.claimId, errorMessage(error), true);
    }
  }

  async function processTrain(context: TrainContext): Promise<void> {
    if (["blocked", "cancelled", "completed"].includes(context.train.status)) return;
    await reconcileEntries(context);
    const snapshot = ports.snapshot();
    const train = snapshot.projection.integrationTrains[context.train.id] ?? context.train;
    if (["blocked", "cancelled", "completed"].includes(train.status)) return;
    context = { ...context, train };
    const evidence = await ports.gitEvidence(context.worktreePath, null, snapshot.gitBin);
    if (evidence.branch !== train.integrationBranch || evidence.dirty) {
      await blockTrain(context, "Integration worktree changed branch or contains uncommitted changes");
      return;
    }
    let input = integrationInput(context, evidence);
    const allSettled = train.entries.every((entry) => ["integrated", "skipped"].includes(entry.status));
    if (allSettled) {
      input = integrationInput(context, evidence, regressionGates(snapshot.projection, context.missionId, train));
      const regression = planCombinedRegression(input);
      input = {
        ...input,
        completedRegressionPlanIds: completedRegressionPlans(snapshot, context.missionId, regression),
      };
    }
    const plan = planIntegration(input);
    switch (plan.action) {
      case "checkpoint":
        if (plan.checkpoint) await recordCheckpoint(context, plan.checkpoint);
        return;
      case "execute":
        if (plan.operation) await executeIntegration(context, plan.operation);
        return;
      case "reconcile":
        if (plan.operation) {
          await markEntryIntegrated(context, plan.operation.taskId, plan.operation.commit,
            "reconciled from completed operation evidence");
        }
        return;
      case "run_regression":
        if (plan.regression) {
          await runRegressionPlan(ports, { persistArtifact, blockTrain }, context, plan.regression, evidence.head_sha);
        }
        return;
      case "complete": {
        const current = ports.snapshot().projection.integrationTrains[train.id] ?? train;
        await updateTrain(context.missionId, current, { status: "completed" }, "regression-green");
        return;
      }
      case "rollback":
        await blockTrain(context, `${plan.explanation}. Automatic rollback is forbidden; human approval is required.`);
        return;
      case "blocked":
      case "needs_human":
        await blockTrain(context, plan.explanation);
        return;
      case "wait":
        return;
    }
  }

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const initial = ports.snapshot();
      if (!initial.ready) return;
      const missions = Object.values(initial.projection.missions)
        .filter((mission) => mission.status === "active" && mission.policy.integrationMode === "train")
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      for (const mission of missions) {
        const snapshot = ports.snapshot();
        const scope = deriveApprovedMissionScope(snapshot.events, mission.id);
        if (!scope) continue;
        const tasks = mission.taskIds
          .map((taskId) => snapshot.projection.tasks[taskId])
          .filter((task): task is MissionTask => Boolean(task) && task.archivedAt === null);
        if (tasks.length === 0 || tasks.some((task) => !taskIsInsideApprovedScope(scope, task))) continue;
        const roots = await Promise.all([...new Set(tasks.map((task) => task.root.path))]
          .map(async (path) => [path, await ports.resolveMainRoot(path, snapshot.gitBin)] as const));
        const canonicalByRequested = new Map(roots);
        const grouped = new Map<string, MissionTask[]>();
        for (const task of tasks) {
          const root = canonicalByRequested.get(task.root.path);
          if (!root) throw new Error(`could not canonicalize task root ${task.root.path}`);
          const group = grouped.get(root) ?? [];
          group.push({ ...task, root: { ...task.root, path: root } });
          grouped.set(root, group);
        }
        for (const [root, rootTasks] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
          try {
            const context = await ensureTrain(
              mission.id,
              scope.approvalEventId,
              root,
              rootTasks,
              ports.snapshot().gitBin,
            );
            await processTrain(context);
          } catch (error) {
            const identity = integrationIdentity(mission.id, root);
            const train = ports.snapshot().projection.integrationTrains[identity.trainId];
            if (train && !["blocked", "cancelled", "completed"].includes(train.status)) {
              await blockTrain({
                missionId: mission.id,
                approvalId: scope.approvalEventId,
                root,
                worktreePath: identity.worktreePath,
                train,
              }, errorMessage(error));
            }
          }
        }
      }
    } finally {
      running = false;
    }
  }

  async function humanApprovedRollback(request: HumanRollbackRequest): Promise<IntegrationRollbackResult> {
    if (request.approval.approvedBy !== "human" || !request.approval.approvalId.trim() ||
      !Number.isFinite(request.approval.approvedAt)) {
      throw new Error("rollback requires an explicit, durable human approval");
    }
    const snapshot = ports.snapshot();
    if (!snapshot.ready) throw new Error("integration persistence is not safely hydrated");
    const train = snapshot.projection.integrationTrains[request.trainId];
    if (!train || train.missionId !== request.missionId) throw new Error("integration train is unknown");
    const task = train.entries
      .map((entry) => snapshot.projection.tasks[entry.taskId])
      .find((value): value is MissionTask => Boolean(value));
    if (!task) throw new Error("integration train has no task root");
    const root = await ports.resolveMainRoot(task.root.path, snapshot.gitBin);
    const worktreePath = await ensureWorktree(root, train.integrationBranch, snapshot.gitBin);
    const checkpoints = Object.values(snapshot.projection.artifacts)
      .map(checkpointFromArtifact)
      .filter((checkpoint): checkpoint is IntegrationCheckpoint => checkpoint?.trainId === train.id)
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
    const checkpoint = checkpoints.find((value) => value.id === request.checkpointId);
    if (!checkpoint) throw new Error("rollback refused: train has no durable checkpoint");
    const evidence = await ports.gitEvidence(worktreePath, null, snapshot.gitBin);
    await persistArtifact(request.missionId, {
      id: stableId("rollbackapproval", train.id, checkpoint.id, request.approval.approvalId),
      taskId: null,
      attemptId: null,
      kind: "log",
      label: "integration-rollback-approved",
      uri: null,
      createdAt: request.approval.approvedAt,
      metadata: {
        trainId: train.id,
        checkpointId: checkpoint.id,
        checkpointSha: checkpoint.headCommit,
        expectedHead: evidence.head_sha,
        approvalId: request.approval.approvalId,
        approvedBy: "human",
      },
    });
    const result = await ports.rollback({
      root,
      worktreePath,
      integrationBranch: train.integrationBranch,
      expectedHead: evidence.head_sha,
      checkpointSha: checkpoint.headCommit,
      approvalId: request.approval.approvalId,
      gitBin: snapshot.gitBin,
    });
    await persistArtifact(request.missionId, {
      id: stableId("rollbackdone", train.id, checkpoint.id, result.headBefore, result.headAfter),
      taskId: null,
      attemptId: null,
      kind: "commit",
      label: "integration-rollback-completed",
      uri: `git:${result.headAfter}`,
      metadata: { trainId: train.id, checkpointId: checkpoint.id, ...result },
    });
    const current = ports.snapshot().projection.integrationTrains[train.id] ?? train;
    await updateTrain(request.missionId, current, { status: "blocked" },
      `human-rollback:${request.approval.approvalId}:${result.headAfter}`);
    return result;
  }

  const controllerApi: IntegrationTrainController = {
    tick,
    start: () => {
      if (timer) return () => { controllerApi.stop(); };
      void tick();
      timer = setInterval(() => { void tick(); }, TICK_MS);
      return () => { controllerApi.stop(); };
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    humanApprovedRollback,
  };
  return controllerApi;
}

let activeController: IntegrationTrainController | null = null;

/** Start the singleton controller outside React. App wiring intentionally lives at the composition root. */
export function startIntegrationController(): () => void {
  activeController?.stop();
  activeController = createIntegrationTrainController(productionIntegrationControllerPorts());
  return activeController.start();
}

export function stopIntegrationController(): void {
  activeController?.stop();
  activeController = null;
}

/** Destructive rollback is never called by the autonomous tick loop. */
export function rollbackIntegrationTrain(
  request: HumanRollbackRequest,
): Promise<IntegrationRollbackResult> {
  if (!activeController) {
    activeController = createIntegrationTrainController(productionIntegrationControllerPorts());
  }
  return activeController.humanApprovedRollback(request);
}
