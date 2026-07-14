import type { CandidateBatch, MissionArtifact, MissionProjection, TaskAttempt } from "./types";

export const MAX_CANDIDATE_ATTEMPTS = 8;
export const MAX_EVIDENCE_PER_CANDIDATE = 64;

export type CandidateEvidenceStatus = "passed" | "failed" | "missing";

export interface CandidateEvidence {
  id: string;
  label: string;
  kind: "quality_gate" | "test" | "review" | "benchmark" | "custom";
  status: CandidateEvidenceStatus;
  required: boolean;
  /** Explicit policy weight, 1..100. */
  weight: number;
  artifactId: string | null;
}

export interface CandidateAttempt {
  attemptId: string;
  taskId: string;
  terminalStatus: "succeeded" | "failed" | "blocked" | "cancelled";
  evidence: CandidateEvidence[];
  tokensUsed: number | null;
  durationMs: number | null;
}

export interface CandidateSelectionPolicy {
  minimumEvidenceCount: number;
  /** Required score lead. A smaller lead is explicitly indeterminate. */
  minimumScoreMargin: number;
  tieBreakers: Array<"lower_tokens" | "lower_duration" | "attempt_id">;
}

export interface CandidateAssessment {
  attemptId: string;
  eligible: boolean;
  score: number;
  passedEvidence: number;
  blockers: string[];
}

export interface CandidateSelection {
  taskId: string;
  selectedAttemptId: string | null;
  decision: "selected" | "indeterminate" | "no_eligible_candidate";
  assessments: CandidateAssessment[];
  explanation: string;
}

export class CandidateSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateSelectionError";
  }
}

function artifactEvidence(artifact: MissionArtifact): CandidateEvidence | null {
  // Candidate ranking consumes controller-observed evidence only. Agent
  // reports and arbitrary artifact labels are presentation data, not authority.
  if (artifact.metadata.authority !== "swarmz_native") return null;
  const evidenceKind = typeof artifact.metadata.evidenceKind === "string"
    ? artifact.metadata.evidenceKind
    : null;
  const weights: Partial<Record<MissionArtifact["kind"], number>> = {
    commit: 50,
    test_result: 45,
    report: 25,
    diff: 20,
    pull_request: 15,
  };
  const weight = evidenceKind === "review" ? 40 : weights[artifact.kind];
  if (!weight) return null;
  const rawStatus = typeof artifact.metadata.status === "string"
    ? artifact.metadata.status.toLowerCase()
    : null;
  const exitCode = typeof artifact.metadata.exitCode === "number"
    ? artifact.metadata.exitCode
    : typeof artifact.metadata.exit_code === "number" ? artifact.metadata.exit_code : null;
  const status: CandidateEvidenceStatus = artifact.kind === "commit" || artifact.kind === "diff" || artifact.kind === "pull_request"
    ? "passed"
    : rawStatus === "passed" || rawStatus === "success" || exitCode === 0
      ? "passed"
      : rawStatus === "failed" || rawStatus === "failure" || (exitCode !== null && exitCode !== 0)
        ? "failed"
        : "missing";
  return {
    id: artifact.id,
    label: artifact.label,
    kind: evidenceKind === "review" ? "review" : artifact.kind === "test_result" ? "test" : "custom",
    status,
    required: artifact.kind === "commit",
    weight,
    artifactId: status === "missing" ? null : artifact.id,
  };
}

/** Convert durable attempt artifacts into the selector's untrusted input. */
export function candidatesForBatch(
  projection: MissionProjection,
  batch: CandidateBatch,
): CandidateAttempt[] {
  return batch.attemptIds.map((attemptId) => {
    const attempt = projection.attempts[attemptId];
    if (!attempt || attempt.taskId !== batch.taskId) {
      throw new CandidateSelectionError(`candidate attempt ${attemptId} is missing`);
    }
    const evidence = Object.values(projection.artifacts)
      .filter((artifact) => artifact.attemptId === attempt.id && artifact.taskId === batch.taskId)
      .map(artifactEvidence)
      .filter((item): item is CandidateEvidence => !!item);
    if (!evidence.some((item) => item.required)) {
      evidence.unshift({
        id: `missing-commit-${attempt.id}`,
        label: "Verified attempt commit",
        kind: "custom",
        status: "missing",
        required: true,
        weight: 50,
        artifactId: null,
      });
    }
    const usage = Object.values(projection.artifacts).find((artifact) =>
      artifact.attemptId === attempt.id && artifact.label === "mission-usage" &&
      artifact.metadata.authority === "swarmz_native");
    return {
      attemptId: attempt.id,
      taskId: batch.taskId,
      terminalStatus: terminalCandidateStatus(attempt),
      evidence,
      tokensUsed: typeof usage?.metadata.tokens === "number" ? Math.max(0, Math.floor(usage.metadata.tokens)) : null,
      durationMs: attempt.startedAt !== null && attempt.finishedAt !== null
        ? Math.max(0, attempt.finishedAt - attempt.startedAt)
        : null,
    };
  });
}

