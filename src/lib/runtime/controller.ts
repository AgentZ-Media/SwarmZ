import type { RuntimeCommandSpec, RuntimeEnvironmentSpec } from "./core";
import { buildRuntimeExecutionPlan, validateRuntimeEnvironment } from "./core";
import {
  runRuntimeCommand,
  startRuntimeService,
  stopRuntimeService,
  type NativeRuntimeCommandResult,
  type RuntimeServiceSnapshot,
} from "./native";

export interface RuntimeLaunchContext {
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

function instanceId(context: RuntimeLaunchContext, environmentId: string): string {
  const clean = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 36);
  return `${clean(environmentId)}:${clean(context.missionId)}:${clean(context.attemptId)}`;
}

async function runCommand(
  runId: string,
  root: string,
  command: RuntimeCommandSpec,
  env: Record<string, string>,
  spec: RuntimeEnvironmentSpec,
): Promise<NativeRuntimeCommandResult> {
  return runRuntimeCommand({
    runId,
    projectRoot: root,
    cwdRelative: command.cwdRelative,
    argv: command.argv,
    env,
    secretBindings: spec.secrets,
    timeoutMs: command.timeoutMs,
    maxOutputBytes: command.maxOutputBytes,
  });
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
  const id = instanceId(context, spec.id);
  const setup: RuntimeLaunchResult["setup"] = [];
  const cleanupPartialSetup = async () => {
    await Promise.allSettled(spec.services.map((service) => stopRuntimeService(id, service.id)));
    for (const cleanup of plan.cleanup) {
      try {
        await runCommand(
          `${id}:setup-failure-cleanup:${cleanup.id}`,
          context.projectRoot,
          cleanup,
          runtimeEnv,
          spec,
        );
      } catch {
        // Best effort by definition: retain the original setup failure.
      }
    }
  };
  for (const command of plan.setup) {
    let result: NativeRuntimeCommandResult;
    try {
      result = await runCommand(
        `${id}:setup:${command.id}`,
        context.projectRoot,
        command,
        runtimeEnv,
        spec,
      );
    } catch (error) {
      await cleanupPartialSetup();
      throw error;
    }
    setup.push({ commandId: command.id, result });
    if ((result.status !== "completed" || result.exitCode !== 0) && !command.continueOnFailure) {
      // Setup may have created files, schemas or containers before the
      // failing step. Attempt every cleanup command (even if one fails) so
      // a partial environment does not become the next attempt's baseline.
      await cleanupPartialSetup();
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
    await Promise.allSettled(services.map((service) => stopRuntimeService(id, service.serviceId)));
    throw error;
  }
  return { instanceId: id, setup, services, databaseNamespace: plan.databaseNamespace };
}

/** Stop all owned services first, then run cleanup commands serially. */
export async function cleanupRuntimeEnvironment(
  spec: RuntimeEnvironmentSpec,
  context: RuntimeLaunchContext,
): Promise<Array<{ commandId: string; result: NativeRuntimeCommandResult }>> {
  const plan = buildRuntimeExecutionPlan(spec, context, context.existingPorts ?? new Set());
  const runtimeEnv = { SWARMZ_DB_NAMESPACE: plan.databaseNamespace };
  const id = instanceId(context, spec.id);
  await Promise.allSettled(spec.services.map((service) => stopRuntimeService(id, service.id)));
  const results: Array<{ commandId: string; result: NativeRuntimeCommandResult }> = [];
  for (const command of plan.cleanup) {
    const result = await runCommand(`${id}:cleanup:${command.id}`, context.projectRoot, command, runtimeEnv, spec);
    results.push({ commandId: command.id, result });
    if ((result.status !== "completed" || result.exitCode !== 0) && !command.continueOnFailure) {
      break;
    }
  }
  return results;
}
