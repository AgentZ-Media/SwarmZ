import {
  cleanupRuntimeEnvironment,
  launchRuntimeEnvironment,
  prepareRuntimeEnvironment,
  resumePreparedRuntimeEnvironment,
  runtimeEnvironmentInstanceId,
  type RuntimeLaunchResult,
} from "@/lib/runtime/controller";
import { runtimeSpecFingerprint, type RuntimeEnvironmentSpec } from "@/lib/runtime/core";
import { listRuntimeServices, stopRuntimeService } from "@/lib/runtime/native";
import { useRuntimeEnvironments } from "@/lib/runtime/store";
import type { MissionRuntimeBinding } from "./types";

export interface MissionRuntimeContext {
  projectId: string;
  mainRoot: string;
  projectRoot: string;
  missionId: string;
  attemptId: string;
}

export interface BoundMissionRuntime {
  binding: MissionRuntimeBinding;
  spec: RuntimeEnvironmentSpec;
}

function requireRetrySafeMissionCommands(spec: RuntimeEnvironmentSpec): void {
  if (spec.secrets.length > 0) {
    throw new Error(
      "mission Runtime Environments refuse secret bindings: worker-controlled code could persist a secret into its worktree",
    );
  }
  const unsafe = [...spec.setup, ...spec.cleanup].find((command) => command.idempotent !== true);
  if (unsafe) {
    throw new Error(
      `runtime command must be marked safe to retry before Mission approval: ${unsafe.id}`,
    );
  }
}

export function bindingForRuntimeSpec(spec: RuntimeEnvironmentSpec): MissionRuntimeBinding {
  requireRetrySafeMissionCommands(spec);
  return {
    environmentId: spec.id,
    specFingerprint: runtimeSpecFingerprint(spec),
  };
}

/** Resolve by id and digest; any missing or edited spec is an authority drift. */
export function resolveMissionRuntimeBinding(
  binding: MissionRuntimeBinding,
  specs: readonly RuntimeEnvironmentSpec[],
): BoundMissionRuntime {
  const spec = specs.find((candidate) => candidate.id === binding.environmentId);
  if (!spec) throw new Error(`approved runtime environment is missing: ${binding.environmentId}`);
  requireRetrySafeMissionCommands(spec);
  const actual = runtimeSpecFingerprint(spec);
  if (actual !== binding.specFingerprint) {
    throw new Error(`approved runtime environment changed: ${binding.environmentId}`);
  }
  return { binding, spec };
}

export function resolveProjectMissionRuntime(
  projectId: string,
  binding: MissionRuntimeBinding,
): BoundMissionRuntime {
  const state = useRuntimeEnvironments.getState();
  if (!state.hydrated) throw new Error(state.hydrateError ?? "runtime environment store is not ready");
  return resolveMissionRuntimeBinding(binding, state.byProject[projectId] ?? []);
}

/** Only non-secret coordinates are appended to the worker's one durable prompt. */
export function missionRuntimePrompt(result: RuntimeLaunchResult): string {
  const services = result.services.map((service) => {
    const ports = Object.entries(service.ports)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, port]) => `${name}=${port}`)
      .join(", ");
    return `- ${service.serviceId}${ports ? ` (${ports})` : ""}`;
  });
  return [
    "SwarmZ prepared the approved Runtime Environment before this turn.",
    `Database namespace: ${result.databaseNamespace}`,
    services.length ? `Available local services:\n${services.join("\n")}` : "No background services are configured.",
    "No host credentials were injected into this worker-controlled Runtime Environment.",
  ].join("\n");
}

export async function launchBoundMissionRuntime(
  binding: MissionRuntimeBinding,
  context: MissionRuntimeContext,
): Promise<{ result: RuntimeLaunchResult; prompt: string }> {
  const { spec } = resolveProjectMissionRuntime(context.projectId, binding);
  const result = await launchRuntimeEnvironment(spec, context);
  return { result, prompt: missionRuntimePrompt(result) };
}

export async function prepareBoundMissionRuntime(
  binding: MissionRuntimeBinding,
  context: MissionRuntimeContext,
): Promise<RuntimeLaunchResult> {
  const { spec } = resolveProjectMissionRuntime(context.projectId, binding);
  return prepareRuntimeEnvironment(spec, context);
}

export async function resumePreparedBoundMissionRuntime(
  binding: MissionRuntimeBinding,
  context: MissionRuntimeContext,
): Promise<{ result: RuntimeLaunchResult; prompt: string }> {
  const { spec } = resolveProjectMissionRuntime(context.projectId, binding);
  const result = await resumePreparedRuntimeEnvironment(spec, context);
  return { result, prompt: missionRuntimePrompt(result) };
}

/**
 * Cleanup uses the approved spec when it still matches. On drift, it skips
 * changed cleanup commands but stops only this deterministic instance's
 * identity-checked services under the exact attempt worktree.
 */
export async function cleanupBoundMissionRuntime(
  binding: MissionRuntimeBinding,
  context: MissionRuntimeContext,
): Promise<void> {
  let spec: RuntimeEnvironmentSpec;
  try {
    spec = resolveProjectMissionRuntime(context.projectId, binding).spec;
  } catch {
    const instanceId = runtimeEnvironmentInstanceId(context, binding.environmentId);
    const owned = (await listRuntimeServices()).filter((service) => service.instanceId === instanceId);
    if (owned.some((service) =>
      service.projectRoot !== context.projectRoot ||
      (!!service.ownerProjectId && service.ownerProjectId !== context.projectId) ||
      (!!service.ownerMissionId && service.ownerMissionId !== context.missionId) ||
      (!!service.ownerAttemptId && service.ownerAttemptId !== context.attemptId) ||
      (!!service.mainRoot && service.mainRoot !== context.mainRoot),
    )) {
      throw new Error("refused to stop a runtime instance owned by another worktree");
    }
    const stopped = await Promise.allSettled(
      owned.map((service) =>
        stopRuntimeService(instanceId, service.serviceId, context.projectRoot),
      ),
    );
    const errors = stopped.flatMap((result) =>
      result.status === "rejected"
        ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
        : [],
    );
    const remaining = (await listRuntimeServices()).filter(
      (service) => service.instanceId === instanceId,
    );
    if (errors.length > 0 || remaining.length > 0) {
      throw new Error(
        `runtime stop-only cleanup is unresolved: ${[
          ...errors,
          ...remaining.map((service) => service.serviceId),
        ].join("; ")}`,
      );
    }
    return;
  }
  // Execution errors from an unchanged approved cleanup spec must propagate;
  // falling back to stop-only would falsely certify setup-created state as
  // cleaned and let Mission Control persist a lying cleanup artifact.
  await cleanupRuntimeEnvironment(spec, context);
}
