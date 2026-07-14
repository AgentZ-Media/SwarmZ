import { reviewSession } from "@/lib/vibe/controller";
import { useMissions } from "./store";
import type { MissionArtifact, MissionTask, TaskAttempt } from "./types";
import type { ApprovedMissionScope } from "./controller-core";
import { finalHeadEvidenceMatches } from "./controller-core";
import { parseApprovedArgv } from "@/lib/integration/controller-core";
import { runAcceptanceCommand } from "@/lib/integration/native";
import {
  flushMissionOrThrow,
  gitEvidence,
  safeId,
  spawnRecordForAttempt,
  tokenCount,
  type MissionGitEvidence,
} from "./controller-shared";

export function baseShaForAttempt(attemptId: string): { cwd: string; baseSha: string; branch: string | null } | null {
  const record = spawnRecordForAttempt(attemptId);
  if (!record || record.command.kind !== "spawn" || record.status !== "delivered") return null;
  const baseSha = record.delivery?.receipt.baseSha;
  return typeof baseSha === "string"
    ? { cwd: record.command.payload.cwd, baseSha, branch: record.command.payload.branch ?? null }
    : null;
}

export function turnIdForAttempt(attemptId: string): string | null {
  const record = spawnRecordForAttempt(attemptId);
  const turnId = record?.delivery?.receipt.turnId;
  return typeof turnId === "string" && turnId ? turnId : null;
}

export async function recordUsage(attempt: TaskAttempt): Promise<void> {
  const id = safeId(attempt.id, "usage");
  if (useMissions.getState().projection.artifacts[id]) return;
  useMissions.getState().recordArtifact(attempt.missionId, {
    id,
    taskId: attempt.taskId,
    attemptId: attempt.id,
    kind: "other",
    label: "mission-usage",
    uri: null,
    metadata: {
      authority: "swarmz_native",
      evidenceKind: "usage",
      tokens: tokenCount(attempt.sessionId),
      costUsd: null,
    },
  }, { actor: "system", idempotencyKey: `usage:${attempt.id}` });
  await flushMissionOrThrow();
}

export async function recordCommitEvidence(
  attempt: TaskAttempt,
  evidence: MissionGitEvidence,
): Promise<void> {
  const id = safeId(attempt.id, "commit");
  const existing = useMissions.getState().projection.artifacts[id];
  if (existing) {
    if (existing.metadata.commit !== evidence.head_sha ||
      existing.metadata.baseSha !== evidence.base_sha ||
      existing.metadata.diffSha256 !== evidence.diff_sha256 ||
      JSON.stringify(existing.metadata.filesChanged) !== JSON.stringify(evidence.files_changed)) {
      throw new Error("attempt commit evidence conflicts with the previously durable final HEAD");
    }
    return;
  }
  useMissions.getState().recordArtifact(attempt.missionId, {
    id,
    taskId: attempt.taskId,
    attemptId: attempt.id,
    kind: "commit",
    label: "Verified attempt commit",
    uri: `git:${evidence.head_sha}`,
    metadata: {
      authority: "swarmz_native",
      evidenceKind: "commit",
      commit: evidence.head_sha,
      finalHead: evidence.head_sha,
      baseSha: evidence.base_sha,
      diffSha256: evidence.diff_sha256,
      filesChanged: evidence.files_changed,
    },
  }, { actor: "system", idempotencyKey: `commit-evidence:${attempt.id}` });
  await flushMissionOrThrow();
}

export interface IndependentGateEvidence {
  commands: Record<string, number>;
  failed: string[];
}

export function exactAttemptArtifact(
  attemptId: string,
  label: string,
  finalHead: string,
): MissionArtifact | null {
  return Object.values(useMissions.getState().projection.artifacts).find((artifact) =>
    artifact.attemptId === attemptId &&
    artifact.label === label &&
    artifact.metadata.authority === "swarmz_native" &&
    artifact.metadata.finalHead === finalHead,
  ) ?? null;
}

