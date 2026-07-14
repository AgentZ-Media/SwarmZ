import { describe, expect, it } from "vitest";
import { replayMissionEvents } from "@/lib/missions/core";
import type {
  EnqueueMissionCommand,
  MissionOutboxRecord,
} from "@/lib/missions/outbox";
import type {
  MissionEvent,
  MissionEventPayload,
  MissionProjection,
} from "@/lib/missions/types";
import {
  createIntegrationTrainController,
  type HumanRollbackRequest,
} from "./controller";
import type {
  IntegrationControllerPorts,
  MissionGitEvidence,
} from "./controller-ports";
import type {
  AcceptanceCommandRequest,
  IntegrationApplyRequest,
  IntegrationApplyResult,
  IntegrationRollbackRequest,
} from "./native";

const MISSION_ID = "mission-1";
const BASE_A = "a".repeat(40);
const BASE_B = "b".repeat(40);

type ApplyMode = "success" | "conflict" | "crash_once";

interface Harness {
  controller: ReturnType<typeof createIntegrationTrainController>;
  projection: MissionProjection;
  outbox: Record<string, MissionOutboxRecord>;
  applyCalls: IntegrationApplyRequest[];
  acceptanceCalls: AcceptanceCommandRequest[];
  rollbackCalls: IntegrationRollbackRequest[];
  headByPath: Map<string, string>;
}

function addEvent(
  events: MissionEvent[],
  payload: MissionEventPayload,
  actor: MissionEvent["actor"] = "system",
): void {
  events.push({
    ...payload,
    eventId: `event-${events.length + 1}`,
    missionId: MISSION_ID,
    revision: events.length + 1,
    occurredAt: 1_000 + events.length,
    actor,
  } as MissionEvent);
}

function missionEvents(roots: readonly string[], command: string): MissionEvent[] {
  const events: MissionEvent[] = [];
  addEvent(events, {
    type: "mission.created",
    data: {
      projectId: "project-1",
      title: "Integration mission",
      objective: "Integrate every successful task",
      policy: {
        maxParallelAttempts: 4,
        stopOnCriticalFailure: true,
        requireQualityGates: true,
        integrationMode: "train",
        archiveCompletedWorkers: true,
        networkAuthority: "deny",
        githubAuthority: "deny",
        allowedTools: ["read_file", "edit_file", "test"],
        qualityCommands: [command],
        stopOnRegression: "needs_human",
        stopOnConflict: "needs_human",
      },
      budget: {
        maxAttemptsTotal: null,
        maxActiveMinutes: null,
        maxTokens: null,
        maxCostUsd: null,
      },
      createdAt: 1_000,
    },
  }, "human");
  roots.forEach((root, index) => {
    const number = index + 1;
    addEvent(events, {
      type: "task.added",
      data: {
        id: `task-${number}`,
        missionId: MISSION_ID,
        title: `Task ${number}`,
        description: "Committed implementation",
        priority: 50,
        role: "implementation",
        risk: "medium",
        acceptanceCriteria: ["tests pass"],
        root: { projectId: `project-${number}`, path: root },
        worktreePolicy: { mode: "new" },
        dependencyIds: [],
        declaredFiles: [`src/task-${number}.ts`],
        declaredGlobs: [],
        maxAttempts: 2,
        createdAt: 1_010 + index,
      },
    }, "human");
    addEvent(events, {
      type: "quality_gate.added",
      data: {
        id: `gate-${number}`,
        missionId: MISSION_ID,
        taskId: `task-${number}`,
        kind: "unit_tests",
        label: `Task ${number} tests`,
        command,
        required: true,
        createdAt: 1_020 + index,
      },
    }, "human");
  });
  addEvent(events, { type: "mission.activated", data: { activatedAt: 1_100 } }, "human");
  roots.forEach((_root, index) => {
    const number = index + 1;
    const commit = number.toString(16).repeat(40);
    addEvent(events, {
      type: "attempt.started",
      data: {
        id: `attempt-${number}`,
        taskId: `task-${number}`,
        sessionId: `session-${number}`,
        workerLabel: `Worker ${number}`,
        startedAt: 1_200 + index,
      },
    }, "scheduler");
    addEvent(events, {
      type: "artifact.recorded",
      data: {
        id: `commit-${number}`,
        missionId: MISSION_ID,
        taskId: `task-${number}`,
        attemptId: `attempt-${number}`,
        kind: "commit",
        label: "worker-commit",
        uri: `git:${commit}`,
        metadata: { commit },
        createdAt: 1_300 + index,
      },
    });
    addEvent(events, {
      type: "quality_gate.resulted",
      data: {
        gateId: `gate-${number}`,
        status: "passed",
        details: "worker gate passed",
        updatedAt: 1_400 + index,
      },
    });
    addEvent(events, {
      type: "attempt.finished",
      data: {
        attemptId: `attempt-${number}`,
        status: "succeeded",
        finishedAt: 1_500 + index,
        summary: "done",
      },
    }, "scheduler");
  });
  return events;
}

