import { describe, expect, it } from "vitest";
import type { MissionTask } from "@/lib/missions/types";
import { buildConflictRadar } from "./conflict-radar";

function task(patch: Partial<MissionTask> = {}): MissionTask {
  return {
    id: "candidate",
    missionId: "mission",
    title: "Candidate",
    description: "",
    status: "succeeded",
    priority: 50,
    role: "implementation",
    risk: "low",
    acceptanceCriteria: [],
    root: { projectId: "project", path: "/repo" },
    worktreePolicy: { mode: "new" },
    dependencyIds: [],
    declaredFiles: ["src/a.ts"],
    declaredGlobs: [],
    maxAttempts: 3,
    attemptIds: ["attempt:candidate"],
    qualityGateIds: [],
    artifactIds: [],
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    pausedAt: null,
    ...patch,
  };
}

describe("integration conflict radar", () => {
  it("reports exact-file overlap as high severity", () => {
    expect(buildConflictRadar(task(), [{ id: "base", files: ["src/a.ts"] }])).toEqual([
      expect.objectContaining({ severity: "high", kind: "exact_file", evidence: ["src/a.ts"] }),
    ]);
  });

  it("elevates migrations, security and lockfiles to critical", () => {
    for (const path of ["db/migrations/001.sql", "src/auth/policy.ts", "pnpm-lock.yaml"]) {
      const radar = buildConflictRadar(task({ declaredFiles: [path] }), [{ id: "base", files: [path] }]);
      expect(radar[0]?.severity).toBe("critical");
      expect(radar[0]?.kind).toBe("critical_surface");
    }
  });

  it("reports conservative glob overlap as medium", () => {
    const radar = buildConflictRadar(task({ declaredFiles: [], declaredGlobs: ["src/features/**"] }), [
      { id: "base", files: [], globs: ["src/features/*.ts"] },
    ]);
    expect(radar[0]).toMatchObject({ severity: "medium", kind: "glob_overlap" });
  });

  it("ignores disjoint declarations and the candidate's own source", () => {
    expect(buildConflictRadar(task(), [{ id: "docs", files: ["docs/readme.md"] }])).toEqual([]);
    expect(buildConflictRadar(task(), [{ id: "self", taskId: "candidate", files: ["src/a.ts"] }])).toEqual([]);
  });

  it("sorts critical findings ahead of high and medium deterministically", () => {
    const candidate = task({
      declaredFiles: ["src/a.ts", "db/schema.sql"],
      declaredGlobs: ["features/**"],
    });
    const sources = [
      { id: "z-medium", files: [], globs: ["features/*.ts"] },
      { id: "a-high", files: ["src/a.ts"] },
      { id: "m-critical", files: ["db/schema.sql"] },
    ];
    expect(buildConflictRadar(candidate, sources).map((item) => item.sourceId)).toEqual([
      "m-critical",
      "a-high",
      "z-medium",
    ]);
  });
});
