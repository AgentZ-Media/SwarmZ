import type { RuntimeCommandSpec, RuntimeEnvironmentSpec } from "./core";
import { buildRuntimeExecutionPlan, sha256Hex, validateRuntimeEnvironment } from "./core";
import {
  runRuntimeCommand,
  listRuntimeServices,
  startRuntimeService,
  stopRuntimeService,
  type NativeRuntimeCommandResult,
  type RuntimeServiceSnapshot,
} from "./native";

export interface RuntimeLaunchContext {
  projectId: string;
  mainRoot: string;
  projectRoot: string;
  missionId: string;
  attemptId: string;
  existingPorts?: ReadonlySet<number>;
}

export interface RuntimeLaunchResult {
  instanceId: string;
  setup: Array<{ commandId: string; result: NativeRuntimeCommandResult }>;
  services: RuntimeServiceSnapshot[];
  databaseNamespace: string;
}

function combinedFailure(message: string, primary: unknown, cleanup: unknown): Error {
  const detail = (value: unknown) => value instanceof Error ? value.message : String(value);
  return new Error(`${message}: ${detail(primary)}; cleanup: ${detail(cleanup)}`);
}

export function runtimeEnvironmentInstanceId(
  context: Pick<RuntimeLaunchContext, "missionId" | "attemptId">,
  environmentId: string,
): string {
  const clean = environmentId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 24) || "runtime";
  const digest = sha256Hex(JSON.stringify([environmentId, context.missionId, context.attemptId])).slice(0, 32);
  return `mission-${clean}-${digest}`;
}

async function runCommand(
  runId: string,
  root: string,
  mainRoot: string,
  command: RuntimeCommandSpec,
  env: Record<string, string>,
  spec: RuntimeEnvironmentSpec,
): Promise<NativeRuntimeCommandResult> {
  return runRuntimeCommand({
    runId,
    mainRoot,
    projectRoot: root,
    cwdRelative: command.cwdRelative,
    argv: command.argv,
    env,
    secretBindings: spec.secrets,
    timeoutMs: command.timeoutMs,
    maxOutputBytes: command.maxOutputBytes,
  });
}

async function stopServicesStrict(
  instanceId: string,
  projectRoot: string,
  serviceIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(serviceIds)];
  const outcomes = await Promise.allSettled(
    ids.map((serviceId) =>
      stopRuntimeService(instanceId, serviceId, projectRoot),
    ),
  );
  const failures = outcomes.flatMap((outcome, index) =>
    outcome.status === "rejected"
      ? [`${ids[index] ?? "unknown"}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`]
      : [],
  );
  const remaining = (await listRuntimeServices()).filter(
    (service) => service.instanceId === instanceId,
  );
  if (remaining.some((service) => service.projectRoot !== projectRoot)) {
    failures.push("deterministic instance is owned by another worktree");
  }
  if (remaining.length > 0) {
    failures.push(`services remain leased: ${remaining.map((service) => service.serviceId).join(", ")}`);
  }
  if (failures.length > 0) {
    throw new Error(`runtime service cleanup is unresolved (${failures.join("; ")})`);
  }
}

