import { invoke } from "@tauri-apps/api/core";

export type NativeIntegrationStrategy = "cherry_pick" | "merge";

export interface IntegrationApplyRequest {
  root: string;
  worktreePath: string;
  integrationBranch: string;
  expectedHead: string;
  commit: string;
  strategy: NativeIntegrationStrategy;
  gitBin?: string;
}

export interface IntegrationApplyResult {
  status: "applied" | "already_applied" | "blocked";
  strategy: NativeIntegrationStrategy;
  commit: string;
  headBefore: string;
  headAfter: string;
  conflictFiles: string[];
  /** False means git could not prove that an interrupted conflict was fully aborted. */
  checkoutRestored: boolean;
}

export interface IntegrationRollbackRequest {
  root: string;
  worktreePath: string;
  integrationBranch: string;
  expectedHead: string;
  checkpointSha: string;
  approvalId: string;
  gitBin?: string;
}

export interface IntegrationRollbackResult {
  headBefore: string;
  headAfter: string;
  checkpointSha: string;
  approvalId: string;
  reflogHead: string;
  reflogSubject: string;
}

export interface AcceptanceCommandRequest {
  runId: string;
  approvalId: string;
  cwd: string;
  mainRoot: string;
  approvedRoots: string[];
  /** Direct process argv. It is never parsed by a shell. */
  argv: string[];
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface AcceptanceCommandResult {
  runId: string;
  status: "completed" | "timed_out" | "cancelled";
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export function applyIntegration(
  request: IntegrationApplyRequest,
): Promise<IntegrationApplyResult> {
  return invoke<IntegrationApplyResult>("integration_apply", { request });
}

export function rollbackIntegration(
  request: IntegrationRollbackRequest,
): Promise<IntegrationRollbackResult> {
  return invoke<IntegrationRollbackResult>("integration_rollback", { request });
}

export function runAcceptanceCommand(
  request: AcceptanceCommandRequest,
): Promise<AcceptanceCommandResult> {
  return invoke<AcceptanceCommandResult>("acceptance_command_run", {
    request: { ...request, env: request.env ?? {} },
  });
}

export function cancelAcceptanceCommand(runId: string): Promise<boolean> {
  return invoke<boolean>("acceptance_command_cancel", { runId });
}
