import { describe, expect, it } from "vitest";
import { runMissionControllerCycle } from "./controller-cycle";

describe("runMissionControllerCycle", () => {
  it("keeps recovery and settlement ahead of fresh admission", async () => {
    const calls: string[] = [];
    const attempts = [
      { id: "done", status: "succeeded" },
      { id: "active", status: "running" },
    ] as const;

    await runMissionControllerCycle({
      pauseRuntimeDrift: async () => { calls.push("runtime-drift"); },
      enforceStops: async () => { calls.push("stops"); },
      recover: async () => { calls.push("recovery"); },
      attempts: () => attempts,
      isRunning: (attempt) => attempt.status === "running",
      settle: async (attempt) => { calls.push(`settle:${attempt.id}`); },
      admit: async () => { calls.push("admit"); },
    });

    expect(calls).toEqual([
      "runtime-drift",
      "stops",
      "recovery",
      "settle:active",
      "admit",
    ]);
  });

  it("reads attempts after recovery so reconciled state is authoritative", async () => {
    const calls: string[] = [];
    let attempts = [{ id: "stale", status: "running" }];

    await runMissionControllerCycle({
      pauseRuntimeDrift: async () => undefined,
      enforceStops: async () => undefined,
      recover: async () => {
        attempts = [{ id: "recovered", status: "running" }];
      },
      attempts: () => attempts,
      isRunning: (attempt) => attempt.status === "running",
      settle: async (attempt) => { calls.push(attempt.id); },
      admit: async () => undefined,
    });

    expect(calls).toEqual(["recovered"]);
  });
});
