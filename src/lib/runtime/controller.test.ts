import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnvironmentSpec } from "./core";

const native = vi.hoisted(() => ({
  runRuntimeCommand: vi.fn(),
  startRuntimeService: vi.fn(),
  stopRuntimeService: vi.fn(),
}));

vi.mock("./native", () => native);

import { launchRuntimeEnvironment } from "./controller";

const command = (id: string) => ({
  id,
  argv: ["/usr/bin/true"],
  cwdRelative: ".",
  timeoutMs: 5_000,
  maxOutputBytes: 4_096,
  continueOnFailure: false,
});

const spec: RuntimeEnvironmentSpec = {
  id: "local",
  name: "Local",
  setup: [command("setup")],
  cleanup: [command("cleanup-one"), command("cleanup-two")],
  services: [],
  secrets: [],
  databaseNamespacePrefix: "swarmz",
};

describe("runtime launch cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    native.stopRuntimeService.mockResolvedValue(true);
  });

  it("attempts every cleanup command after a setup failure and preserves the setup error", async () => {
    native.runRuntimeCommand.mockImplementation(async (request: { runId: string }) => {
      if (request.runId.includes("setup-failure-cleanup:cleanup-one")) {
        throw new Error("cleanup one unavailable");
      }
      if (request.runId.includes("setup-failure-cleanup:cleanup-two")) {
        return { status: "completed", exitCode: 0 };
      }
      return { status: "completed", exitCode: 2 };
    });

    await expect(
      launchRuntimeEnvironment(spec, {
        projectRoot: "/project",
        missionId: "mission",
        attemptId: "attempt",
      }),
    ).rejects.toThrow('runtime setup command "setup" failed');

    expect(native.runRuntimeCommand.mock.calls.map(([request]) => request.runId)).toEqual([
      "local:mission:attempt:setup:setup",
      "local:mission:attempt:setup-failure-cleanup:cleanup-one",
      "local:mission:attempt:setup-failure-cleanup:cleanup-two",
    ]);
  });

  it("also cleans up when the native setup invocation throws", async () => {
    native.runRuntimeCommand.mockImplementation(async (request: { runId: string }) => {
      if (request.runId.endsWith(":setup:setup")) throw new Error("secret resolution failed");
      if (request.runId.includes("cleanup-one")) throw new Error("cleanup one unavailable");
      return { status: "completed", exitCode: 0 };
    });

    await expect(
      launchRuntimeEnvironment(spec, {
        projectRoot: "/project",
        missionId: "mission",
        attemptId: "attempt",
      }),
    ).rejects.toThrow("secret resolution failed");

    expect(native.runRuntimeCommand.mock.calls.map(([request]) => request.runId)).toEqual([
      "local:mission:attempt:setup:setup",
      "local:mission:attempt:setup-failure-cleanup:cleanup-one",
      "local:mission:attempt:setup-failure-cleanup:cleanup-two",
    ]);
  });
});
