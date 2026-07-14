import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnvironmentSpec } from "@/lib/runtime/core";

const runtime = vi.hoisted(() => ({
  launchRuntimeEnvironment: vi.fn(),
  prepareRuntimeEnvironment: vi.fn(),
  cleanupRuntimeEnvironment: vi.fn(),
  resumePreparedRuntimeEnvironment: vi.fn(),
  runtimeEnvironmentInstanceId: vi.fn(() => "mission-owned-instance"),
  listRuntimeServices: vi.fn(),
  stopRuntimeService: vi.fn(),
}));

vi.mock("@/lib/runtime/controller", () => ({
  launchRuntimeEnvironment: runtime.launchRuntimeEnvironment,
  prepareRuntimeEnvironment: runtime.prepareRuntimeEnvironment,
  cleanupRuntimeEnvironment: runtime.cleanupRuntimeEnvironment,
  resumePreparedRuntimeEnvironment: runtime.resumePreparedRuntimeEnvironment,
  runtimeEnvironmentInstanceId: runtime.runtimeEnvironmentInstanceId,
}));
vi.mock("@/lib/runtime/native", () => ({
  listRuntimeServices: runtime.listRuntimeServices,
  stopRuntimeService: runtime.stopRuntimeService,
}));

import {
  bindingForRuntimeSpec,
  cleanupBoundMissionRuntime,
  missionRuntimePrompt,
  resolveMissionRuntimeBinding,
  resumePreparedBoundMissionRuntime,
  prepareBoundMissionRuntime,
} from "./runtime-binding";
import { useRuntimeEnvironments } from "@/lib/runtime/store";

const spec: RuntimeEnvironmentSpec = {
  id: "local",
  name: "Local",
  setup: [],
  cleanup: [],
  services: [],
  secrets: [],
  databaseNamespacePrefix: "swarmz",
};
const context = {
  projectId: "project",
  mainRoot: "/main",
  projectRoot: "/worktree",
  missionId: "mission",
  attemptId: "attempt",
} as const;

