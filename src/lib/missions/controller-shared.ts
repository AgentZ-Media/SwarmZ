import { invoke } from "@tauri-apps/api/core";
import { persistenceIssues } from "@/lib/persistence/coordinator";
import type { ActiveLease } from "@/lib/scheduler/types";
import { useSwarm } from "@/store";
import { useVibe } from "@/lib/vibe/session-store";
import { flushMissionsPersist, useMissions } from "./store";
import { useMissionOutbox } from "./outbox-store";
import type { MissionOutboxRecord } from "./outbox";
import { deriveApprovedMissionScope, type ApprovedMissionScope } from "./controller-core";
import { useRuntimeEnvironments } from "@/lib/runtime/store";
import type { TaskAttempt } from "./types";
export { safeId } from "./ids";

export interface MissionGitEvidence {
  base_sha: string;
  head_sha: string;
  diff_sha256: string;
  files_changed: string[];
  dirty: boolean;
  branch: string | null;
  base_is_ancestor: boolean;
}

export function missionPersistenceReady(): boolean {
  const missions = useMissions.getState();
  const outbox = useMissionOutbox.getState();
  return missions.hydrateStatus === "ready" &&
    missions.hydrated &&
    outbox.hydrateStatus === "ready" &&
    outbox.snapshot.hydration === "ready" &&
    useVibe.getState().hydrateStatus === "ready" &&
    useRuntimeEnvironments.getState().hydrated &&
    !persistenceIssues().some((issue) =>
      issue.name === "missions" || issue.name === "missionOutbox" ||
      issue.name === "vibeSessions" || issue.name === "runtimeEnvironments",
    );
}

export async function flushMissionOrThrow(): Promise<void> {
  await flushMissionsPersist();
  const issue = persistenceIssues().find((value) => value.name === "missions");
  if (issue) throw new Error("Mission event log is not durable");
}

export function approvedScopes(): ApprovedMissionScope[] {
  const state = useMissions.getState();
  return Object.values(state.projection.missions)
    .filter((mission) => mission.status === "active")
    .map((mission) => deriveApprovedMissionScope(state.events, mission.id))
    .filter((scope): scope is ApprovedMissionScope => !!scope)
    .sort((left, right) => left.approvedAt - right.approvedAt || left.missionId.localeCompare(right.missionId));
}

export function spawnRecordForAttempt(attemptId: string): MissionOutboxRecord | null {
  return Object.values(useMissionOutbox.getState().snapshot.records).find((record) =>
    record.command.kind === "spawn" && record.command.payload.attemptId === attemptId,
  ) ?? null;
}

export function activeLease(attempt: TaskAttempt): ActiveLease | null {
  if (attempt.status !== "running" || !attempt.sessionId) return null;
  const entry = useVibe.getState().sessions[attempt.sessionId];
  const task = useMissions.getState().projection.tasks[attempt.taskId];
  if (!task) return null;
  const spawn = spawnRecordForAttempt(attempt.id);
  const cwd = entry?.session.projectDir ??
    (spawn?.command.kind === "spawn" ? spawn.command.payload.cwd : task.root.path);
  return {
    taskId: task.id,
    attemptId: attempt.id,
    missionId: task.missionId,
    projectId: task.root.projectId,
    backendId: attempt.sessionId,
    rootPath: task.root.path,
    worktreePath: cwd === task.root.path ? null : cwd,
    acquiredAt: attempt.startedAt ?? 0,
    declaredFiles: task.declaredFiles,
    declaredGlobs: task.declaredGlobs,
    resourceKeys: [],
  };
}

export function tokenCount(sessionId: string | null): number {
  if (!sessionId) return 0;
  const total = useVibe.getState().sessions[sessionId]?.tokenUsage?.total;
  return tokenCountFromBucket(total);
}

/** Parse the real app-server camelCase shape while tolerating persisted v1 snake_case. */
export function tokenCountFromBucket(
  total: Record<string, number> | null | undefined,
): number {
  if (!total) return 0;
  for (const key of ["totalTokens", "total_tokens"] as const) {
    const explicit = total[key];
    if (typeof explicit === "number" && Number.isFinite(explicit)) {
      return Math.max(0, explicit);
    }
  }
  const value = (...keys: string[]) => {
    const found = keys.map((key) => total[key]).find((item) =>
      typeof item === "number" && Number.isFinite(item),
    );
    return typeof found === "number" ? Math.max(0, found) : 0;
  };
  // cachedInputTokens is already part of inputTokens on the Codex wire and
  // must not be added a second time.
  return value("inputTokens", "input_tokens") + value("outputTokens", "output_tokens");
}

export function missionUsage(scope: ApprovedMissionScope, now: number) {
  const projection = useMissions.getState().projection;
  const attempts = Object.values(projection.attempts).filter((attempt) =>
    attempt.missionId === scope.missionId && scope.tasks[attempt.taskId],
  );
  const historicalTokens = Object.values(projection.artifacts)
    .filter((artifact) => artifact.missionId === scope.missionId && artifact.label === "mission-usage")
    .reduce((sum, artifact) => sum +
      (typeof artifact.metadata.tokens === "number" ? Math.max(0, artifact.metadata.tokens) : 0), 0);
  const active = attempts.filter((attempt) => attempt.status === "running");
  return {
    tasksStarted: new Set(attempts.map((attempt) => attempt.taskId)).size,
    attemptsStarted: attempts.length,
    tokensUsed: historicalTokens + active.reduce((sum, attempt) => sum + tokenCount(attempt.sessionId), 0),
    activeMs: attempts.reduce((sum, attempt) =>
      sum + Math.max(0, (attempt.finishedAt ?? now) - (attempt.startedAt ?? now)), 0),
    // SwarmZ has no trustworthy price feed. A configured cost cap therefore
    // pauses starts fail-closed instead of pretending unknown cost is zero.
    costUsd: scope.mission.budget.maxCostUsd === null ? 0 : Number.NaN,
    activeAttempts: active.length,
  };
}

export async function gitEvidence(cwd: string, baseSha: string | null): Promise<MissionGitEvidence> {
  return invoke<MissionGitEvidence>("mission_git_evidence", {
    cwd,
    baseSha,
    bin: useSwarm.getState().settings.gitPath?.trim() || null,
  });
}
