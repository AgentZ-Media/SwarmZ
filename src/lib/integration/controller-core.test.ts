import { describe, expect, it } from "vitest";
import { integrationIdentity, missionTasksByRoot, parseApprovedArgv } from "./controller-core";
import type { MissionTask } from "@/lib/missions/types";

function task(id: string, root: string, createdAt: number): MissionTask {
  return {
    id, missionId: "mission-1", title: id, description: "", status: "succeeded",
    priority: 50, role: "implementation", risk: "medium", acceptanceCriteria: [],
    root: { projectId: `p-${root}`, path: root }, worktreePolicy: { mode: "new" },
    dependencyIds: [], declaredFiles: [], declaredGlobs: [], maxAttempts: 3,
    attemptIds: [], qualityGateIds: [], artifactIds: [], createdAt, updatedAt: createdAt,
    archivedAt: null, pausedAt: null, resumeInstruction: null, requeuedAfterAttemptId: null,
  };
}

describe("integration controller boundary", () => {
  it("builds stable root-confined train identities", () => {
    const first = integrationIdentity("mission-1", "/repo");
    expect(integrationIdentity("mission-1", "/repo")).toEqual(first);
    expect(first.branch).toMatch(/^swarmz\/integration\/[a-z0-9]+$/);
    expect(first.worktreePath.startsWith("/repo/.worktrees/")).toBe(true);
    expect(integrationIdentity("mission-1", "/other").trainId).not.toBe(first.trainId);
  });

  it("keeps multi-root tasks in independent deterministic trains", () => {
    const grouped = missionTasksByRoot([task("b", "/api", 2), task("a", "/web", 1), task("c", "/api", 1)]);
    expect([...grouped.keys()]).toEqual(["/api", "/web"]);
    expect(grouped.get("/api")?.map((entry) => entry.id)).toEqual(["c", "b"]);
  });

  it("parses direct argv with quotes but refuses shell execution", () => {
    expect(parseApprovedArgv('pnpm test -- --grep "safe path"')).toEqual(["pnpm", "test", "--", "--grep", "safe path"]);
    for (const command of ["pnpm test && rm -rf /", "bash -c 'pnpm test'", "pnpm $(evil)", "pnpm test > out"]) {
      expect(() => parseApprovedArgv(command)).toThrow();
    }
  });
});