describe("Mission Runtime binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRuntimeEnvironments.setState({
      version: 1,
      byProject: { project: [spec] },
      selectedByProject: { project: "local" },
      hydrated: true,
      hydrateError: null,
    });
  });

  it("freezes id and stable SHA-256 fingerprint and rejects drift", () => {
    const binding = bindingForRuntimeSpec(spec);
    expect(binding).toEqual({ environmentId: "local", specFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    expect(resolveMissionRuntimeBinding(binding, [structuredClone(spec)]).spec.id).toBe("local");
    expect(() => resolveMissionRuntimeBinding(binding, [{ ...spec, name: "Changed" }]))
      .toThrow("approved runtime environment changed");
  });

  it("refuses Mission approval when setup or cleanup is not explicitly retry-safe", () => {
    const unsafe = {
      ...spec,
      setup: [{
        id: "seed", argv: ["pnpm", "db:seed"], cwdRelative: ".", timeoutMs: 5_000,
        maxOutputBytes: 4_096, continueOnFailure: false,
      }],
    } satisfies RuntimeEnvironmentSpec;
    expect(() => bindingForRuntimeSpec(unsafe)).toThrow("must be marked safe to retry");
    expect(bindingForRuntimeSpec({
      ...unsafe,
      setup: [{ ...unsafe.setup[0], idempotent: true }],
    }).specFingerprint).toMatch(/^sha256:/);
  });

  it("refuses Mission-bound secrets because worker code could persist them", () => {
    expect(() => bindingForRuntimeSpec({
      ...spec,
      secrets: [{
        targetEnv: "TOKEN",
        source: "host_env",
        sourceKey: "RUNTIME_TOKEN",
        required: true,
      }],
    })).toThrow("refuse secret bindings");
  });

  it("renders only non-secret worker coordinates", () => {
    const prompt = missionRuntimePrompt({
      instanceId: "instance",
      setup: [],
      databaseNamespace: "swarmz_mission_attempt",
      services: [{
        instanceId: "instance", serviceId: "api", projectRoot: "/worktree",
        ownerProjectId: "project", ownerMissionId: "mission",
        ownerAttemptId: "attempt", mainRoot: "/main",
        state: "running", pid: 1, ports: { API_PORT: 43123 }, startedAt: 1,
        exitCode: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
      }],
    });
    expect(prompt).toContain("API_PORT=43123");
    expect(prompt).not.toContain("RUNTIME_TOKEN");
    expect(prompt).not.toContain("TOKEN");
  });

  it("on spec drift stops only the deterministic instance under the exact worktree", async () => {
    const binding = bindingForRuntimeSpec(spec);
    useRuntimeEnvironments.setState({ byProject: { project: [{ ...spec, name: "Drifted" }] } });
    runtime.listRuntimeServices
      .mockResolvedValueOnce([
        { instanceId: "mission-owned-instance", serviceId: "api", projectRoot: "/worktree" },
        { instanceId: "foreign-instance", serviceId: "db", projectRoot: "/worktree" },
      ])
      .mockResolvedValueOnce([
        { instanceId: "foreign-instance", serviceId: "db", projectRoot: "/worktree" },
      ]);
    runtime.stopRuntimeService.mockResolvedValue(true);
    await cleanupBoundMissionRuntime(binding, context);
    expect(runtime.stopRuntimeService).toHaveBeenCalledTimes(1);
    expect(runtime.stopRuntimeService).toHaveBeenCalledWith(
      "mission-owned-instance",
      "api",
      "/worktree",
    );
    expect(runtime.cleanupRuntimeEnvironment).not.toHaveBeenCalled();
  });

  it("resumes a durable setup-done receipt without executing setup again", async () => {
    const binding = bindingForRuntimeSpec(spec);
    runtime.resumePreparedRuntimeEnvironment.mockResolvedValue({
      instanceId: "mission-owned-instance", setup: [], services: [],
      databaseNamespace: "swarmz_mission_attempt",
    });
    const resumed = await resumePreparedBoundMissionRuntime(binding, context);
    expect(resumed.prompt).toContain("prepared");
    expect(runtime.resumePreparedRuntimeEnvironment).toHaveBeenCalledTimes(1);
    expect(runtime.launchRuntimeEnvironment).not.toHaveBeenCalled();
  });

  it("splits setup receipt from service resume across the send-failure crash window", async () => {
    const binding = bindingForRuntimeSpec(spec);
    runtime.prepareRuntimeEnvironment.mockResolvedValue({
      instanceId: "mission-owned-instance", setup: [{ commandId: "setup", result: { status: "completed", exitCode: 0 } }],
      services: [], databaseNamespace: "swarmz_mission_attempt",
    });
    runtime.resumePreparedRuntimeEnvironment.mockResolvedValue({
      instanceId: "mission-owned-instance", setup: [], services: [], databaseNamespace: "swarmz_mission_attempt",
    });
    // First dispatch prepares, durably receipts, then the worker send fails.
    await prepareBoundMissionRuntime(binding, context);
    await resumePreparedBoundMissionRuntime(binding, context);
    // Recovery consumes the durable prepared receipt and only reconciles services.
    await resumePreparedBoundMissionRuntime(binding, context);
    expect(runtime.prepareRuntimeEnvironment).toHaveBeenCalledTimes(1);
    expect(runtime.resumePreparedRuntimeEnvironment).toHaveBeenCalledTimes(2);
    expect(runtime.launchRuntimeEnvironment).not.toHaveBeenCalled();
  });

  it("refuses to stop a colliding instance from another worktree", async () => {
    const binding = bindingForRuntimeSpec(spec);
    useRuntimeEnvironments.setState({ byProject: { project: [] } });
    runtime.listRuntimeServices.mockResolvedValue([
      { instanceId: "mission-owned-instance", serviceId: "api", projectRoot: "/foreign" },
    ]);
    await expect(cleanupBoundMissionRuntime(binding, context)).rejects.toThrow("another worktree");
    expect(runtime.stopRuntimeService).not.toHaveBeenCalled();
  });
});
