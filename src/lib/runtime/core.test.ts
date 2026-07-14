import { describe, expect, it } from "vitest";
import {
  allocateRuntimePort,
  buildRuntimeExecutionPlan,
  type RuntimeEnvironmentSpec,
  validateRuntimeEnvironment,
} from "./core";

const command = {
  id: "start-api",
  command: "pnpm dev",
  cwdRelative: ".",
  timeoutMs: 60_000,
  maxOutputBytes: 64_000,
  continueOnFailure: false,
};

const spec: RuntimeEnvironmentSpec = {
  id: "web-stack",
  name: "Web stack",
  setup: [{ ...command, id: "install", command: "pnpm install --offline" }],
  cleanup: [{ ...command, id: "cleanup", command: "pnpm db:drop" }],
  services: [
    {
      id: "api",
      label: "API",
      command,
      ports: [{ env: "API_PORT", preferred: 43100 }],
      healthcheckUrl: "http://127.0.0.1:${API_PORT}/health",
    },
  ],
  secrets: [
    {
      targetEnv: "DATABASE_URL",
      source: "keychain",
      sourceKey: "swarmz/local-database",
      required: true,
    },
  ],
  databaseNamespacePrefix: "checkout",
};

describe("runtime environment contracts", () => {
  it("builds deterministic isolated port and database assignments", () => {
    const first = buildRuntimeExecutionPlan(
      spec,
      { missionId: "mission-1", attemptId: "attempt-2" },
      new Set(),
    );
    const second = buildRuntimeExecutionPlan(
      spec,
      { missionId: "mission-1", attemptId: "attempt-2" },
      new Set(),
    );
    expect(first.services[0].assignedPorts.API_PORT).toBe(43100);
    expect(second.injectedEnv).toEqual(first.injectedEnv);
    expect(first.databaseNamespace).toBe("checkout_mission_1_attempt_2");
    expect(first.secretBindings[0]).not.toHaveProperty("value");
  });

  it("falls back deterministically when a preferred port is leased", () => {
    const used = new Set([43100]);
    const a = allocateRuntimePort("stable", used, 43100);
    const b = allocateRuntimePort("stable", used, 43100);
    expect(a).toBe(b);
    expect(used.has(a)).toBe(false);
  });

  it("rejects path escapes, unbounded commands and inline-looking secrets", () => {
    const invalid: RuntimeEnvironmentSpec = {
      ...spec,
      setup: [
        {
          ...command,
          cwdRelative: "../outside",
          timeoutMs: 99_999_999,
          maxOutputBytes: 99_999_999,
        },
      ],
      secrets: [
        {
          targetEnv: "TOKEN",
          source: "host_env",
          sourceKey: "https://secret.example/value",
          required: true,
        },
      ],
    };
    const validation = validateRuntimeEnvironment(invalid);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toContain("cwdRelative");
    expect(validation.errors.join(" ")).toContain("secret value");
  });
});