function makeHarness(options: {
  roots?: string[];
  command?: string;
  applyMode?: ApplyMode;
  acceptanceExitCode?: number;
} = {}): Harness {
  const requestedRoots = options.roots ?? ["/repo-a/subdir"];
  const command = options.command ?? "pnpm test";
  const events = missionEvents(requestedRoots, command);
  const projection = replayMissionEvents(events);
  projection.missions[MISSION_ID] = {
    ...projection.missions[MISSION_ID],
    status: "active",
    pausedAt: null,
    cancelledAt: null,
    archivedAt: null,
  };
  const outbox: Record<string, MissionOutboxRecord> = Object.create(null);
  const worktrees = new Map<string, { root: string; path: string; branch: string }>();
  const headByPath = new Map<string, string>([["/repo-a", BASE_A], ["/repo-b", BASE_B]]);
  const branchByPath = new Map<string, string>([["/repo-a", "main"], ["/repo-b", "main"]]);
  const ancestors = new Map<string, Set<string>>();
  const applied = new Set<string>();
  const applyCalls: IntegrationApplyRequest[] = [];
  const acceptanceCalls: AcceptanceCommandRequest[] = [];
  const rollbackCalls: IntegrationRollbackRequest[] = [];
  let clock = 10_000;
  let crashed = false;

  const canonical = (cwd: string) => cwd.startsWith("/repo-b") ? "/repo-b" : "/repo-a";
  const ports: IntegrationControllerPorts = {
    snapshot: () => ({ ready: true, projection, events, outbox }),
    resolveMainRoot: async (cwd) => canonical(cwd),
    scanWorktrees: async (roots) => ({
      scanned: roots,
      entries: [...worktrees.values()]
        .filter((entry) => roots.includes(entry.root))
        .map((entry) => ({
          ...entry,
          repo: entry.root.split("/").filter(Boolean).pop() ?? "repo",
          dirty: false,
          ahead: 0,
          ahead_unknown: false,
          missing: false,
        })),
    }),
    createWorktree: async ({ cwd, branch }) => {
      const path = `${cwd}/.worktrees/${branch.split("/").pop()}`;
      const entry = { root: cwd, path, branch };
      worktrees.set(branch, entry);
      headByPath.set(path, headByPath.get(cwd) as string);
      branchByPath.set(path, branch);
      ancestors.set(path, new Set([headByPath.get(cwd) as string]));
      return { ...entry, copied: 0 };
    },
    gitEvidence: async (cwd, baseSha): Promise<MissionGitEvidence> => {
      const path = headByPath.has(cwd) ? cwd : canonical(cwd);
      const head = headByPath.get(path) as string;
      return {
        base_sha: baseSha ?? head,
        head_sha: head,
        diff_sha256: "d".repeat(64),
        files_changed: [],
        dirty: false,
        branch: branchByPath.get(path) ?? "main",
        base_is_ancestor: baseSha === null || baseSha === head || (ancestors.get(path)?.has(baseSha) ?? false),
      };
    },
    apply: async (request): Promise<IntegrationApplyResult> => {
      applyCalls.push(request);
      const durable = Object.values(outbox).some((record) =>
        record.status === "claimed" && record.command.kind === "integrate" &&
        record.command.payload.commit === request.commit &&
        record.command.payload.expectedHead === request.expectedHead,
      );
      if (!durable) throw new Error("test invariant: Git ran before claimed durable outbox record");
      const head = headByPath.get(request.worktreePath) as string;
      if (options.applyMode === "conflict") {
        return {
          status: "blocked",
          strategy: request.strategy,
          commit: request.commit,
          headBefore: head,
          headAfter: head,
          conflictFiles: ["src/conflict.ts"],
          checkoutRestored: true,
        };
      }
      const key = `${request.worktreePath}:${request.commit}`;
      if (applied.has(key)) {
        return {
          status: "already_applied",
          strategy: request.strategy,
          commit: request.commit,
          headBefore: head,
          headAfter: head,
          conflictFiles: [],
          checkoutRestored: true,
        };
      }
      const next = (applyCalls.length + 10).toString(16).padStart(40, "c");
      ancestors.get(request.worktreePath)?.add(head);
      headByPath.set(request.worktreePath, next);
      applied.add(key);
      if (options.applyMode === "crash_once" && !crashed) {
        crashed = true;
        throw new Error("simulated acknowledgement crash after cherry-pick");
      }
      return {
        status: "applied",
        strategy: request.strategy,
        commit: request.commit,
        headBefore: head,
        headAfter: next,
        conflictFiles: [],
        checkoutRestored: true,
      };
    },
    rollback: async (request) => {
      rollbackCalls.push(request);
      expect(Object.values(projection.artifacts).some((artifact) =>
        artifact.label === "integration-rollback-approved" &&
        artifact.metadata.approvalId === request.approvalId,
      )).toBe(true);
      const before = headByPath.get(request.worktreePath) as string;
      headByPath.set(request.worktreePath, request.checkpointSha);
      return {
        headBefore: before,
        headAfter: request.checkpointSha,
        checkpointSha: request.checkpointSha,
        approvalId: request.approvalId,
        reflogHead: request.checkpointSha,
        reflogSubject: `SwarmZ integration rollback ${request.approvalId}`,
      };
    },
    runAcceptance: async (request) => {
      acceptanceCalls.push(request);
      expect(Object.values(outbox).some((record) =>
        record.status === "claimed" && record.command.kind === "gate" &&
        record.delivery === null,
      )).toBe(true);
      return {
        runId: request.runId,
        status: "completed",
        exitCode: options.acceptanceExitCode ?? 0,
        durationMs: 5,
        stdout: "ok",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    },
    enqueue: async (command: EnqueueMissionCommand, recordId) => {
      const existing = Object.values(outbox).find((record) =>
        record.missionId === command.missionId && record.idempotencyKey === command.idempotencyKey,
      );
      if (existing) return existing;
      const { missionId, idempotencyKey, maxAttempts: _maxAttempts, ...body } = command;
      const record: MissionOutboxRecord = {
        id: recordId,
        missionId,
        idempotencyKey,
        command: body,
        status: "pending",
        createdAt: clock++,
        updatedAt: clock,
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: 0,
        lease: null,
        delivery: null,
        lastError: null,
      };
      outbox[recordId] = record;
      return record;
    },
    claim: async (recordId, ownerId, leaseMs) => {
      const record = outbox[recordId];
      if (!record || record.status === "delivered" || record.status === "dead_letter") return null;
      const claimed: MissionOutboxRecord = {
        ...record,
        status: "claimed",
        attempts: record.attempts + 1,
        lease: {
          ownerId,
          claimId: `claim-${record.id}-${record.attempts + 1}`,
          claimedAt: clock,
          expiresAt: clock + leaseMs,
        },
      };
      outbox[recordId] = claimed;
      return claimed;
    },
    deliver: async (recordId, claimId, receipt) => {
      const record = outbox[recordId];
      expect(record.lease?.claimId).toBe(claimId);
      const delivered: MissionOutboxRecord = {
        ...record,
        status: "delivered",
        lease: null,
        delivery: { deliveredAt: clock++, receipt },
      };
      outbox[recordId] = delivered;
      return delivered;
    },
    fail: async (recordId, claimId, error) => {
      const record = outbox[recordId];
      expect(record.lease?.claimId).toBe(claimId);
      const failed: MissionOutboxRecord = {
        ...record,
        status: "failed",
        lease: null,
        lastError: error,
        nextAttemptAt: 0,
      };
      outbox[recordId] = failed;
      return failed;
    },
    createTrain: (missionId, train) => {
      const now = clock++;
      projection.integrationTrains[train.id] = {
        ...train,
        missionId,
        createdAt: now,
        updatedAt: now,
      };
      projection.missions[missionId].integrationTrainIds.push(train.id);
    },
    updateTrain: (_missionId, trainId, patch) => {
      projection.integrationTrains[trainId] = {
        ...projection.integrationTrains[trainId],
        ...patch,
        updatedAt: clock++,
      };
    },
    recordArtifact: (missionId, artifact) => {
      projection.artifacts[artifact.id] = {
        ...artifact,
        missionId,
        createdAt: artifact.createdAt ?? clock++,
      };
    },
    flushMissions: async () => undefined,
    now: () => clock,
  };
  return {
    controller: createIntegrationTrainController(ports),
    projection,
    outbox,
    applyCalls,
    acceptanceCalls,
    rollbackCalls,
    headByPath,
  };
}

async function ticks(harness: Harness, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await harness.controller.tick();
}

describe("integration train controller", () => {
  it("runs independent multi-root trains through durable integration and regression", async () => {
    const harness = makeHarness({ roots: ["/repo-a/subdir", "/repo-b/packages/api"] });
    await ticks(harness, 5);

    const trains = Object.values(harness.projection.integrationTrains);
    expect(trains).toHaveLength(2);
    expect(trains.every((train) => train.status === "completed")).toBe(true);
    expect(new Set(trains.map((train) => train.integrationBranch)).size).toBe(2);
    expect(trains.every((train) => train.integrationBranch.startsWith("swarmz/integration/"))).toBe(true);
    expect(harness.applyCalls).toHaveLength(2);
    expect(harness.acceptanceCalls).toHaveLength(2);
    expect(harness.acceptanceCalls.every((call) => call.argv.join(" ") === "pnpm test")).toBe(true);
    expect(harness.rollbackCalls).toHaveLength(0);
    expect(Object.values(harness.outbox)
      .filter((record) => ["integrate", "gate"].includes(record.command.kind))
      .every((record) => record.status === "delivered")).toBe(true);
    expect(Object.values(harness.projection.artifacts)
      .filter((artifact) => artifact.label === "integration-regression")).toHaveLength(2);
  });

  it("reconciles a success-before-ack crash without applying the patch twice", async () => {
    const harness = makeHarness({ applyMode: "crash_once" });
    await ticks(harness, 4);

    expect(harness.applyCalls).toHaveLength(2);
    const train = Object.values(harness.projection.integrationTrains)[0];
    expect(train.entries[0]).toMatchObject({ status: "integrated" });
    const integrationRecords = Object.values(harness.outbox)
      .filter((record) => record.command.kind === "integrate");
    expect(integrationRecords).toHaveLength(2);
    expect(integrationRecords.every((record) => record.status === "delivered")).toBe(true);
    expect(integrationRecords.some((record) =>
      String(record.delivery?.receipt.detail).includes("superseded"))).toBe(true);
  });

  it("turns a typed Git conflict into a blocked train and never rolls back automatically", async () => {
    const harness = makeHarness({ applyMode: "conflict" });
    await ticks(harness, 2);

    const train = Object.values(harness.projection.integrationTrains)[0];
    expect(train.status).toBe("blocked");
    expect(train.entries[0].status).toBe("failed");
    expect(train.entries[0].detail).toContain("src/conflict.ts");
    expect(harness.rollbackCalls).toHaveLength(0);
  });

  it("requires an exact human-selected checkpoint for destructive rollback", async () => {
    const harness = makeHarness();
    await ticks(harness, 2);
    const train = Object.values(harness.projection.integrationTrains)[0];
    const baseline = Object.values(harness.projection.artifacts)
      .find((artifact) => artifact.label === "integration-checkpoint");
    expect(baseline).toBeTruthy();

    const request: HumanRollbackRequest = {
      missionId: MISSION_ID,
      trainId: train.id,
      checkpointId: baseline?.id as string,
      approval: { approvalId: "human-rollback-1", approvedBy: "human", approvedAt: 20_000 },
    };
    const result = await harness.controller.humanApprovedRollback(request);

    expect(result.headAfter).toBe(BASE_A);
    expect(harness.rollbackCalls).toHaveLength(1);
    expect(harness.projection.integrationTrains[train.id].status).toBe("blocked");
    expect(Object.values(harness.projection.artifacts).some((artifact) =>
      artifact.label === "integration-rollback-completed")).toBe(true);
  });

  it("refuses shell syntax in an approved regression command", async () => {
    const harness = makeHarness({ command: "pnpm test && curl example.com" });
    await ticks(harness, 4);

    const train = Object.values(harness.projection.integrationTrains)[0];
    expect(train.status).toBe("blocked");
    expect(harness.acceptanceCalls).toHaveLength(0);
    expect(Object.values(harness.projection.artifacts).some((artifact) =>
      artifact.label === "integration-blocked" &&
      String(artifact.metadata.detail).includes("unsafe"))).toBe(true);
  });
});
