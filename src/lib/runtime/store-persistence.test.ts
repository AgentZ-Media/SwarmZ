import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnvironmentSpec } from "./core";

const transport = vi.hoisted(() => ({
  loadRuntimeEnvironments: vi.fn(),
  saveRuntimeEnvironments: vi.fn(),
}));

vi.mock("@/lib/transport", () => transport);

import {
  flushRuntimeEnvironmentsPersist,
  useRuntimeEnvironments,
} from "./store";
import { persistenceIssues } from "@/lib/persistence/coordinator";

describe("Runtime Environment durability", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    useRuntimeEnvironments.setState({
      version: 1,
      byProject: {},
      selectedByProject: {},
      hydrated: false,
      hydrateError: null,
    });
    transport.loadRuntimeEnvironments.mockResolvedValue(null);
    await useRuntimeEnvironments.getState().hydrate();
  });

  it("surfaces a failed write, stays dirty, and retries the newest snapshot", async () => {
    transport.saveRuntimeEnvironments
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValueOnce(undefined);
    const spec: RuntimeEnvironmentSpec = {
      id: "local",
      name: "Local",
      setup: [],
      cleanup: [],
      services: [],
      secrets: [],
      databaseNamespacePrefix: "swarmz",
    };

    await expect(useRuntimeEnvironments.getState().upsert("project", spec))
      .rejects.toThrow("disk unavailable");
    expect(persistenceIssues().some((issue) => issue.name === "runtimeEnvironments"))
      .toBe(true);

    await flushRuntimeEnvironmentsPersist();
    expect(transport.saveRuntimeEnvironments).toHaveBeenCalledTimes(2);
    expect(transport.saveRuntimeEnvironments.mock.calls[1]?.[0].byProject.project[0].id)
      .toBe("local");
    expect(persistenceIssues().some((issue) => issue.name === "runtimeEnvironments"))
      .toBe(false);
  });
});
