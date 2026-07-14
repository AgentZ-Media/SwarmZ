import { describe, expect, it } from "vitest";
import type { MissionTask } from "@/lib/missions/types";
import {
  conflictWithLeases,
  lockKeysForTask,
  pathIntentsOverlap,
  provisionalLease,
} from "./conflicts";
import type { SchedulableTask } from "./types";

function task(
  id: string,
  patch: Partial<MissionTask> = {},
  runtime: Partial<SchedulableTask> = {},
): SchedulableTask {
  const value: MissionTask = {
    id,
    missionId: "mission",
    title: id,
    description: "",
    status: "ready",
    priority: 50,
    role: "implementation",
    risk: "low",
    acceptanceCriteria: [],
    root: { projectId: "project", path: "/repo" },
    worktreePolicy: { mode: "new" },
    dependencyIds: [],
    declaredFiles: [`src/${id}.ts`],
    declaredGlobs: [],
    maxAttempts: 3,
    attemptIds: [],
    qualityGateIds: [],
    artifactIds: [],
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    pausedAt: null,
    ...patch,
  };
  return { task: value, enqueuedAt: 0, worktreePath: `/repo/.worktrees/${id}`, ...runtime };
}

describe("scheduler conflict prediction", () => {
  it("matches exact paths and exact-file/glob intersections", () => {
    expect(pathIntentsOverlap(["src/a.ts"], [], ["src/a.ts"], [])).toBe(true);
    expect(pathIntentsOverlap(["src/a.ts"], [], [], ["src/*.ts"])).toBe(true);
    expect(pathIntentsOverlap(["docs/a.md"], [], [], ["src/**"])).toBe(false);
  });

  it("conservatively intersects globs with shared static prefixes", () => {
    expect(pathIntentsOverlap([], ["src/features/**"], [], ["src/features/*.ts"])).toBe(true);
    expect(pathIntentsOverlap([], ["src/a/**"], [], ["src/b/**"])).toBe(false);
    expect(pathIntentsOverlap([], ["**/*.ts"], [], ["docs/**"])).toBe(true);
  });

  it("normalizes separators and does not execute regex-like input", () => {
    expect(pathIntentsOverlap(["src\\a.ts"], [], ["src/a.ts"], [])).toBe(true);
    expect(pathIntentsOverlap(["src/(a)+.ts"], [], [], ["src/*.ts"])).toBe(true);
  });

  it("enforces one writer per worktree", () => {
    const first = task("a", {}, { worktreePath: "/repo/shared" });
    const second = task("b", {}, { worktreePath: "/repo/shared" });
    expect(conflictWithLeases(second, [provisionalLease(first)])?.code).toBe("worktree_lock");
  });

  it("serializes direct-root writers but permits separate non-overlapping worktrees", () => {
    const direct = task("a", {}, { worktreePath: null });
    const anotherDirect = task("b", {}, { worktreePath: null });
    expect(conflictWithLeases(anotherDirect, [provisionalLease(direct)])?.code).toBe("root_lock");

    const separate = task("c", {}, { worktreePath: "/repo/.worktrees/c" });
    expect(conflictWithLeases(separate, [provisionalLease(task("d"))])).toBeNull();
  });

  it("serializes explicit resource locks", () => {
    const migration = task("a", {}, { resourceKeys: ["database:migrations"] });
    const other = task("b", {}, { resourceKeys: ["database:migrations"] });
    expect(conflictWithLeases(other, [provisionalLease(migration)])?.code).toBe("resource_lock");
  });

  it("returns stable sorted lock keys", () => {
    expect(
      lockKeysForTask(task("a", {}, { resourceKeys: ["z", "a", "a"] })),
    ).toEqual(["resource:a", "resource:z", "worktree:/repo/.worktrees/a"]);
  });
});
