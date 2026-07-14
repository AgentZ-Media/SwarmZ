import { describe, expect, it } from "vitest";
import {
  PLAYBOOK_SCHEMA_VERSION,
  PlaybookValidationError,
  buildPlaybookCatalog,
  expandPlaybook,
  validatePlaybook,
  type MissionPlaybookV1,
} from "./core";

function playbook(taskCount = 2): MissionPlaybookV1 {
  return {
    schemaVersion: PLAYBOOK_SCHEMA_VERSION,
    id: "release_hardening",
    version: 3,
    title: "Release hardening",
    description: "Prepare a bounded release verification mission.",
    source: { kind: "app", packageVersion: "1.2.3" },
    parameters: [
      { name: "target", type: "string", required: true, minLength: 2, maxLength: 40 },
      { name: "strict", type: "boolean", required: false, default: true },
    ],
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      key: `task_${index + 1}`,
      title: `Check {{target}} ${index + 1}`,
      description: "Inspect the assigned release surface.",
      role: (["architect", "implementer", "tester", "security"] as const)[index % 4],
      briefing: "Work only on {{target}}; report evidence, do not retain identity.",
      dependsOn: index === 0 ? [] : [`task_${index}`],
      acceptanceCriteria: ["Evidence for {{target}} is recorded."],
      rootRef: "{{target}}",
    })),
  };
}

describe("mission playbooks", () => {
  it("expands a versioned temporary-role briefing deterministically", () => {
    const expanded = expandPlaybook(playbook(), { target: "api" });
    expect(expanded.tasks[0]).toMatchObject({
      id: "release_hardening:3:task_1",
      role: "architect",
      title: "Check api 1",
      briefing: "Work only on api; report evidence, do not retain identity.",
    });
    expect(expanded.tasks[1].dependencyIds).toEqual([
      "release_hardening:3:task_1",
    ]);
    expect(expanded.parameters).toEqual({ target: "api", strict: true });
  });

  it("rejects unknown parameters and persona/memory fields fail closed", () => {
    expect(() => expandPlaybook(playbook(), { target: "api", surprise: 1 })).toThrow(
      /unknown playbook parameter/,
    );
    const unsafe = playbook() as MissionPlaybookV1 & { persona: string };
    unsafe.persona = "reusable expert";
    expect(() => validatePlaybook(unsafe)).toThrow(PlaybookValidationError);
  });

  it("accepts a bounded 50-task fixture and refuses task 51", () => {
    expect(expandPlaybook(playbook(50), { target: "desktop" }).tasks).toHaveLength(
      50,
    );
    expect(() => validatePlaybook(playbook(51))).toThrow(/1\.\.50 tasks/);
  });

  it("supports app and repo-local catalogs without ambiguous releases", () => {
    const app = playbook();
    const repo: MissionPlaybookV1 = {
      ...playbook(),
      id: "repo_checks",
      source: {
        kind: "repo",
        relativePath: ".swarmz/playbooks/repo.json",
        contentHash: "abcdef0123456789",
      },
    };
    expect(buildPlaybookCatalog([app], [repo]).map((item) => item.id)).toEqual([
      "release_hardening",
      "repo_checks",
    ]);
    expect(() => buildPlaybookCatalog([app], [{ ...repo, id: app.id }])).toThrow(
      /duplicate playbook release/,
    );
  });

  it("rejects cycles and unsafe repo paths", () => {
    const cyclic = playbook();
    cyclic.tasks[0].dependsOn = ["task_2"];
    expect(() => validatePlaybook(cyclic)).toThrow(/cycle/);
    const unsafe = playbook();
    unsafe.source = {
      kind: "repo",
      relativePath: "../outside.json",
      contentHash: "abcdef0123456789",
    };
    expect(() => validatePlaybook(unsafe)).toThrow(/safe and relative/);
  });
});
