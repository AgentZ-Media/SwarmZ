import { describe, expect, it } from "vitest";
import type { RuntimeEnvironmentSpec } from "./core";
import { sanitizePersistedRuntimeEnvironments } from "./store";

const valid: RuntimeEnvironmentSpec = {
  id: "local",
  name: "Local",
  setup: [],
  cleanup: [],
  services: [],
  secrets: [{ targetEnv: "API_TOKEN", source: "host_env", sourceKey: "HOST_API_TOKEN", required: true }],
  databaseNamespacePrefix: "swarmz",
};

describe("runtime environment persistence sanitizer", () => {
  it("keeps valid per-project reference-only specs and selection", () => {
    expect(
      sanitizePersistedRuntimeEnvironments({
        version: 1,
        byProject: { project: [valid] },
        selectedByProject: { project: "local" },
      }),
    ).toEqual({
      version: 1,
      byProject: { project: [valid] },
      selectedByProject: { project: "local" },
    });
  });

  it("drops inline-looking secrets, duplicates and malformed projects", () => {
    const unsafe = {
      ...valid,
      id: "unsafe",
      secrets: [{ targetEnv: "TOKEN", source: "keychain", sourceKey: "https://secret/value", required: true }],
    };
    const result = sanitizePersistedRuntimeEnvironments({
      byProject: { project: [valid, valid, unsafe], "../bad": [valid] },
      selectedByProject: { project: "missing" },
    });
    expect(result.byProject.project).toEqual([valid]);
    expect(result.byProject["../bad"]).toBeUndefined();
    expect(result.selectedByProject.project).toBe("local");
  });
});
