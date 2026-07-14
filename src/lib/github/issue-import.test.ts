import { describe, expect, it } from "vitest";
import { importTasks } from "@/lib/intake/task-import";
import { buildGitHubIssueImport } from "./issue-import";
import type { GhIssue } from "./types";

const issues: GhIssue[] = [
  {
    number: 12,
    title: "Harden session cleanup",
    body: "Prevent process leaks.",
    labels: ["security", "p0"],
    state: "OPEN",
    url: "https://github.com/acme/swarmz/issues/12",
  },
  {
    number: 13,
    title: "Polish mission board",
    body: "Improve hierarchy.",
    labels: ["design"],
    state: "CLOSED",
    url: "https://github.com/acme/swarmz/issues/13",
  },
];

describe("buildGitHubIssueImport", () => {
  it("normalizes only the selected issues with provenance and closed support", () => {
    const result = buildGitHubIssueImport(issues, new Set([13]));

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      externalId: "GH-13",
      title: "Polish mission board",
      role: "implementer",
    });
    expect(result.tasks[0].description).toContain(issues[1].url);
  });

  it("deduplicates issue numbers and emits JSON accepted by generic intake", () => {
    const result = buildGitHubIssueImport([...issues, issues[0]]);
    expect(result.tasks.map((task) => task.externalId)).toEqual(["GH-12", "GH-13"]);
    expect(result.tasks[0]).toMatchObject({ priority: 100, role: "security" });

    const roundTrip = importTasks(result.json);
    expect(roundTrip.source).toBe("json");
    expect(roundTrip.tasks.map((task) => task.externalId)).toEqual(["GH-12", "GH-13"]);
    expect(roundTrip.tasks[0].labels).toEqual(["security", "p0"]);
  });

  it("returns a valid empty JSON array for an empty selection", () => {
    const result = buildGitHubIssueImport(issues, new Set());
    expect(result.tasks).toEqual([]);
    expect(result.json).toBe("[]");
  });

  it("keeps HTML-shaped GitHub content inert as ordinary task data", () => {
    const hostile: GhIssue = {
      number: 99,
      title: '<img src=x onerror="window.pwned=true">',
      body: "<script>alert('no')</script>",
      labels: ["</span><script>bad()</script>"],
      state: "OPEN",
      url: "https://github.com/acme/swarmz/issues/99",
    };
    const result = buildGitHubIssueImport([hostile]);
    const parsed = JSON.parse(result.json) as Array<Record<string, unknown>>;

    expect(result.tasks[0].title).toBe(hostile.title);
    expect(parsed[0].title).toBe(hostile.title);
    expect(parsed[0].description).toContain(hostile.body);
    expect(parsed[0].labels).toEqual(hostile.labels);
  });
});
