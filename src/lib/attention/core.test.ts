import { describe, expect, it } from "vitest";
import { emptyMissionProjection } from "@/lib/missions/core";
import type {
  IntegrationTrain,
  Mission,
  MissionTask,
} from "@/lib/missions/types";
import type { ProjectGithub } from "@/lib/github/store";
import type { Project } from "@/types";
import { buildAttentionRows } from "./core";

const policy: Mission["policy"] = {
  maxParallelAttempts: 2,
  stopOnCriticalFailure: true,
  requireQualityGates: true,
  integrationMode: "train",
};
const budget: Mission["budget"] = {
  maxAttemptsTotal: null,
  maxActiveMinutes: null,
  maxTokens: null,
  maxCostUsd: null,
};

describe("global attention projection", () => {
  it("counts rows across two projects from tasks, trains, workers and actionable PRs", () => {
    const projection = emptyMissionProjection();
    projection.missions.m1 = mission("m1", "p1", "Frontend release", ["t1"]);
    projection.missions.m2 = mission("m2", "p2", "Backend release", ["t2"]);
    projection.tasks.t1 = task("t1", "m1", "p1", "needs_human");
    projection.tasks.t2 = task("t2", "m2", "p2", "succeeded");
    projection.integrationTrains.train2 = train("train2", "m2", "t2");

    const rows = buildAttentionRows({
      projection,
      workers: [
        {
          id: "worker2",
          projectId: "p2",
          name: "Lane 2",
          project: "backend",
          since: 30,
          kind: "approval",
          summary: "Approve the formatter command",
        },
      ],
      githubByProject: {
        p1: github([
          {
            number: 17,
            title: "Ship release",
            author: "timo",
            head_ref: "release",
            base_ref: "main",
            is_draft: false,
            mergeable: "MERGEABLE",
            review_decision: "",
            url: "https://example.test/pr/17",
            updated_at: "2026-07-14T12:00:00Z",
            checks: { passing: 2, failing: 1, pending: 0, total: 3 },
          },
        ]),
        p2: github([
          {
            number: 18,
            title: "Healthy PR",
            author: "timo",
            head_ref: "healthy",
            base_ref: "main",
            is_draft: false,
            mergeable: "MERGEABLE",
            review_decision: "APPROVED",
            url: "https://example.test/pr/18",
            updated_at: "2026-07-14T12:00:00Z",
            checks: { passing: 3, failing: 0, pending: 0, total: 3 },
          },
        ]),
      },
      projects: {
        p1: project("p1", "Frontend"),
        p2: project("p2", "Backend"),
      },
    });

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => [row.key, row.projectId])).toEqual(
      expect.arrayContaining([
        ["task:t1", "p1"],
        ["train:train2", "p2"],
        ["worker:worker2", "p2"],
        ["github:p1:17", "p1"],
      ]),
    );
    expect(rows.some((row) => row.key === "github:p2:18")).toBe(false);
  });

  it("keeps a missionless project visible when its PR has an actionable failure", () => {
    const rows = buildAttentionRows({
      projection: emptyMissionProjection(),
      workers: [],
      githubByProject: {
        p1: github([
          {
            number: 9,
            title: "Conflicted change",
            author: "timo",
            head_ref: "feature",
            base_ref: "main",
            is_draft: false,
            mergeable: "CONFLICTING",
            review_decision: "CHANGES_REQUESTED",
            url: "https://example.test/pr/9",
            updated_at: "2026-07-14T10:00:00Z",
            checks: { passing: 0, failing: 2, pending: 0, total: 2 },
          },
        ]),
      },
      projects: { p1: project("p1", "Missionless") },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "github:p1:9",
      projectId: "p1",
      source: "github",
      statusLabel: "conflict",
    });
    expect(rows[0].detail).toContain("2 CI checks are failing");
    expect(rows[0].detail).toContain("merge conflicts");
    expect(rows[0].detail).toContain("review changes are requested");
  });
});

function mission(
  id: string,
  projectId: string,
  title: string,
  taskIds: string[],
): Mission {
  return {
    id,
    projectId,
    title,
    objective: title,
    status: "active",
    taskIds,
    integrationTrainIds: [],
    policy,
    budget,
    createdAt: 1,
    updatedAt: 2,
    archivedAt: null,
    cancelledAt: null,
    pausedAt: null,
    activatedAt: 2,
    revision: 1,
  };
}

function task(
  id: string,
  missionId: string,
  projectId: string,
  status: MissionTask["status"],
): MissionTask {
  return {
    id,
    missionId,
    title: `${id} title`,
    description: `${id} description`,
    status,
    priority: 50,
    role: "implementation",
    risk: "medium",
    acceptanceCriteria: ["verified"],
    root: { projectId, path: `/tmp/${projectId}` },
    worktreePolicy: { mode: "new" },
    dependencyIds: [],
    declaredFiles: [],
    declaredGlobs: [],
    maxAttempts: 2,
    attemptIds: [],
    qualityGateIds: [],
    artifactIds: [],
    createdAt: 1,
    updatedAt: 20,
    archivedAt: null,
    pausedAt: null,
  };
}

function train(id: string, missionId: string, taskId: string): IntegrationTrain {
  return {
    id,
    missionId,
    baseBranch: "main",
    integrationBranch: `swarmz/${id}`,
    status: "blocked",
    entries: [
      {
        taskId,
        position: 0,
        status: "failed",
        commit: null,
        detail: "merge conflict",
      },
    ],
    createdAt: 10,
    updatedAt: 40,
  };
}

function project(id: string, name: string): Project {
  return {
    id,
    dir: `/tmp/${id}`,
    name,
    order: 0,
    lastActiveAt: 1,
    createdAt: 1,
    closedAt: null,
  };
}

function github(prs: ProjectGithub["prs"]): ProjectGithub {
  return {
    repoStatus: "ok",
    repoError: null,
    repo: null,
    prs,
    prsFetchedAt: Date.parse("2026-07-14T12:00:00Z"),
    prsError: null,
  };
}
