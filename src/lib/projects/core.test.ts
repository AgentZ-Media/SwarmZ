import { describe, expect, it } from "vitest";
import type { Project } from "@/types";
import {
  assignSessionsToProjects,
  dirBasename,
  isDirWithin,
  normalizeDirKey,
  openProjectsSorted,
  reorderOpenProject,
  uniqueProjectName,
} from "./core";

function project(patch: Partial<Project> & { id: string; dir: string }): Project {
  return {
    name: dirBasename(patch.dir),
    order: 0,
    lastActiveAt: 0,
    createdAt: 0,
    closedAt: null,
    ...patch,
  };
}

describe("normalizeDirKey", () => {
  it("trims and strips trailing slashes", () => {
    expect(normalizeDirKey(" /Users/tc/Code/api/ ")).toBe("/Users/tc/Code/api");
    expect(normalizeDirKey("/Users/tc/Code/api///")).toBe("/Users/tc/Code/api");
    expect(normalizeDirKey("/Users/tc/Code/api")).toBe("/Users/tc/Code/api");
  });

  it("keeps the filesystem root and empties empty input", () => {
    expect(normalizeDirKey("/")).toBe("/");
    expect(normalizeDirKey("   ")).toBe("");
  });
});

describe("isDirWithin", () => {
  it("accepts the root itself and true subfolders", () => {
    expect(isDirWithin("/a/b", "/a/b")).toBe(true);
    expect(isDirWithin("/a/b", "/a/b/")).toBe(true);
    expect(isDirWithin("/a/b", "/a/b/src/lib")).toBe(true);
    expect(isDirWithin("/", "/anything")).toBe(true);
  });

  it("rejects siblings, parents and lookalike prefixes", () => {
    expect(isDirWithin("/a/b", "/a/c")).toBe(false);
    expect(isDirWithin("/a/b", "/a")).toBe(false);
    // segment boundary: /a/bc is NOT within /a/b
    expect(isDirWithin("/a/b", "/a/bc")).toBe(false);
    expect(isDirWithin("/a/b", "")).toBe(false);
    expect(isDirWithin("", "/a/b")).toBe(false);
  });
});

describe("uniqueProjectName", () => {
  it("uses the folder basename", () => {
    expect(uniqueProjectName("/Users/tc/Code/api", [])).toBe("api");
    expect(uniqueProjectName("/Users/tc/Code/api/", [])).toBe("api");
  });

  it("suffixes on collision (case-insensitive), lowest free number", () => {
    expect(uniqueProjectName("/x/api", ["API"])).toBe("api 2");
    expect(uniqueProjectName("/x/api", ["api", "api 2"])).toBe("api 3");
    expect(uniqueProjectName("/x/api", ["api", "api 3"])).toBe("api 2");
  });
});

describe("openProjectsSorted / reorderOpenProject", () => {
  const a = project({ id: "a", dir: "/x/a", order: 0 });
  const b = project({ id: "b", dir: "/x/b", order: 1 });
  const c = project({ id: "c", dir: "/x/c", order: 2 });
  const closed = project({ id: "z", dir: "/x/z", order: 1, closedAt: 123 });

  it("sorts open projects by order and skips closed ones", () => {
    expect(openProjectsSorted([c, closed, a, b]).map((p) => p.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("moves a tab and patches only changed orders", () => {
    const patches = reorderOpenProject([a, b, c, closed], "c", 0);
    expect(patches).toEqual([
      { id: "c", order: 0 },
      { id: "a", order: 1 },
      { id: "b", order: 2 },
    ]);
  });

  it("clamps the index and no-ops on same position / unknown ids", () => {
    expect(reorderOpenProject([a, b, c], "a", 0)).toEqual([]);
    expect(reorderOpenProject([a, b, c], "nope", 1)).toEqual([]);
    const patches = reorderOpenProject([a, b, c], "a", 99);
    expect(patches.find((p) => p.id === "a")?.order).toBe(2);
  });
});

describe("assignSessionsToProjects (v2 hydrate migration)", () => {
  let seq = 0;
  const newId = () => `p${++seq}`;

  it("derives deduped projects from projectDirs and assigns every session", () => {
    seq = 0;
    const res = assignSessionsToProjects(
      [
        { id: "s1", projectDir: "/x/api", projectId: null },
        { id: "s2", projectDir: "/x/api/", projectId: null }, // same dir, other spelling
        { id: "s3", projectDir: "/x/web", projectId: null },
      ],
      [],
      1000,
      newId,
    );
    expect(res.created).toHaveLength(2);
    expect(res.created.map((p) => p.name)).toEqual(["api", "web"]);
    expect(res.created.map((p) => p.order)).toEqual([0, 1]);
    expect(res.created.every((p) => !p.closedAt)).toBe(true);
    expect(res.assignments.s1).toBe(res.assignments.s2);
    expect(res.assignments.s3).not.toBe(res.assignments.s1);
  });

  it("keeps a valid projectId and reuses existing projects by dir (even closed ones)", () => {
    seq = 0;
    const existing = [
      project({ id: "keep", dir: "/x/api", order: 0 }),
      project({ id: "closed", dir: "/x/web", order: 1, closedAt: 5 }),
    ];
    const res = assignSessionsToProjects(
      [
        { id: "s1", projectDir: "/elsewhere", projectId: "keep" }, // id wins over dir
        { id: "s2", projectDir: "/x/web", projectId: null }, // → the closed project
        { id: "s3", projectDir: "/x/new", projectId: "gone" }, // lost project → by dir
      ],
      existing,
      1000,
      newId,
    );
    expect(res.assignments.s1).toBe("keep");
    expect(res.assignments.s2).toBe("closed");
    expect(res.created).toHaveLength(1);
    expect(res.assignments.s3).toBe(res.created[0].id);
    // new project appended after the existing tab orders
    expect(res.created[0].order).toBe(2);
  });

  it("dedupes new project names against existing ones", () => {
    seq = 0;
    const existing = [project({ id: "e", dir: "/other/api", order: 0 })];
    const res = assignSessionsToProjects(
      [{ id: "s1", projectDir: "/x/api", projectId: null }],
      existing,
      1000,
      newId,
    );
    expect(res.created[0].name).toBe("api 2");
  });

  it("is a no-op for fully assigned sessions", () => {
    seq = 0;
    const existing = [project({ id: "e", dir: "/x/api", order: 0 })];
    const res = assignSessionsToProjects(
      [{ id: "s1", projectDir: "/x/api", projectId: "e" }],
      existing,
      1000,
      newId,
    );
    expect(res.created).toEqual([]);
    expect(res.assignments).toEqual({ s1: "e" });
  });
});
