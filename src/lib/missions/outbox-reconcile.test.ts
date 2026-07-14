import { describe, expect, it } from "vitest";
import { emptyMissionProjection } from "./core";
import {
  claimNextMissionCommand,
  deliverMissionCommand,
  emptyMissionOutbox,
  enqueueMissionCommand,
  type EnqueueMissionCommand,
  type MissionOutboxSnapshot,
} from "./outbox";
import { reconcileMissionStartup } from "./outbox-reconcile";
import type { MissionProjection, TaskAttempt } from "./types";

const NOW = 100_000;

function attempt(id: string, sessionId: string | null = null): TaskAttempt {
  return {
    id,
    missionId: "mission",
    taskId: `task-${id}`,
    ordinal: 1,
    status: "running",
    sessionId,
    workerLabel: null,
    startedAt: 1,
    finishedAt: null,
    summary: null,
    error: null,
    report: null,
    artifactIds: [],
  };
}

function spawn(id = "a1"): EnqueueMissionCommand {
  return {
    missionId: "mission",
    idempotencyKey: `spawn:${id}`,
    kind: "spawn",
    payload: {
      taskId: `task-${id}`,
      attemptId: id,
      projectId: "project",
      cwd: "/repo",
      prompt: "Implement",
    },
  };
}

function settle(id = "a1"): EnqueueMissionCommand {
  return {
    missionId: "mission",
    idempotencyKey: `settle:${id}`,
    kind: "settle",
    payload: {
      taskId: `task-${id}`,
      attemptId: id,
      status: "succeeded",
      completionId: `completion-${id}`,
    },
  };
}

function queued(command: EnqueueMissionCommand, recordId = "record-1"): MissionOutboxSnapshot {
  return enqueueMissionCommand(emptyMissionOutbox(), command, recordId, NOW).snapshot;
}

function delivered(
  command: EnqueueMissionCommand,
  receipt: Record<string, unknown>,
  recordId = "record-1",
): MissionOutboxSnapshot {
  const initial = queued(command, recordId);
  const claimed = claimNextMissionCommand(initial, "worker", `claim-${recordId}`, NOW, 1_000).snapshot;
  return deliverMissionCommand(claimed, recordId, `claim-${recordId}`, receipt, NOW + 1).snapshot;
}

function projection(...attempts: TaskAttempt[]): MissionProjection {
  const state = emptyMissionProjection();
  state.attempts = Object.fromEntries(attempts.map((value) => [value.id, value]));
  return state;
}