function terminalCandidateStatus(attempt: TaskAttempt): CandidateAttempt["terminalStatus"] {
  if (attempt.status === "succeeded" || attempt.status === "failed" || attempt.status === "blocked" || attempt.status === "cancelled") {
    return attempt.status;
  }
  return "blocked";
}

function validateCandidate(candidate: CandidateAttempt): void {
  if (!candidate || typeof candidate !== "object") throw new CandidateSelectionError("candidate is invalid");
  if (typeof candidate.attemptId !== "string" || !candidate.attemptId.trim() || candidate.attemptId.length > 120) throw new CandidateSelectionError("candidate attempt id is invalid");
  if (typeof candidate.taskId !== "string" || !candidate.taskId.trim() || candidate.taskId.length > 120) throw new CandidateSelectionError("candidate task id is invalid");
  if (!(["succeeded", "failed", "blocked", "cancelled"] as unknown[]).includes(candidate.terminalStatus)) {
    throw new CandidateSelectionError(`candidate ${candidate.attemptId} has an invalid terminal status`);
  }
  if (!Array.isArray(candidate.evidence)) throw new CandidateSelectionError(`candidate ${candidate.attemptId} evidence must be an array`);
  if (candidate.evidence.length > MAX_EVIDENCE_PER_CANDIDATE) throw new CandidateSelectionError(`candidate evidence exceeds ${MAX_EVIDENCE_PER_CANDIDATE}`);
  const ids = new Set<string>();
  for (const evidence of candidate.evidence) {
    if (!evidence || typeof evidence !== "object") throw new CandidateSelectionError(`candidate ${candidate.attemptId} has invalid evidence`);
    if (typeof evidence.id !== "string" || !evidence.id.trim() || evidence.id.length > 120 || ids.has(evidence.id)) throw new CandidateSelectionError(`candidate ${candidate.attemptId} has invalid evidence ids`);
    ids.add(evidence.id);
    if (typeof evidence.label !== "string" || !evidence.label.trim() || evidence.label.length > 300) throw new CandidateSelectionError(`candidate ${candidate.attemptId} has invalid evidence label`);
    if (!(["quality_gate", "test", "review", "benchmark", "custom"] as unknown[]).includes(evidence.kind)) throw new CandidateSelectionError(`evidence ${evidence.id} has invalid kind`);
    if (!(["passed", "failed", "missing"] as unknown[]).includes(evidence.status)) throw new CandidateSelectionError(`evidence ${evidence.id} has invalid status`);
    if (typeof evidence.required !== "boolean") throw new CandidateSelectionError(`evidence ${evidence.id} has invalid required flag`);
    if (!Number.isInteger(evidence.weight) || evidence.weight < 1 || evidence.weight > 100) throw new CandidateSelectionError(`evidence ${evidence.id} has invalid weight`);
    if (evidence.status !== "missing" && !evidence.artifactId) {
      throw new CandidateSelectionError(`observed evidence ${evidence.id} needs an artifact id`);
    }
    if (evidence.artifactId !== null && (typeof evidence.artifactId !== "string" || !evidence.artifactId.trim() || evidence.artifactId.length > 240)) {
      throw new CandidateSelectionError(`evidence ${evidence.id} has invalid artifact id`);
    }
  }
  for (const [label, value] of [["tokensUsed", candidate.tokensUsed], ["durationMs", candidate.durationMs]] as const) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new CandidateSelectionError(`${label} is invalid`);
  }
}

function assess(candidate: CandidateAttempt, policy: CandidateSelectionPolicy): CandidateAssessment {
  const blockers: string[] = [];
  if (candidate.terminalStatus !== "succeeded") blockers.push(`attempt is ${candidate.terminalStatus}`);
  const observedEvidence = candidate.evidence.filter(
    (evidence) => evidence.status !== "missing",
  ).length;
  if (observedEvidence < policy.minimumEvidenceCount) {
    blockers.push(`fewer than ${policy.minimumEvidenceCount} observed evidence records`);
  }
  for (const evidence of candidate.evidence) {
    if (evidence.required && evidence.status !== "passed") blockers.push(`${evidence.label} is ${evidence.status}`);
  }
  const score = candidate.evidence.reduce((sum, evidence) => {
    if (evidence.status === "passed") return sum + evidence.weight;
    if (evidence.status === "failed") return sum - evidence.weight;
    return sum;
  }, 0);
  return {
    attemptId: candidate.attemptId,
    eligible: blockers.length === 0,
    score,
    passedEvidence: candidate.evidence.filter((evidence) => evidence.status === "passed").length,
    blockers,
  };
}

