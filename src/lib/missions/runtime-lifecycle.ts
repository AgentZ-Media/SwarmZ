import { runtimeEnvironmentInstanceId, type RuntimeLaunchResult } from "@/lib/runtime/controller";
import { useMissions } from "./store";
import type { MissionRuntimeBinding, TaskAttempt } from "./types";
import {
  cleanupBoundMissionRuntime,
  type MissionRuntimeContext,
} from "./runtime-binding";
import { flushMissionOrThrow, safeId, spawnRecordForAttempt } from "./controller-shared";

export function runtimeBindingForMission(missionId: string): MissionRuntimeBinding | null {
  return useMissions.getState().projection.missions[missionId]?.policy.runtimeEnvironment ?? null;
}

export function runtimeContextForAttempt(attempt: TaskAttempt): MissionRuntimeContext | null {
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

export async function cleanupAttemptRuntimeBestEffort(attempt: TaskAttempt): Promise<void> {
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

export function runtimePreparedReceipt(
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

export async function recordRuntimePrepared(
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
