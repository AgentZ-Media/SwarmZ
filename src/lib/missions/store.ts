import { nanoid } from "nanoid";
import { create } from "zustand";
import { loadMissions, saveMissions } from "@/lib/transport";
import {
  createPersistenceCoordinator,
  type HydrationStatus,
} from "@/lib/persistence/coordinator";
import {
  emptyMissionProjection,
  nextMissionRevision,
  reduceMissionEvent,
  replayMissionEvents,
} from "./core";
import { migratePersistedMissions, serializeMissionEvents } from "./serialization";
import type {
  AttemptStatus,
  IntegrationTrain,
  IntegrationTrainEntry,
  Mission,
  MissionArtifact,
  MissionDependency,
  MissionBudget,
  MissionEvent,
  MissionEventPayload,
  MissionPolicy,
  MissionProjection,
  MissionTask,
  MissionTaskInput,
  QualityGate,
  QualityGateStatus,
  TaskAttempt,
} from "./types";

export const DEFAULT_MISSION_POLICY: MissionPolicy = {
  maxParallelAttempts: 8,
  stopOnCriticalFailure: true,
  requireQualityGates: true,
  integrationMode: "train",
  archiveCompletedWorkers: true,
};

export const DEFAULT_MISSION_BUDGET: MissionBudget = {
  maxAttemptsTotal: null,
  maxActiveMinutes: null,
  maxTokens: null,
  maxCostUsd: null,
};

export interface MissionCommandMeta {
  actor?: MissionEvent["actor"];
  idempotencyKey?: string;
  occurredAt?: number;
  eventId?: string;
}

export interface CreateMissionInput {
  id?: string;
  projectId: string;
  title: string;
  objective: string;
  policy?: Partial<MissionPolicy>;
  budget?: Partial<MissionBudget>;
}

export type AddMissionTaskInput = Omit<
  MissionTaskInput,
  "missionId" | "createdAt"
> & { createdAt?: number };

type TaskPatch = Extract<
  MissionEventPayload,
  { type: "task.updated" }
>["data"]["patch"];

export interface MissionsState {
  projection: MissionProjection;
  events: MissionEvent[];
  hydrated: boolean;
  hydrateStatus: HydrationStatus;
  hydrateError: string | null;

  hydrate: () => Promise<void>;
  appendEvent: (event: MissionEvent) => boolean;
  appendEvents: (events: readonly MissionEvent[]) => number;
  createMission: (input: CreateMissionInput, meta?: MissionCommandMeta) => string;
  addTask: (missionId: string, task: AddMissionTaskInput, meta?: MissionCommandMeta) => string;
  addTasks: (missionId: string, tasks: readonly AddMissionTaskInput[], meta?: MissionCommandMeta) => string[];
  updateTask: (missionId: string, taskId: string, patch: TaskPatch, meta?: MissionCommandMeta) => void;
  updateTasks: (missionId: string, updates: readonly { taskId: string; patch: TaskPatch }[], meta?: MissionCommandMeta) => void;
  activateMission: (missionId: string, meta?: MissionCommandMeta) => void;
  pauseMission: (missionId: string, meta?: MissionCommandMeta) => void;
  cancelMission: (missionId: string, meta?: MissionCommandMeta) => void;
  archiveMission: (missionId: string, meta?: MissionCommandMeta) => void;
  pauseTask: (missionId: string, taskId: string, meta?: MissionCommandMeta) => void;
  resumeTask: (missionId: string, taskId: string, meta?: MissionCommandMeta) => void;
  archiveTask: (missionId: string, taskId: string, meta?: MissionCommandMeta) => void;
  createAttempt: (
    missionId: string,
    taskId: string,
    input?: { id?: string; sessionId?: string | null; workerLabel?: string | null },
    meta?: MissionCommandMeta,
  ) => string;
  settleAttempt: (
    missionId: string,
    attemptId: string,
    input: {
      status: Exclude<AttemptStatus, "queued" | "running">;
      summary?: string | null;
      error?: string | null;
      report?: Record<string, unknown> | null;
    },
    meta?: MissionCommandMeta,
  ) => void;
  recordArtifact: (
    missionId: string,
    input: Omit<MissionArtifact, "id" | "missionId" | "createdAt"> & {
      id?: string;
      createdAt?: number;
    },
    meta?: MissionCommandMeta,
  ) => string;
  addQualityGate: (
    missionId: string,
    input: Omit<
      QualityGate,
      "id" | "missionId" | "status" | "details" | "artifactIds" | "createdAt" | "updatedAt"
    > & { id?: string; createdAt?: number },
    meta?: MissionCommandMeta,
  ) => string;
  settleQualityGate: (
    missionId: string,
    gateId: string,
    input: {
      status: Exclude<QualityGateStatus, "pending" | "running">;
      details?: string | null;
      artifactIds?: string[];
    },
    meta?: MissionCommandMeta,
  ) => void;
  createIntegrationTrain: (
    missionId: string,
    input: Omit<IntegrationTrain, "id" | "missionId" | "createdAt" | "updatedAt"> & {
      id?: string;
    },
    meta?: MissionCommandMeta,
  ) => string;
  updateIntegrationTrain: (
    missionId: string,
    trainId: string,
    patch: { status?: IntegrationTrain["status"]; entries?: IntegrationTrainEntry[] },
    meta?: MissionCommandMeta,
  ) => void;
}

