/** Human-approved, revisioned authority boundary for autonomous mission work. */

export type NetworkAuthority = "deny" | "read_only" | "allow";
export type GithubAuthority = "deny" | "read_only" | "write";
export type StopAction = "continue" | "pause_mission" | "needs_human" | "cancel_mission";

export interface MissionEnvelopeLimits {
  maxTasks: number;
  maxAttempts: number;
  maxTokens: number | null;
  maxActiveMs: number | null;
  maxCostUsd: number | null;
  maxParallel: number;
}

export interface MissionEnvelopeCapabilities {
  allowedTools: string[];
  allowedRoots: string[];
  network: NetworkAuthority;
  github: GithubAuthority;
}

export interface MissionStopPolicy {
  regression: StopAction;
  conflict: StopAction;
  criticalFailure: Exclude<StopAction, "continue">;
}

export interface EnvelopeApproval {
  approvalId: string;
  envelopeRevision: number;
  approvedAt: number;
  approvedBy: "human";
}

export interface MissionExecutionEnvelope {
  id: string;
  missionId: string;
  revision: number;
  issuedAt: number;
  expiresAt: number | null;
  limits: MissionEnvelopeLimits;
  capabilities: MissionEnvelopeCapabilities;
  stopPolicy: MissionStopPolicy;
  approval: EnvelopeApproval | null;
}

export interface MissionEnvelopeUsage {
  tasksStarted: number;
  attemptsStarted: number;
  tokensUsed: number;
  activeMs: number;
  costUsd: number;
  activeAttempts: number;
}

export interface EnvelopeStartRequest {
  missionId: string;
  envelopeRevision: number;
  rootPath: string;
  requiredTools?: readonly string[];
  network?: Exclude<NetworkAuthority, "deny">;
  github?: Exclude<GithubAuthority, "deny">;
  /** Retries consume attempt budget, but not another unique task slot. */
  isFirstTaskStart?: boolean;
  now: number;
  /** Existing persisted autonomy breaker is the final emergency stop. */
  breakerOpen: boolean;
  breakerReason?: string;
}

export type EnvelopeVerdict =
  | { ok: true }
  | {
      ok: false;
      code:
        | "invalid_envelope"
        | "approval_required"
        | "approval_revision_mismatch"
        | "expired"
        | "breaker_open"
        | "mission_mismatch"
        | "revision_mismatch"
        | "task_limit"
        | "attempt_limit"
        | "token_limit"
        | "time_limit"
        | "cost_limit"
        | "parallel_limit"
        | "root_denied"
        | "tool_denied"
        | "network_denied"
        | "github_denied";
      reason: string;
    };