describe("mission startup reconciliation", () => {
  it("blocks all dispatch when outbox persistence is unknown", () => {
    const plan = reconcileMissionStartup({ outbox: emptyMissionOutbox("unknown"), projection: projection(), liveSessions: [], now: NOW });
    expect(plan.dispatchAllowed).toBe(false);
    expect(plan.actions).toEqual([expect.objectContaining({ kind: "persistence_blocked" })]);
  });

  it("recovers an expired pre-dispatch claim after restart", () => {
    const claimed = claimNextMissionCommand(queued(spawn()), "worker", "claim-old", NOW, 1_000).snapshot;
    const plan = reconcileMissionStartup({ outbox: claimed, projection: projection(), liveSessions: [], now: NOW + 1_001 });
    expect(plan.snapshot.records["record-1"].status).toBe("failed");
    expect(plan.actions).toContainEqual(expect.objectContaining({ kind: "claim_recovered", recordId: "record-1" }));
  });

  it("adopts external success from the dispatch-before-ack crash window", () => {
    const claimed = claimNextMissionCommand(queued(spawn()), "worker", "claim-old", NOW, 5_000).snapshot;
    const plan = reconcileMissionStartup({
      outbox: claimed,
      projection: projection(),
      liveSessions: [],
      receipts: [{ idempotencyKey: "spawn:a1", deliveredAt: NOW + 1, receipt: { sessionId: "session-1" } }],
      now: NOW + 2,
    });
    expect(plan.snapshot.records["record-1"].status).toBe("delivered");
    expect(plan.actions.map((action) => action.kind)).toContain("receipt_adopted");
    expect(plan.actions.map((action) => action.kind)).toContain("apply_delivered_completion");
  });

  it("replays the missing Mission event after durable external settlement", () => {
    const running = attempt("a1");
    const plan = reconcileMissionStartup({ outbox: delivered(settle(), { completionId: "completion-a1" }), projection: projection(running), liveSessions: [], now: NOW + 2 });
    expect(plan.actions.filter((action) => action.kind === "apply_delivered_completion")).toHaveLength(1);
    expect(plan.actions.some((action) => action.kind === "settle_orphan_attempt")).toBe(false);
  });

  it("protects duplicate completion when the terminal Mission event already exists", () => {
    const done = { ...attempt("a1"), status: "succeeded" as const, finishedAt: NOW };
    const plan = reconcileMissionStartup({ outbox: delivered(settle(), { completionId: "completion-a1" }), projection: projection(done), liveSessions: [], now: NOW + 2 });
    expect(plan.actions.some((action) => action.kind === "apply_delivered_completion")).toBe(false);
  });

  it("settles running attempts whose session vanished and no spawn is replayable", () => {
    const plan = reconcileMissionStartup({ outbox: emptyMissionOutbox(), projection: projection(attempt("a1", "missing-session")), liveSessions: [], now: NOW });
    expect(plan.actions).toContainEqual(expect.objectContaining({ kind: "settle_orphan_attempt", attemptId: "a1" }));
  });

  it("does not settle an orphan while its durable spawn can replay", () => {
    const plan = reconcileMissionStartup({ outbox: queued(spawn()), projection: projection(attempt("a1")), liveSessions: [], now: NOW });
    expect(plan.actions.some((action) => action.kind === "settle_orphan_attempt")).toBe(false);
  });

  it("closes unknown, terminal and mismatched live sessions", () => {
    const terminal = { ...attempt("done", "session-done"), status: "succeeded" as const, finishedAt: NOW };
    const running = attempt("run", "session-correct");
    const plan = reconcileMissionStartup({
      outbox: emptyMissionOutbox(),
      projection: projection(terminal, running),
      liveSessions: [
        { sessionId: "session-unknown", attemptId: "unknown", taskId: null, status: "active" },
        { sessionId: "session-done", attemptId: "done", taskId: terminal.taskId, status: "idle" },
        { sessionId: "session-wrong", attemptId: "run", taskId: running.taskId, status: "active" },
        { sessionId: "session-correct", attemptId: "run", taskId: running.taskId, status: "active" },
      ],
      now: NOW,
    });
    const closed = plan.actions.filter((action) => action.kind === "close_orphan_session").map((action) => action.sessionId);
    expect(closed).toEqual(["session-done", "session-unknown", "session-wrong"]);
  });

  it("keeps a newly spawned live session while its projection event is pending", () => {
    const running = attempt("a1");
    const plan = reconcileMissionStartup({
      outbox: delivered(spawn(), { sessionId: "session-new" }),
      projection: projection(running),
      liveSessions: [{ sessionId: "session-new", attemptId: "a1", taskId: running.taskId, status: "active" }],
      now: NOW + 2,
    });
    expect(plan.actions.some((action) => action.kind === "apply_delivered_completion")).toBe(true);
    expect(plan.actions.some((action) => action.kind === "close_orphan_session")).toBe(false);
  });

  it("produces deterministic reconciliation for 50 orphan attempts", () => {
    const attempts = Array.from({ length: 50 }, (_, index) => attempt(`a${index}`, `missing-${index}`));
    const first = reconcileMissionStartup({ outbox: emptyMissionOutbox(), projection: projection(...attempts), liveSessions: [], now: NOW });
    const second = reconcileMissionStartup({ outbox: emptyMissionOutbox(), projection: projection(...attempts.reverse()), liveSessions: [], now: NOW });
    expect(first.actions).toHaveLength(50);
    expect(second.actions).toEqual(first.actions);
  });
});
