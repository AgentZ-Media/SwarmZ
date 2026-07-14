import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnvironmentSpec } from "./core";

const native = vi.hoisted(() => ({
  runRuntimeCommand: vi.fn(),
  startRuntimeService: vi.fn(),
  stopRuntimeService: vi.fn(),
  listRuntimeServices: vi.fn(),
}));

vi.mock("./native", () => native);

import {
  cleanupRuntimeEnvironment,
  launchRuntimeEnvironment,
  prepareRuntimeEnvironment,
  resumePreparedRuntimeEnvironment,
} from "./controller";

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
const owner = { projectId: "project", mainRoot: "/project" } as const;

describe("runtime launch cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    native.stopRuntimeService.mockResolvedValue(true);
    native.listRuntimeServices.mockResolvedValue([]);
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
        ...owner,
        projectRoot: "/project",
        missionId: "mission",
        attemptId: "attempt",
      }),
    ).rejects.toThrow('runtime setup command "setup" failed');

    expect(native.runRuntimeCommand.mock.calls.map(([request]) => request.runId.split(":").slice(-2).join(":"))).toEqual([
      "setup:setup",
      "setup-failure-cleanup:cleanup-one",
      "setup-failure-cleanup:cleanup-two",
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
        ...owner,
        projectRoot: "/project",
        missionId: "mission",
        attemptId: "attempt",
      }),
    ).rejects.toThrow("secret resolution failed");

    expect(native.runRuntimeCommand.mock.calls.map(([request]) => request.runId.split(":").slice(-2).join(":"))).toEqual([
      "setup:setup",
      "setup-failure-cleanup:cleanup-one",
      "setup-failure-cleanup:cleanup-two",
    ]);
  });

  it("adopts the exact deterministic service set after a controller crash", async () => {
    const serviceSpec: RuntimeEnvironmentSpec = {
      ...spec,
      setup: [],
      services: [{
        id: "api",
        label: "API",
        command: command("api-command"),
        ports: [],
        healthcheckUrl: null,
      }],
    };
    // Use the real deterministic id without duplicating its hash in the fixture.
    const { runtimeEnvironmentInstanceId } = await import("./controller");
    native.listRuntimeServices.mockResolvedValue([{
      instanceId: runtimeEnvironmentInstanceId({ missionId: "mission", attemptId: "attempt" }, "local"),
      serviceId: "api", projectRoot: "/project", state: "running", ports: {},
    }]);
    const result = await launchRuntimeEnvironment(serviceSpec, {
      ...owner,
      projectRoot: "/project", missionId: "mission", attemptId: "attempt",
    });
    expect(result.services).toHaveLength(1);
    expect(native.startRuntimeService).not.toHaveBeenCalled();
    expect(native.runRuntimeCommand).not.toHaveBeenCalled();
  });

  it("always executes setup-only environments", async () => {
    native.runRuntimeCommand.mockResolvedValue({ status: "completed", exitCode: 0 });
    await launchRuntimeEnvironment({ ...spec, cleanup: [] }, {
      ...owner,
      projectRoot: "/project", missionId: "mission", attemptId: "attempt",
    });
    expect(native.runRuntimeCommand).toHaveBeenCalledTimes(1);
    expect(native.runRuntimeCommand.mock.calls[0][0].runId).toContain(":setup:setup");
  });

  it("never repeats setup when resuming from a durable prepared receipt", async () => {
    const serviceSpec: RuntimeEnvironmentSpec = {
      ...spec,
      services: [{ id: "api", label: "API", command: command("api-command"), ports: [], healthcheckUrl: null }],
    };
    native.startRuntimeService.mockResolvedValue({
      instanceId: "instance", serviceId: "api", projectRoot: "/project", state: "running", ports: {},
    });
    await resumePreparedRuntimeEnvironment(serviceSpec, {
      ...owner,
      projectRoot: "/project", missionId: "mission", attemptId: "attempt",
    });
    expect(native.runRuntimeCommand).not.toHaveBeenCalled();
    expect(native.startRuntimeService).toHaveBeenCalledTimes(1);
  });

  it("exposes setup as a receipt boundary before any service starts", async () => {
    native.runRuntimeCommand.mockResolvedValue({ status: "completed", exitCode: 0 });
    const result = await prepareRuntimeEnvironment({
      ...spec,
      services: [{ id: "api", label: "API", command: command("api-command"), ports: [], healthcheckUrl: null }],
    }, { ...owner, projectRoot: "/project", missionId: "mission", attemptId: "attempt" });
    expect(result.setup).toHaveLength(1);
    expect(native.runRuntimeCommand.mock.calls[0][0].runId).toContain(":prepare:setup");
    expect(native.startRuntimeService).not.toHaveBeenCalled();
  });

  it("refuses a deterministic instance collision from another root without stopping it", async () => {
    const { runtimeEnvironmentInstanceId } = await import("./controller");
    native.listRuntimeServices.mockResolvedValue([{
      instanceId: runtimeEnvironmentInstanceId({ missionId: "mission", attemptId: "attempt" }, "local"),
      serviceId: "api", projectRoot: "/foreign", state: "running", ports: {},
    }]);
    await expect(launchRuntimeEnvironment({
      ...spec,
      setup: [],
      services: [{ id: "api", label: "API", command: command("api-command"), ports: [], healthcheckUrl: null }],
    }, { ...owner, projectRoot: "/project", missionId: "mission", attemptId: "attempt" }))
      .rejects.toThrow("another root");
    expect(native.stopRuntimeService).not.toHaveBeenCalled();
  });

  it("fails closed when a prior service cannot be stopped and confirmed absent", async () => {
    const { runtimeEnvironmentInstanceId } = await import("./controller");
    const owned = {
      instanceId: runtimeEnvironmentInstanceId({ missionId: "mission", attemptId: "attempt" }, "local"),
      serviceId: "api", projectRoot: "/project", state: "orphaned", ports: {},
    };
    native.listRuntimeServices.mockResolvedValue([owned]);
    native.stopRuntimeService.mockRejectedValue(new Error("ownership unresolved"));
    await expect(resumePreparedRuntimeEnvironment({
      ...spec,
      services: [{ id: "api", label: "API", command: command("api-command"), ports: [], healthcheckUrl: null }],
    }, { ...owner, projectRoot: "/project", missionId: "mission", attemptId: "attempt" }))
      .rejects.toThrow("cleanup is unresolved");
    expect(native.startRuntimeService).not.toHaveBeenCalled();
  });

  it("never certifies cleanup when a cleanup command fails", async () => {
    native.runRuntimeCommand
      .mockResolvedValueOnce({ status: "completed", exitCode: 2 })
      .mockResolvedValueOnce({ status: "completed", exitCode: 0 });
    await expect(cleanupRuntimeEnvironment(spec, {
      ...owner,
      projectRoot: "/project", missionId: "mission", attemptId: "attempt",
    })).rejects.toThrow("runtime cleanup is incomplete");
    expect(native.runRuntimeCommand).toHaveBeenCalledTimes(2);
  });
});