function compareWithPolicy(
  left: CandidateAssessment,
  right: CandidateAssessment,
  candidates: ReadonlyMap<string, CandidateAttempt>,
  policy: CandidateSelectionPolicy,
): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.passedEvidence !== right.passedEvidence) return right.passedEvidence - left.passedEvidence;
  const leftCandidate = candidates.get(left.attemptId)!;
  const rightCandidate = candidates.get(right.attemptId)!;
  for (const tieBreaker of policy.tieBreakers) {
    if (tieBreaker === "lower_tokens") {
      const leftValue = leftCandidate.tokensUsed ?? Number.MAX_SAFE_INTEGER;
      const rightValue = rightCandidate.tokensUsed ?? Number.MAX_SAFE_INTEGER;
      if (leftValue !== rightValue) return leftValue - rightValue;
    } else if (tieBreaker === "lower_duration") {
      const leftValue = leftCandidate.durationMs ?? Number.MAX_SAFE_INTEGER;
      const rightValue = rightCandidate.durationMs ?? Number.MAX_SAFE_INTEGER;
      if (leftValue !== rightValue) return leftValue - rightValue;
    } else {
      const compared = left.attemptId.localeCompare(right.attemptId);
      if (compared !== 0) return compared;
    }
  }
  return left.attemptId.localeCompare(right.attemptId);
}

/** Select among A/B(/N) attempts using only explicit, artifact-backed evidence. */
export function selectCandidateAttempt(
  candidates: readonly CandidateAttempt[],
  policy: CandidateSelectionPolicy,
): CandidateSelection {
  if (!Array.isArray(candidates)) throw new CandidateSelectionError("candidates must be an array");
  if (candidates.length < 2 || candidates.length > MAX_CANDIDATE_ATTEMPTS) {
    throw new CandidateSelectionError(`candidate selection needs 2..${MAX_CANDIDATE_ATTEMPTS} attempts`);
  }
  if (!policy || typeof policy !== "object") throw new CandidateSelectionError("candidate policy is invalid");
  if (!Number.isInteger(policy.minimumEvidenceCount) || policy.minimumEvidenceCount < 1 || policy.minimumEvidenceCount > MAX_EVIDENCE_PER_CANDIDATE) {
    throw new CandidateSelectionError("minimumEvidenceCount is invalid");
  }
  if (!Number.isFinite(policy.minimumScoreMargin) || policy.minimumScoreMargin < 0 || policy.minimumScoreMargin > 10_000) {
    throw new CandidateSelectionError("minimumScoreMargin is invalid");
  }
  if (!Array.isArray(policy.tieBreakers) || policy.tieBreakers.some((item) => !(["lower_tokens", "lower_duration", "attempt_id"] as unknown[]).includes(item))) {
    throw new CandidateSelectionError("tie breakers are invalid");
  }
  if (new Set(policy.tieBreakers).size !== policy.tieBreakers.length) throw new CandidateSelectionError("tie breakers must be unique");
  validateCandidate(candidates[0]);
  const taskId = candidates[0].taskId;
  const byId = new Map<string, CandidateAttempt>();
  for (const candidate of candidates) {
    validateCandidate(candidate);
    if (candidate.taskId !== taskId) throw new CandidateSelectionError("all candidates must belong to one task");
    if (byId.has(candidate.attemptId)) throw new CandidateSelectionError(`duplicate candidate ${candidate.attemptId}`);
    byId.set(candidate.attemptId, candidate);
  }
  const assessments = candidates.map((candidate) => assess(candidate, policy));
  const eligible = assessments
    .filter((assessment) => assessment.eligible)
    .sort((a, b) => compareWithPolicy(a, b, byId, policy));
  if (eligible.length === 0) {
    return {
      taskId,
      selectedAttemptId: null,
      decision: "no_eligible_candidate",
      assessments,
      explanation: "No candidate has a successful terminal state and complete required evidence.",
    };
  }
  if (eligible.length > 1) {
    const margin = eligible[0].score - eligible[1].score;
    if (margin < policy.minimumScoreMargin) {
      return {
        taskId,
        selectedAttemptId: null,
        decision: "indeterminate",
        assessments,
        explanation: `The leading evidence score margin ${margin} is below the required ${policy.minimumScoreMargin}.`,
      };
    }
  }
  return {
    taskId,
    selectedAttemptId: eligible[0].attemptId,
    decision: "selected",
    assessments,
    explanation: `Selected ${eligible[0].attemptId} from artifact-backed evidence with score ${eligible[0].score}.`,
  };
}