function snapshot() {
  return serializeMissionEvents(useMissions.getState().events);
}

const persistence = createPersistenceCoordinator({
  name: "missions",
  debounceMs: 100,
  snapshot,
  save: saveMissions,
});

function assertWritable(state: MissionsState): void {
  if (state.hydrateStatus !== "ready") {
    throw new Error("Mission Control storage is not safely hydrated");
  }
}

function makeEvent(
  projection: MissionProjection,
  missionId: string,
  payload: MissionEventPayload,
  meta: MissionCommandMeta = {},
): MissionEvent {
  return {
    ...payload,
    eventId: meta.eventId ?? nanoid(16),
    missionId,
    revision: nextMissionRevision(projection, missionId),
    occurredAt: meta.occurredAt ?? Date.now(),
    actor: meta.actor ?? "human",
    ...(meta.idempotencyKey ? { idempotencyKey: meta.idempotencyKey } : {}),
  } as MissionEvent;
}

function appendPayloads(
  get: () => MissionsState,
  set: (patch: Partial<MissionsState>) => void,
  missionId: string,
  payloads: readonly MissionEventPayload[],
  meta: MissionCommandMeta = {},
): MissionEvent[] {
  const state = get();
  assertWritable(state);
  let projection = state.projection;
  const appended: MissionEvent[] = [];
  for (let index = 0; index < payloads.length; index += 1) {
    const perEventMeta: MissionCommandMeta = {
      ...meta,
      // A bulk command gets stable, non-colliding keys while preserving the
      // caller's command-level idempotency namespace.
      ...(meta.idempotencyKey
        ? { idempotencyKey: `${meta.idempotencyKey}:${index}` }
        : {}),
      ...(meta.eventId ? { eventId: `${meta.eventId}:${index}` } : {}),
    };
    const event = makeEvent(projection, missionId, payloads[index], perEventMeta);
    const next = reduceMissionEvent(projection, event);
    if (next !== projection) appended.push(event);
    projection = next;
  }
  if (appended.length > 0) {
    set({ projection, events: [...state.events, ...appended] });
    persistence.schedule();
  }
  return appended;
}

function orderTaskBatch(
  projection: MissionProjection,
  missionId: string,
  inputs: readonly AddMissionTaskInput[],
  ids: readonly string[],
): Array<{ input: AddMissionTaskInput; id: string }> {
  const pending = new Map<string, { input: AddMissionTaskInput; id: string }>();
  inputs.forEach((input, index) => {
    const id = ids[index];
    if (pending.has(id) || projection.tasks[id]) {
      throw new Error(`duplicate task id in batch: ${id}`);
    }
    pending.set(id, { input, id });
  });
  const available = new Set(
    Object.values(projection.tasks)
      .filter((task) => task.missionId === missionId)
      .map((task) => task.id),
  );
  const ordered: Array<{ input: AddMissionTaskInput; id: string }> = [];
  while (pending.size > 0) {
    let progressed = false;
    for (const [id, item] of pending) {
      if (item.input.dependencyIds.every((dependencyId) => available.has(dependencyId))) {
        ordered.push(item);
        available.add(id);
        pending.delete(id);
        progressed = true;
      }
    }
    if (!progressed) {
      const unresolved = [...pending.values()].flatMap(({ input }) =>
        input.dependencyIds.filter((id) => !available.has(id)),
      );
      throw new Error(
        `task batch has an unknown or cyclic dependency: ${unresolved.join(", ")}`,
      );
    }
  }
  return ordered;
}

