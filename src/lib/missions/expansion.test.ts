import { describe, expect, it } from "vitest";
import {
  MULTI_ROOT_SCHEMA_VERSION,
  MissionExpansionError,
  planMultiRootMission,
  type MultiRootMissionSpecV1,
} from "./expansion";

function spec(): MultiRootMissionSpecV1 {
  return {
    schemaVersion: MULTI_ROOT_SCHEMA_VERSION,
    roots: [
      {
        id: "backend",
        projectId: "p1",
        path: "/repos/backend",
        repository: "acme/backend",
        defaultBranch: "main",
      },
      {
        id: "frontend",
        projectId: "p2",
        path: "/repos/frontend",
        repository: "acme/frontend",
        defaultBranch: "main",
      },
    ],
    tasks: [
      {
        id: "publish-api",
        rootId: "backend",
        title: "Publish API contract",
        kind: "api_contract",
        dependencyIds: [],
        contracts: [{ name: "checkout", version: "2.1.0", mode: "publish" }],
      },
      {
        id: "consume-api",
        rootId: "frontend",
        title: "Adopt API contract",
        kind: "implementation",
        dependencyIds: [],
        contracts: [{ name: "checkout", version: "2.1.0", mode: "consume" }],
      },
    ],
  };
}

describe("multi-root mission expansion", () => {
  it("adds contract cross-repo dependencies and orders producer PR first", () => {
    const plan = planMultiRootMission(spec());
    expect(plan.crossRepoDependencies).toEqual([
      expect.objectContaining({
        taskId: "consume-api",
        dependsOnTaskId: "publish-api",
        reason: "api_contract",
      }),
    ]);
    expect(plan.prOrder.map((step) => step.taskId)).toEqual([
      "publish-api",
      "consume-api",
    ]);
    expect(plan.prOrder[1].wave).toBe(1);
  });

  it("requires exact contract versions and a unique publisher", () => {
    const missing = spec();
    missing.tasks[1].contracts[0].version = "2.x";
    expect(() => planMultiRootMission(missing)).toThrow(/exact semantic version/);
    const duplicate = spec();
    duplicate.tasks.push({
      ...duplicate.tasks[0],
      id: "publish-api-again",
    });
    expect(() => planMultiRootMission(duplicate)).toThrow(/multiple publishers/);
  });

  it("rejects cross-repo cycles", () => {
    const cyclic = spec();
    cyclic.tasks[0].dependencyIds = ["consume-api"];
    expect(() => planMultiRootMission(cyclic)).toThrow(MissionExpansionError);
  });

  it("plans a deterministic 50-task, multi-repo fixture", () => {
    const fixture = spec();
    fixture.tasks = Array.from({ length: 50 }, (_, index) => ({
      id: `task-${String(index).padStart(2, "0")}`,
      rootId: index % 2 ? "frontend" : "backend",
      title: `Task ${index}`,
      kind: "implementation" as const,
      dependencyIds: index === 0 ? [] : [`task-${String(index - 1).padStart(2, "0")}`],
      contracts: [],
    }));
    const plan = planMultiRootMission(fixture);
    expect(plan.prOrder).toHaveLength(50);
    expect(plan.prOrder[49]).toMatchObject({ position: 49, wave: 49 });
    expect(plan.crossRepoDependencies).toHaveLength(49);
  });
});
