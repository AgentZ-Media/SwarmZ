import { invoke } from "@tauri-apps/api/core";
import type { RuntimeSecretBinding } from "./core";

export interface NativeRuntimeCommandRequest {
  runId: string;
  projectRoot: string;
  cwdRelative: string;
  argv: string[];
  env?: Record<string, string>;
  secretBindings?: RuntimeSecretBinding[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface NativeRuntimeCommandResult {
  status: "completed" | "timed_out" | "cancelled";
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface NativeRuntimeServiceStartRequest {
  instanceId: string;
  serviceId: string;
  ownerProjectId: string;
  ownerMissionId: string;
  ownerAttemptId: string;
  mainRoot: string;
  projectRoot: string;
  cwdRelative: string;
  argv: string[];
  env?: Record<string, string>;
  secretBindings?: RuntimeSecretBinding[];
  ports?: Array<{ env: string; preferred: number | null }>;
  databaseNamespace: string;
  healthcheckUrl?: string | null;
  maxOutputBytes: number;
}

export type RuntimeServiceState =
  | "starting"
  | "running"
  | "exited"
  | "stopping"
  | "orphaned";

export interface RuntimeServiceSnapshot {
  instanceId: string;
  serviceId: string;
  ownerProjectId: string;
  ownerMissionId: string;
  ownerAttemptId: string;
  mainRoot: string;
  projectRoot: string;
  state: RuntimeServiceState;
  pid: number | null;
  ports: Record<string, number>;
  startedAt: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface RuntimeReconcileResult {
  cleaned: string[];
  stale: string[];
  unresolved: string[];
}

export function runRuntimeCommand(
  request: NativeRuntimeCommandRequest,
): Promise<NativeRuntimeCommandResult> {
  return invoke<NativeRuntimeCommandResult>("runtime_command_run", {
    request: {
      ...request,
      env: request.env ?? {},
      secretBindings: request.secretBindings ?? [],
    },
  });
}

export function cancelRuntimeCommand(runId: string): Promise<boolean> {
  return invoke<boolean>("runtime_command_cancel", { runId });
}

export function startRuntimeService(
  request: NativeRuntimeServiceStartRequest,
): Promise<RuntimeServiceSnapshot> {
  return invoke<RuntimeServiceSnapshot>("runtime_service_start", {
    request: {
      ...request,
      env: request.env ?? {},
      secretBindings: request.secretBindings ?? [],
      ports: request.ports ?? [],
    },
  });
}

export function stopRuntimeService(
  instanceId: string,
  serviceId: string,
  projectRoot: string,
): Promise<boolean> {
  return invoke<boolean>("runtime_service_stop", { instanceId, serviceId, projectRoot });
}

export function listRuntimeServices(): Promise<RuntimeServiceSnapshot[]> {
  return invoke<RuntimeServiceSnapshot[]>("runtime_service_list");
}

export function reconcileRuntimeServices(): Promise<RuntimeReconcileResult> {
  return invoke<RuntimeReconcileResult>("runtime_service_reconcile");
}

export function stopAllRuntimeServices(): Promise<RuntimeReconcileResult> {
  return invoke<RuntimeReconcileResult>("runtime_service_stop_all");
}
