import type { MissionOutboxRecord } from "./outbox";
import type { MissionProjection, TaskAttempt } from "./types";
import { safeId } from "./ids";

export interface MissionRecoverySession {
  id: string;
  projectId: string;
  projectDir: string;
  spawnedBy: "user" | "conductor" | "mission";
  access: "workspace" | "full";
  worktree: { root: string; branch: string; shared: boolean } | null;
}

function expectedSessionId(record: MissionOutboxRecord): string | null {
  return record.command.kind === "spawn"
    ? (record.command.payload.sessionId ?? safeId(record.command.payload.attemptId, "ms"))
    : null;
}

/**
 * A persisted Mission session is reusable only when every security-relevant
 * field still agrees with the durable spawn declaration. A matching id alone
 * is insufficient after a crash or a corrupted/tampered local store.
 */
export function sessionMatchesSpawn(
  session: MissionRecoverySession,
  record: MissionOutboxRecord,
): boolean {
  if (record.command.kind !== "spawn") return false;
  const payload = record.command.payload;
  const worktreeMatches = payload.root && payload.branch
    ? session.worktree?.root === payload.root &&
      session.worktree.branch === payload.branch &&
      session.worktree.shared === false
    : session.worktree === null;
  return session.id === expectedSessionId(record) &&
    session.spawnedBy === "mission" &&
    session.access === "workspace" &&
    session.projectId === payload.projectId &&
    session.projectDir === payload.cwd &&
    worktreeMatches;
}

/** Fail-closed validation before a replayed spawn may touch Git or Codex. */
export function spawnProjectionIssue(
  projection: MissionProjection,
  record: MissionOutboxRecord,
): string | null {
  if (record.command.kind !== "spawn") return "outbox record is not a spawn command";
  const payload = record.command.payload;
  const mission = projection.missions[record.missionId];
  const task = projection.tasks[payload.taskId];
  const attempt = projection.attempts[payload.attemptId];
  if (!mission || mission.status !== "active") {
    return "spawn Mission is missing or no longer active";
  }
  if (!task || task.missionId !== record.missionId || task.root.projectId !== payload.projectId) {
    return "spawn task no longer matches its durable Mission/project";
  }
  if (!attempt || attempt.missionId !== record.missionId ||
    attempt.taskId !== payload.taskId || attempt.status !== "running") {
    return "spawn attempt is missing, terminal, or belongs to another task";
  }
  if (attempt.sessionId !== expectedSessionId(record)) {
    return "spawn session id no longer matches its durable attempt";
  }
  return null;
}

/** Explain when a running attempt can no longer be recovered safely. */
export function runningAttemptRecoveryIssue(
  attempt: TaskAttempt,
  records: readonly MissionOutboxRecord[],
  sessions: Readonly<Record<string, MissionRecoverySession>>,
): string | null {
  const spawn = records.find((record) =>
    record.command.kind === "spawn" && record.command.payload.attemptId === attempt.id,
  );
  if (!spawn || spawn.status === "dead_letter") {
    return "Recovered running attempt has no deliverable spawn command";
  }
  if (!attempt.sessionId || attempt.sessionId !== expectedSessionId(spawn)) {
    return "Recovered running attempt disagrees with its durable spawn session";
  }
  if (spawn.status !== "delivered") return null;
  const session = sessions[attempt.sessionId];
  if (!session) return "Recovered delivered spawn has no persisted Mission session";
  if (!sessionMatchesSpawn(session, spawn)) {
    return "Recovered Mission session disagrees with its durable spawn command";
  }
  return null;
}

/**
 * Find only sessions that SwarmZ itself marked as Mission-owned. Human and
 * Conductor lanes are never cleanup candidates, even if their ids collide.
 */
export function orphanMissionSessionIds(
  projection: MissionProjection,
  records: readonly MissionOutboxRecord[],
  sessions: readonly MissionRecoverySession[],
): string[] {
  return sessions
    .filter((session) => session.spawnedBy === "mission")
    .filter((session) => !records.some((record) => {
      if (record.command.kind !== "spawn" || record.status === "dead_letter") return false;
      const attempt = projection.attempts[record.command.payload.attemptId];
      return attempt?.status === "running" &&
        attempt.missionId === record.missionId &&
        attempt.taskId === record.command.payload.taskId &&
        attempt.sessionId === session.id &&
        sessionMatchesSpawn(session, record);
    }))
    .map((session) => session.id)
    .sort((left, right) => left.localeCompare(right));
}