async function runCleanupStrict(
  id: string,
  root: string,
  mainRoot: string,
  commands: readonly RuntimeCommandSpec[],
  env: Record<string, string>,
  spec: RuntimeEnvironmentSpec,
  phase: string,
): Promise<Array<{ commandId: string; result: NativeRuntimeCommandResult }>> {
  const results: Array<{ commandId: string; result: NativeRuntimeCommandResult }> = [];
  const failures: string[] = [];
  for (const command of commands) {
    try {
      const result = await runCommand(
        `${id}:${phase}:${command.id}`,
        root,
        mainRoot,
        command,
        env,
        spec,
      );
      results.push({ commandId: command.id, result });
      if (result.status !== "completed" || result.exitCode !== 0) {
        failures.push(`${command.id}: ${result.status}/exit ${result.exitCode ?? "none"}`);
      }
    } catch (error) {
      failures.push(`${command.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`runtime cleanup is incomplete (${failures.join("; ")})`);
  }
  return results;
}

function serviceOwnershipMismatch(
  service: RuntimeServiceSnapshot,
  context: RuntimeLaunchContext,
  expectedServices: ReadonlySet<string>,
): boolean {
  return service.projectRoot !== context.projectRoot ||
    !expectedServices.has(service.serviceId) ||
    (!!service.ownerProjectId && service.ownerProjectId !== context.projectId) ||
    (!!service.ownerMissionId && service.ownerMissionId !== context.missionId) ||
    (!!service.ownerAttemptId && service.ownerAttemptId !== context.attemptId) ||
    (!!service.mainRoot && service.mainRoot !== context.mainRoot);
}

/**
 * Execute setup without starting services. Mission Control persists its
 * prepared receipt immediately after this boundary, before any worker turn.
 */
export async function prepareRuntimeEnvironment(
  spec: RuntimeEnvironmentSpec,
  context: RuntimeLaunchContext,
): Promise<RuntimeLaunchResult> {
  const validation = validateRuntimeEnvironment(spec);
  if (!validation.valid) throw new Error(validation.errors.join("; "));
  const plan = buildRuntimeExecutionPlan(spec, context, context.existingPorts ?? new Set());
  const runtimeEnv = { SWARMZ_DB_NAMESPACE: plan.databaseNamespace };
  const id = runtimeEnvironmentInstanceId(context, spec.id);
  const prior = (await listRuntimeServices()).filter((service) => service.instanceId === id);
  if (prior.length > 0) {
    throw new Error("runtime services exist before the setup receipt boundary");
  }
  const setup: RuntimeLaunchResult["setup"] = [];
  const cleanupPartialSetup = () =>
    runCleanupStrict(
      id,
      context.projectRoot,
      context.mainRoot,
      plan.cleanup,
      runtimeEnv,
      spec,
      "prepare-failure-cleanup",
    );
  for (const command of plan.setup) {
    let result: NativeRuntimeCommandResult;
    try {
      result = await runCommand(
        `${id}:prepare:${command.id}`,
        context.projectRoot,
        context.mainRoot,
        command,
        runtimeEnv,
        spec,
      );
    } catch (error) {
      try {
        await cleanupPartialSetup();
      } catch (cleanupError) {
        throw combinedFailure("runtime preparation and rollback both failed", error, cleanupError);
      }
      throw error;
    }
    setup.push({ commandId: command.id, result });
    if ((result.status !== "completed" || result.exitCode !== 0) && !command.continueOnFailure) {
      try {
        await cleanupPartialSetup();
      } catch (cleanupError) {
        throw combinedFailure(
          "runtime preparation and rollback both failed",
          new Error(`runtime setup command "${command.id}" failed`),
          cleanupError,
        );
      }
      throw new Error(`runtime setup command "${command.id}" failed`);
    }
  }
  return { instanceId: id, setup, services: [], databaseNamespace: plan.databaseNamespace };
}

/** Run setup serially, then start owned services. Rolls back services on failure. */
export async function launchRuntimeEnvironment(
  spec: RuntimeEnvironmentSpec,
  context: RuntimeLaunchContext,
): Promise<RuntimeLaunchResult> {
  const validation = validateRuntimeEnvironment(spec);
  if (!validation.valid) throw new Error(validation.errors.join("; "));
  const plan = buildRuntimeExecutionPlan(spec, context, context.existingPorts ?? new Set());
  const runtimeEnv = { SWARMZ_DB_NAMESPACE: plan.databaseNamespace };
  const id = runtimeEnvironmentInstanceId(context, spec.id);
  const expectedServices = new Set(spec.services.map((service) => service.id));
  const prior = (await listRuntimeServices()).filter((service) => service.instanceId === id);
  if (prior.some((service) => serviceOwnershipMismatch(service, context, expectedServices))) {
    throw new Error("runtime instance identity is already owned by another root or service set");
  }
  if (spec.services.length > 0 && prior.length === spec.services.length &&
    prior.every((service) => service.state === "running" || service.state === "starting")) {
    return { instanceId: id, setup: [], services: prior, databaseNamespace: plan.databaseNamespace };
  }
  // A crash may leave a subset of this exact attempt's services behind.
  // Stop only identity-checked members before repeating idempotent setup.
  await stopServicesStrict(id, context.projectRoot, prior.map((service) => service.serviceId));
  const setup: RuntimeLaunchResult["setup"] = [];
  const cleanupPartialSetup = async () => {
    await stopServicesStrict(id, context.projectRoot, spec.services.map((service) => service.id));
    await runCleanupStrict(
      id,
      context.projectRoot,
      context.mainRoot,
      plan.cleanup,
      runtimeEnv,
      spec,
      "setup-failure-cleanup",
    );
  };
  for (const command of plan.setup) {
    let result: NativeRuntimeCommandResult;
    try {
      result = await runCommand(
        `${id}:setup:${command.id}`,
        context.projectRoot,
        context.mainRoot,
        command,
        runtimeEnv,
        spec,
      );
    } catch (error) {
      try {
        await cleanupPartialSetup();
      } catch (cleanupError) {
        throw combinedFailure("runtime setup and rollback both failed", error, cleanupError);
      }
      throw error;
    }
    setup.push({ commandId: command.id, result });
    if ((result.status !== "completed" || result.exitCode !== 0) && !command.continueOnFailure) {
      // Setup may have created files, schemas or containers before the
      // failing step. Attempt every cleanup command (even if one fails) so
      // a partial environment does not become the next attempt's baseline.
      try {
        await cleanupPartialSetup();
      } catch (cleanupError) {
        throw combinedFailure(
          "runtime setup and rollback both failed",
          new Error(`runtime setup command "${command.id}" failed`),
          cleanupError,
        );
      }
      throw new Error(`runtime setup command "${command.id}" failed`);
    }
  }

  const services: RuntimeServiceSnapshot[] = [];
  try {
    for (const service of plan.services) {
      services.push(
        await startRuntimeService({
          instanceId: id,
          serviceId: service.id,
          ownerProjectId: context.projectId,
          ownerMissionId: context.missionId,
          ownerAttemptId: context.attemptId,
          mainRoot: context.mainRoot,
          projectRoot: context.projectRoot,
          cwdRelative: service.command.cwdRelative,
          argv: service.command.argv,
          env: {},
          secretBindings: spec.secrets,
          ports: service.ports,
          databaseNamespace: plan.databaseNamespace,
          healthcheckUrl: service.healthcheckUrl,
          maxOutputBytes: service.command.maxOutputBytes,
        }),
      );
    }
  } catch (error) {
    try {
      await stopServicesStrict(id, context.projectRoot, spec.services.map((service) => service.id));
    } catch (cleanupError) {
      throw combinedFailure("runtime service start and rollback both failed", error, cleanupError);
    }
    throw error;
  }
  return { instanceId: id, setup, services, databaseNamespace: plan.databaseNamespace };
}

/**
 * Resume services after a durable Mission receipt proved setup completed.
 * This deliberately never executes setup again.
 */
export async function resumePreparedRuntimeEnvironment(
  spec: RuntimeEnvironmentSpec,
  context: RuntimeLaunchContext,
): Promise<RuntimeLaunchResult> {
  const validation = validateRuntimeEnvironment(spec);
  if (!validation.valid) throw new Error(validation.errors.join("; "));
  const plan = buildRuntimeExecutionPlan(spec, context, context.existingPorts ?? new Set());
  const id = runtimeEnvironmentInstanceId(context, spec.id);
  const expectedServices = new Set(spec.services.map((service) => service.id));
  const prior = (await listRuntimeServices()).filter((service) => service.instanceId === id);
  if (prior.some((service) => serviceOwnershipMismatch(service, context, expectedServices))) {
    throw new Error("runtime instance identity is already owned by another root or service set");
  }
  if (prior.length === spec.services.length &&
    prior.every((service) => service.state === "running" || service.state === "starting")) {
    return { instanceId: id, setup: [], services: prior, databaseNamespace: plan.databaseNamespace };
  }
  await stopServicesStrict(id, context.projectRoot, prior.map((service) => service.serviceId));
  const services: RuntimeServiceSnapshot[] = [];
  try {
    for (const service of plan.services) {
      services.push(await startRuntimeService({
        instanceId: id,
        serviceId: service.id,
        ownerProjectId: context.projectId,
        ownerMissionId: context.missionId,
        ownerAttemptId: context.attemptId,
        mainRoot: context.mainRoot,
        projectRoot: context.projectRoot,
        cwdRelative: service.command.cwdRelative,
        argv: service.command.argv,
        env: {},
        secretBindings: spec.secrets,
        ports: service.ports,
        databaseNamespace: plan.databaseNamespace,
        healthcheckUrl: service.healthcheckUrl,
        maxOutputBytes: service.command.maxOutputBytes,
      }));
    }
  } catch (error) {
    try {
      await stopServicesStrict(id, context.projectRoot, spec.services.map((service) => service.id));
    } catch (cleanupError) {
      throw combinedFailure("runtime service resume and rollback both failed", error, cleanupError);
    }
    throw error;
  }
  return { instanceId: id, setup: [], services, databaseNamespace: plan.databaseNamespace };
}

/** Stop all owned services first, then run cleanup commands serially. */
export async function cleanupRuntimeEnvironment(
  spec: RuntimeEnvironmentSpec,
  context: RuntimeLaunchContext,
): Promise<Array<{ commandId: string; result: NativeRuntimeCommandResult }>> {
  const plan = buildRuntimeExecutionPlan(spec, context, context.existingPorts ?? new Set());
  const runtimeEnv = { SWARMZ_DB_NAMESPACE: plan.databaseNamespace };
  const id = runtimeEnvironmentInstanceId(context, spec.id);
  const expectedServices = new Set(spec.services.map((service) => service.id));
  const prior = (await listRuntimeServices()).filter((service) => service.instanceId === id);
  if (prior.some((service) => serviceOwnershipMismatch(service, context, expectedServices))) {
    throw new Error("refused to clean a runtime instance owned by another root or service set");
  }
  await stopServicesStrict(id, context.projectRoot, prior.map((service) => service.serviceId));
  return runCleanupStrict(
    id,
    context.projectRoot,
    context.mainRoot,
    plan.cleanup,
    runtimeEnv,
    spec,
    "cleanup",
  );
}
