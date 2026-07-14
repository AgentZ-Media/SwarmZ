import { describe, expect, it } from "vitest";
import {
  normalizeGitHubIssues,
  normalizeJiraIssues,
  normalizeLinearIssues,
} from "./adapters";

describe("external intake adapters", () => {
  it("normalizes GitHub issue exports without a network path", () => {
    const result = normalizeGitHubIssues([
      {
        number: 42,
        title: "Harden checkout",
        body: "Reject forged callbacks",
        state: "OPEN",
        labels: [{ name: "security" }, "P0"],
        blockedBy: [10],
      },
    ]);
    expect(result.tasks[0]).toMatchObject({
      externalId: "GH-42",
      role: "security",
      priority: 100,
      dependencyRefs: ["GH-10"],
    });
  });

  it("extracts bounded Jira ADF and explicit blockers", () => {
    const result = normalizeJiraIssues([
      {
        key: "APP-9",
        fields: {
          summary: "Repair login",
          description: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Session expires early" }] },
            ],
          },
          priority: { name: "Highest" },
          blockedBy: ["APP-1"],
          labels: ["auth"],
        },
      },
    ]);
    expect(result.tasks[0]).toMatchObject({
      externalId: "APP-9",
      description: "Session expires early",
      priority: 100,
      dependencyRefs: ["APP-1"],
    });
  });

  it("maps Linear priority and filters completed records by default", () => {
    const result = normalizeLinearIssues([
      {
        id: "id-1",
        identifier: "ENG-1",
        title: "Open task",
        priority: 2,
        state: { type: "started" },
      },
      {
        id: "id-2",
        identifier: "ENG-2",
        title: "Done task",
        priority: 4,
        state: { type: "completed" },
      },
    ]);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ externalId: "ENG-1", priority: 80 });
  });

  it("normalizes a stable 50-issue fixture", () => {
    const records = Array.from({ length: 50 }, (_, index) => ({
      number: index + 1,
      title: `Issue ${index + 1}`,
      state: "OPEN" as const,
      blockedBy: index === 0 ? [] : [index],
    }));
    const result = normalizeGitHubIssues(records);
    expect(result.tasks).toHaveLength(50);
    expect(result.tasks[49].dependencyRefs).toEqual(["GH-49"]);
  });

  it("deduplicates external ids instead of silently duplicating work", () => {
    const result = normalizeLinearIssues([
      { id: "1", identifier: "ENG-1", title: "One", state: { type: "started" } },
      { id: "2", identifier: "ENG-1", title: "Duplicate", state: { type: "started" } },
    ]);
    expect(result.tasks).toHaveLength(1);
    expect(result.warnings.join(" ")).toContain("Duplicate external id");
  });
});