const ID = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,199}$/;

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function inside(root: string, candidate: string): boolean {
  const normalizedRoot = root.replace(/\/+$/, "") || "/";
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

function safeAbsolutePath(value: string): boolean {
  return value.startsWith("/") &&
    value.length <= 8_192 &&
    !value.includes("\0") &&
    !value.split("/").some((part) => part === "." || part === "..");
}

export function validateMissionEnvelope(envelope: MissionExecutionEnvelope): string[] {
  const errors: string[] = [];
  if (!ID.test(envelope.id) || !ID.test(envelope.missionId)) errors.push("invalid envelope identity");
  if (!positiveInteger(envelope.revision)) errors.push("revision must be a positive integer");
  if (!finiteNonNegative(envelope.issuedAt)) errors.push("issuedAt is invalid");
  if (envelope.expiresAt !== null &&
    (!finiteNonNegative(envelope.expiresAt) || envelope.expiresAt <= envelope.issuedAt)) {
    errors.push("expiresAt must be after issuedAt");
  }
  const limits = envelope.limits;
  if (!positiveInteger(limits.maxTasks)) errors.push("maxTasks must be positive");
  if (!positiveInteger(limits.maxAttempts)) errors.push("maxAttempts must be positive");
  if (!positiveInteger(limits.maxParallel) || limits.maxParallel > 48) {
    errors.push("maxParallel must be 1..48");
  }
  if (limits.maxAttempts < limits.maxTasks) errors.push("maxAttempts cannot be below maxTasks");
  if (limits.maxTokens !== null && !positiveInteger(limits.maxTokens)) errors.push("maxTokens is invalid");
  if (limits.maxActiveMs !== null && !positiveInteger(limits.maxActiveMs)) errors.push("maxActiveMs is invalid");
  if (limits.maxCostUsd !== null && (!Number.isFinite(limits.maxCostUsd) || limits.maxCostUsd <= 0)) {
    errors.push("maxCostUsd is invalid");
  }
  if (envelope.capabilities.allowedTools.length > 100 ||
    envelope.capabilities.allowedTools.some((tool) => !ID.test(tool))) {
    errors.push("allowedTools is invalid");
  }
  if (envelope.capabilities.allowedRoots.length === 0 ||
    envelope.capabilities.allowedRoots.length > 32 ||
    envelope.capabilities.allowedRoots.some((root) => !safeAbsolutePath(root))) {
    errors.push("allowedRoots is invalid");
  }
  const approval = envelope.approval;
  if (approval &&
    (!ID.test(approval.approvalId) ||
      approval.approvedBy !== "human" ||
      approval.envelopeRevision !== envelope.revision ||
      !finiteNonNegative(approval.approvedAt) ||
      approval.approvedAt < envelope.issuedAt ||
      (envelope.expiresAt !== null && approval.approvedAt >= envelope.expiresAt))) {
    errors.push("approval is invalid for this revision");
  }
  return errors;
}

/** Any material revision invalidates prior human authority. */
export function reviseMissionEnvelope(
  envelope: MissionExecutionEnvelope,
  patch: Partial<
    Pick<
      MissionExecutionEnvelope,
      "expiresAt" | "limits" | "capabilities" | "stopPolicy"
    >
  >,
  issuedAt: number,
): MissionExecutionEnvelope {
  const revised: MissionExecutionEnvelope = {
    ...envelope,
    ...patch,
    revision: envelope.revision + 1,
    issuedAt,
    approval: null,
  };
  const errors = validateMissionEnvelope(revised);
  if (errors.length) throw new Error(errors.join("; "));
  return revised;
}

/** One approval command can authorize exactly one not-yet-approved revision. */
export function approveMissionEnvelope(
  envelope: MissionExecutionEnvelope,
  approval: EnvelopeApproval,
  usedApprovalIds: ReadonlySet<string> = new Set(),
): MissionExecutionEnvelope {
  if (envelope.approval) throw new Error("envelope revision is already approved");
  if (usedApprovalIds.has(approval.approvalId)) throw new Error("approval id was already used");
  if (approval.approvedBy !== "human") throw new Error("only a human can approve an envelope");
  if (approval.envelopeRevision !== envelope.revision) throw new Error("approval revision mismatch");
  const approved = { ...envelope, approval: { ...approval } };
  const errors = validateMissionEnvelope(approved);
  if (errors.length) throw new Error(errors.join("; "));
  return approved;
}

function invalidUsage(usage: MissionEnvelopeUsage): boolean {
  return !Number.isInteger(usage.tasksStarted) || usage.tasksStarted < 0 ||
    !Number.isInteger(usage.attemptsStarted) || usage.attemptsStarted < 0 ||
    !Number.isInteger(usage.tokensUsed) || usage.tokensUsed < 0 ||
    !finiteNonNegative(usage.activeMs) ||
    !finiteNonNegative(usage.costUsd) ||
    !Number.isInteger(usage.activeAttempts) || usage.activeAttempts < 0;
}

/** Fail-closed authorization for one additional fresh task attempt. */
export function authorizeEnvelopeStart(
  envelope: MissionExecutionEnvelope,
  usage: MissionEnvelopeUsage,
  request: EnvelopeStartRequest,
): EnvelopeVerdict {
  const errors = validateMissionEnvelope(envelope);
  if (errors.length || invalidUsage(usage)) {
    return {
      ok: false,
      code: "invalid_envelope",
      reason: [...errors, ...(invalidUsage(usage) ? ["usage is invalid"] : [])].join("; "),
    };
  }
  if (request.breakerOpen) {
    return { ok: false, code: "breaker_open", reason: request.breakerReason || "autonomy circuit breaker is open" };
  }
  if (request.missionId !== envelope.missionId) {
    return { ok: false, code: "mission_mismatch", reason: "request belongs to another mission" };
  }
  if (request.envelopeRevision !== envelope.revision) {
    return { ok: false, code: "revision_mismatch", reason: "runner holds a stale envelope revision" };
  }
  if (!envelope.approval) {
    return { ok: false, code: "approval_required", reason: "this envelope revision needs explicit human approval" };
  }
  if (envelope.approval.envelopeRevision !== envelope.revision) {
    return { ok: false, code: "approval_revision_mismatch", reason: "approval does not cover this revision" };
  }
  if (envelope.expiresAt !== null && request.now >= envelope.expiresAt) {
    return { ok: false, code: "expired", reason: "mission envelope expired" };
  }
  const limits = envelope.limits;
  if ((request.isFirstTaskStart ?? true) && usage.tasksStarted >= limits.maxTasks) {
    return { ok: false, code: "task_limit", reason: "unique task-start budget exhausted" };
  }
  if (usage.attemptsStarted >= limits.maxAttempts) return { ok: false, code: "attempt_limit", reason: "attempt budget exhausted" };
  if (limits.maxTokens !== null && usage.tokensUsed >= limits.maxTokens) return { ok: false, code: "token_limit", reason: "token budget exhausted" };
  if (limits.maxActiveMs !== null && usage.activeMs >= limits.maxActiveMs) return { ok: false, code: "time_limit", reason: "active-time budget exhausted" };
  if (limits.maxCostUsd !== null && usage.costUsd >= limits.maxCostUsd) return { ok: false, code: "cost_limit", reason: "cost budget exhausted" };
  if (usage.activeAttempts >= limits.maxParallel) return { ok: false, code: "parallel_limit", reason: "parallel attempt limit reached" };
  if (!safeAbsolutePath(request.rootPath) ||
    !envelope.capabilities.allowedRoots.some((root) => inside(root, request.rootPath))) {
    return { ok: false, code: "root_denied", reason: "task root is outside approved roots" };
  }
  const deniedTool = (request.requiredTools ?? []).find(
    (tool) => !envelope.capabilities.allowedTools.includes(tool),
  );
  if (deniedTool) return { ok: false, code: "tool_denied", reason: `tool is not approved: ${deniedTool}` };
  if (request.network && envelope.capabilities.network === "deny") {
    return { ok: false, code: "network_denied", reason: "network access is not approved" };
  }
  if (request.network === "allow" && envelope.capabilities.network !== "allow") {
    return { ok: false, code: "network_denied", reason: "network write access is not approved" };
  }
  if (request.github && envelope.capabilities.github === "deny") {
    return { ok: false, code: "github_denied", reason: "GitHub access is not approved" };
  }
  if (request.github === "write" && envelope.capabilities.github !== "write") {
    return { ok: false, code: "github_denied", reason: "GitHub writes are not approved" };
  }
  return { ok: true };
}

export interface MissionStopSignals {
  regression: boolean;
  conflict: boolean;
  criticalFailure: boolean;
}

export function envelopeStopAction(
  envelope: MissionExecutionEnvelope,
  signals: MissionStopSignals,
): StopAction {
  if (signals.criticalFailure) return envelope.stopPolicy.criticalFailure;
  if (signals.conflict) return envelope.stopPolicy.conflict;
  if (signals.regression) return envelope.stopPolicy.regression;
  return "continue";
}