export const useMissions = create<MissionsState>((set, get) => ({
  projection: emptyMissionProjection(),
  events: [],
  hydrated: false,
  hydrateStatus: "pending",
  hydrateError: null,

  hydrate: async () => {
    try {
      const persisted = migratePersistedMissions(await loadMissions());
      const projection = replayMissionEvents(persisted.events);
      set({
        projection,
        events: persisted.events,
        hydrated: true,
        hydrateStatus: "ready",
        hydrateError: null,
      });
      persistence.hydrationSucceeded();
      // v1 is normalized by migration; scheduling writes the v2 envelope.
      persistence.schedule();
    } catch (error) {
      persistence.hydrationFailed(error);
      set({
        hydrated: false,
        hydrateStatus: "failed",
        hydrateError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  appendEvent: (event) => {
    const state = get();
    assertWritable(state);
    const projection = reduceMissionEvent(state.projection, event);
    if (projection === state.projection) return false;
    set({ projection, events: [...state.events, event] });
    persistence.schedule();
    return true;
  },

  appendEvents: (events) => {
    const state = get();
    assertWritable(state);
    let projection = state.projection;
    const accepted: MissionEvent[] = [];
    for (const event of events) {
      const next = reduceMissionEvent(projection, event);
      if (next !== projection) accepted.push(event);
      projection = next;
    }
    if (accepted.length) {
      set({ projection, events: [...state.events, ...accepted] });
      persistence.schedule();
    }
    return accepted.length;
  },

  createMission: (input, meta) => {
    const id = input.id ?? nanoid(12);
    appendPayloads(get, set, id, [
      {
        type: "mission.created",
        data: {
          projectId: input.projectId,
          title: input.title,
          objective: input.objective,
          policy: { ...DEFAULT_MISSION_POLICY, ...input.policy },
          budget: { ...DEFAULT_MISSION_BUDGET, ...input.budget },
          createdAt: meta?.occurredAt ?? Date.now(),
        },
      },
    ], meta);
    return id;
  },

  addTask: (missionId, input, meta) => {
    const id = input.id || nanoid(12);
    appendPayloads(get, set, missionId, [{
      type: "task.added",
      data: {
        ...input,
        id,
        missionId,
        createdAt: input.createdAt ?? meta?.occurredAt ?? Date.now(),
      },
    }], meta);
    return id;
  },

  addTasks: (missionId, inputs, meta) => {
    const at = meta?.occurredAt ?? Date.now();
    const ids = inputs.map((input) => input.id || nanoid(12));
    const ordered = orderTaskBatch(get().projection, missionId, inputs, ids);
    appendPayloads(
      get,
      set,
      missionId,
      ordered.map(({ input, id }) => ({
        type: "task.added" as const,
        data: {
          ...input,
          id,
          missionId,
          createdAt: input.createdAt ?? at,
        },
      })),
      { ...meta, occurredAt: at },
    );
    return ids;
  },

  updateTask: (missionId, taskId, patch, meta) => {
    appendPayloads(get, set, missionId, [{
      type: "task.updated",
      data: { taskId, patch, updatedAt: meta?.occurredAt ?? Date.now() },
    }], meta);
  },

  updateTasks: (missionId, updates, meta) => {
    const at = meta?.occurredAt ?? Date.now();
    appendPayloads(get, set, missionId, updates.map(({ taskId, patch }) => ({
      type: "task.updated" as const,
      data: { taskId, patch, updatedAt: at },
    })), { ...meta, occurredAt: at });
  },

  activateMission: (missionId, meta) => {
    const mission = get().projection.missions[missionId];
    if (!mission) throw new Error("mission is unknown");
    const at = meta?.occurredAt ?? Date.now();
    appendPayloads(get, set, missionId, [
      mission.pausedAt !== null
        ? { type: "mission.resumed", data: { resumedAt: at } }
        : { type: "mission.activated", data: { activatedAt: at } },
    ], meta);
  },
  pauseMission: (missionId, meta) => {
    appendPayloads(get, set, missionId, [{ type: "mission.paused", data: { pausedAt: meta?.occurredAt ?? Date.now() } }], meta);
  },
  cancelMission: (missionId, meta) => {
    appendPayloads(get, set, missionId, [{ type: "mission.cancelled", data: { cancelledAt: meta?.occurredAt ?? Date.now() } }], meta);
  },
  archiveMission: (missionId, meta) => {
    appendPayloads(get, set, missionId, [{ type: "mission.archived", data: { archivedAt: meta?.occurredAt ?? Date.now() } }], meta);
  },
  pauseTask: (missionId, taskId, meta) => {
    appendPayloads(get, set, missionId, [{ type: "task.paused", data: { taskId, pausedAt: meta?.occurredAt ?? Date.now() } }], meta);
  },
  resumeTask: (missionId, taskId, meta) => {
    appendPayloads(get, set, missionId, [{ type: "task.resumed", data: { taskId, resumedAt: meta?.occurredAt ?? Date.now() } }], meta);
  },
  archiveTask: (missionId, taskId, meta) => {
    appendPayloads(get, set, missionId, [{ type: "task.archived", data: { taskId, archivedAt: meta?.occurredAt ?? Date.now() } }], meta);
  },

  createAttempt: (missionId, taskId, input, meta) => {
    const id = input?.id ?? nanoid(14);
    appendPayloads(get, set, missionId, [{
      type: "attempt.started",
      data: {
        id,
        taskId,
        sessionId: input?.sessionId ?? null,
        workerLabel: input?.workerLabel ?? null,
        startedAt: meta?.occurredAt ?? Date.now(),
      },
    }], meta);
    return id;
  },

  settleAttempt: (missionId, attemptId, input, meta) => {
    appendPayloads(get, set, missionId, [{
      type: "attempt.finished",
      data: {
        attemptId,
        ...input,
        finishedAt: meta?.occurredAt ?? Date.now(),
      },
    }], meta);
  },

  recordArtifact: (missionId, input, meta) => {
    const id = input.id ?? nanoid(14);
    appendPayloads(get, set, missionId, [{
      type: "artifact.recorded",
      data: {
        ...input,
        id,
        missionId,
        createdAt: input.createdAt ?? meta?.occurredAt ?? Date.now(),
      },
    }], meta);
    return id;
  },

  addQualityGate: (missionId, input, meta) => {
    const id = input.id ?? nanoid(14);
    appendPayloads(get, set, missionId, [{
      type: "quality_gate.added",
      data: {
        ...input,
        id,
        missionId,
        createdAt: input.createdAt ?? meta?.occurredAt ?? Date.now(),
      },
    }], meta);
    return id;
  },

  settleQualityGate: (missionId, gateId, input, meta) => {
    appendPayloads(get, set, missionId, [{
      type: "quality_gate.resulted",
      data: {
        gateId,
        ...input,
        updatedAt: meta?.occurredAt ?? Date.now(),
      },
    }], meta);
  },

  createIntegrationTrain: (missionId, input, meta) => {
    const id = input.id ?? nanoid(14);
    const at = meta?.occurredAt ?? Date.now();
    appendPayloads(get, set, missionId, [{
      type: "integration_train.created",
      data: {
        ...input,
        id,
        missionId,
        createdAt: at,
        updatedAt: at,
      },
    }], meta);
    return id;
  },

  updateIntegrationTrain: (missionId, trainId, patch, meta) => {
    appendPayloads(get, set, missionId, [{
      type: "integration_train.updated",
      data: {
        trainId,
        ...patch,
        updatedAt: meta?.occurredAt ?? Date.now(),
      },
    }], meta);
  },
}));

export async function hydrateMissions(): Promise<void> {
  await useMissions.getState().hydrate();
}

export async function flushMissionsPersist(): Promise<void> {
  await persistence.flush();
}

export function missionById(state: MissionsState, missionId: string): Mission | null {
  return state.projection.missions[missionId] ?? null;
}

export function tasksForMission(state: MissionsState, missionId: string): MissionTask[] {
  const mission = state.projection.missions[missionId];
  return mission
    ? mission.taskIds.map((id) => state.projection.tasks[id]).filter((task): task is MissionTask => !!task)
    : [];
}

export function readyTasksForMission(state: MissionsState, missionId: string): MissionTask[] {
  return tasksForMission(state, missionId)
    .filter((task) => task.status === "ready")
    .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function dependenciesForTask(
  state: MissionsState,
  taskId: string,
): MissionDependency[] {
  return Object.values(state.projection.dependencies)
    .filter((dependency) => dependency.taskId === taskId)
    .sort((a, b) => a.dependsOnTaskId.localeCompare(b.dependsOnTaskId));
}

export function attemptsForTask(state: MissionsState, taskId: string): TaskAttempt[] {
  const task = state.projection.tasks[taskId];
  return task
    ? task.attemptIds.map((id) => state.projection.attempts[id]).filter((attempt): attempt is TaskAttempt => !!attempt)
    : [];
}

export function currentAttemptForTask(state: MissionsState, taskId: string): TaskAttempt | null {
  const attempts = attemptsForTask(state, taskId);
  return attempts[attempts.length - 1] ?? null;
}