export async function recordIndependentReview(
  attempt: TaskAttempt,
  task: MissionTask,
  evidence: MissionGitEvidence,
): Promise<string> {
  const label = "Independent final-HEAD review";
  const existing = exactAttemptArtifact(attempt.id, label, evidence.head_sha);
  if (existing) {
    if (existing.metadata.evidenceKind !== "review" ||
      existing.metadata.baseSha !== evidence.base_sha ||
      existing.metadata.diffSha256 !== evidence.diff_sha256) {
      throw new Error("independent review artifact conflicts with the durable final HEAD");
    }
    return existing.id;
  }
  let reviewStatus: "passed" | "failed" = "passed";
  let reviewDetail = "Independent clean/scope/ancestry verification passed";
  let reviewThreadId: string | null = null;
  if (attempt.candidateBatchId && attempt.sessionId) {
    try {
      const result = await reviewSession(attempt.sessionId, `commit:${evidence.head_sha}`, {
        requireWorkspace: true,
      });
      reviewThreadId = result.review_thread_id;
      const text = result.review?.slice(0, 4_000) ?? "Detached review returned no findings";
      const hasFinding = /\[P[0-3]\]/i.test(text) || /"findings"\s*:\s*\[\s*\{/i.test(text);
      reviewStatus = result.status === "completed" && !hasFinding ? "passed" : "failed";
      reviewDetail = result.status !== "completed"
        ? `Detached review ended as ${result.status}`
        : hasFinding
          ? "Detached review found actionable P0-P3 findings"
          : "Detached review completed without actionable P0-P3 findings";
    } catch (error) {
      reviewStatus = "failed";
      reviewDetail = error instanceof Error ? error.message : String(error);
    }
  }
  const id = safeId(`${attempt.id}:review:${evidence.head_sha}`, "review");
  useMissions.getState().recordArtifact(attempt.missionId, {
    id,
    taskId: task.id,
    attemptId: attempt.id,
    kind: "other",
    label,
    uri: null,
    metadata: {
      authority: "swarmz_native",
      evidenceKind: "review",
      status: reviewStatus,
      finalHead: evidence.head_sha,
      baseSha: evidence.base_sha,
      diffSha256: evidence.diff_sha256,
      filesChanged: evidence.files_changed,
      allowNoop: task.allowNoop === true,
      clean: !evidence.dirty,
      baseIsAncestor: evidence.base_is_ancestor,
      reviewThreadId,
      detail: reviewDetail,
    },
  }, { actor: "system", idempotencyKey: `review-evidence:${attempt.id}:${evidence.head_sha}` });
  await flushMissionOrThrow();
  return id;
}

/** Run every required command through the native argv-only acceptance runner.
 * Worker transcript command items are intentionally ignored as authority. */
export async function runIndependentGates(
  scope: ApprovedMissionScope,
  attempt: TaskAttempt,
  task: MissionTask,
  evidence: MissionGitEvidence,
  reviewArtifactId: string,
): Promise<IndependentGateEvidence> {
  const gates = task.qualityGateIds
    .map((gateId) => useMissions.getState().projection.qualityGates[gateId])
    .filter((gate) => gate?.required && gate.status !== "waived");
  const byCommand = new Map<string, typeof gates>();
  for (const gate of gates) {
    if (!gate.command?.trim()) continue;
    const command = gate.command.trim();
    byCommand.set(command, [...(byCommand.get(command) ?? []), gate]);
  }
  const commands: Record<string, number> = Object.create(null);
  const results: Array<{
    gateId: string;
    status: "passed" | "failed";
    details: string;
    artifactIds: string[];
  }> = [];
  const failed: string[] = [];

  for (const [command, commandGates] of byCommand) {
    const label = `Native acceptance · ${command.slice(0, 220)}`;
    let artifact = exactAttemptArtifact(attempt.id, label, evidence.head_sha);
    if (artifact && (artifact.metadata.evidenceKind !== "test" ||
      artifact.metadata.command !== command ||
      artifact.metadata.baseSha !== evidence.base_sha)) {
      throw new Error("native quality artifact conflicts with the approved command or final HEAD");
    }
    if (!artifact) {
      let status: "passed" | "failed" = "failed";
      let exitCode: number | null = null;
      let durationMs = 0;
      let detail = "native acceptance command failed before completion";
      try {
        const cwd = baseShaForAttempt(attempt.id)?.cwd ?? task.root.path;
        const before = await gitEvidence(cwd, evidence.base_sha);
        if (!finalHeadEvidenceMatches(evidence, before)) {
          throw new Error("final HEAD changed before native quality verification");
        }
        const argv = parseApprovedArgv(command);
        const result = await runAcceptanceCommand({
          runId: safeId(`${attempt.id}:${evidence.head_sha}:${command}`, "mission-gate"),
          approvalId: scope.approvalEventId,
          cwd,
          // The generated worktree itself is the native sandbox authority;
          // the quality process cannot touch the mutable main checkout.
          approvedRoots: [cwd],
          argv,
          timeoutMs: 15 * 60_000,
        });
        exitCode = result.exitCode;
        durationMs = result.durationMs;
        status = result.status === "completed" && result.exitCode === 0 ? "passed" : "failed";
        detail = result.status === "completed"
          ? `native argv exited ${result.exitCode ?? "without code"}`
          : `native argv ${result.status}`;
        const after = await gitEvidence(cwd, evidence.base_sha);
        if (!finalHeadEvidenceMatches(evidence, after)) {
          status = "failed";
          detail = "quality command changed the verified final HEAD or tracked diff";
        }
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
      }
      const id = safeId(`${attempt.id}:gate:${command}:${evidence.head_sha}`, "test");
      useMissions.getState().recordArtifact(attempt.missionId, {
        id,
        taskId: task.id,
        attemptId: attempt.id,
        kind: "test_result",
        label,
        uri: null,
        metadata: {
          authority: "swarmz_native",
          evidenceKind: "test",
          status,
          command,
          exitCode,
          durationMs,
          finalHead: evidence.head_sha,
          baseSha: evidence.base_sha,
          detail: detail.slice(0, 1_000),
        },
      }, { actor: "system", idempotencyKey: `gate-evidence:${attempt.id}:${evidence.head_sha}:${safeId(command, "cmd")}` });
      await flushMissionOrThrow();
      artifact = useMissions.getState().projection.artifacts[id] ?? null;
    }
    if (!artifact) throw new Error("native gate artifact was not persisted");
    const exitCode = typeof artifact.metadata.exitCode === "number" ? artifact.metadata.exitCode : 1;
    const passed = artifact.metadata.status === "passed" && exitCode === 0;
    commands[command] = exitCode;
    if (!passed) failed.push(command);
    for (const gate of commandGates) {
      results.push({
        gateId: gate.id,
        status: passed ? "passed" : "failed",
        details: `${passed ? "Passed" : "Failed"} natively at ${evidence.head_sha.slice(0, 12)} · ${String(artifact.metadata.detail ?? "direct argv")}`,
        artifactIds: [artifact.id],
      });
    }
  }
  for (const gate of gates.filter((candidate) => !candidate.command?.trim())) {
    results.push({
      gateId: gate.id,
      status: "passed",
      details: `Independent clean/scope/ancestry review at ${evidence.head_sha.slice(0, 12)}`,
      artifactIds: [reviewArtifactId],
    });
  }
  const changedResults = results.filter((result) => {
    const gate = useMissions.getState().projection.qualityGates[result.gateId];
    return gate?.status !== result.status ||
      gate.details !== result.details ||
      gate.artifactIds.join("\u001f") !== result.artifactIds.join("\u001f");
  });
  if (changedResults.length) {
    useMissions.getState().settleQualityGates(task.missionId, changedResults, {
      actor: "system",
      idempotencyKey: `gate-results:${attempt.id}:${evidence.head_sha}`,
    });
    await flushMissionOrThrow();
  }
  return { commands, failed };
}
