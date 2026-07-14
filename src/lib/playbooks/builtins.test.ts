import { describe, expect, it } from "vitest";
import {
  BUG_BACKLOG_CLEANUP_PLAYBOOK,
  BUILTIN_PLAYBOOKS,
  FEATURE_ACROSS_LAYERS_PLAYBOOK,
  RELEASE_HARDENING_PLAYBOOK,
} from "./builtins";
import { expandPlaybook, validatePlaybook } from "./core";

describe("built-in mission playbooks", () => {
  it("ships three unique, valid application templates", () => {
    expect(BUILTIN_PLAYBOOKS).toHaveLength(3);
    expect(new Set(BUILTIN_PLAYBOOKS.map((item) => item.id)).size).toBe(3);
    for (const template of BUILTIN_PLAYBOOKS) {
      expect(() => validatePlaybook(template)).not.toThrow();
      expect(template.source.kind).toBe("app");
      expect(template.tasks.every((task) => task.acceptanceCriteria.length >= 3)).toBe(true);
    }
  });

  it("expands release hardening into ordered independent verification", () => {
    const result = expandPlaybook(RELEASE_HARDENING_PLAYBOOK, {
      release_name: "2.0",
      root: "/repo",
      verification_command: "pnpm test && pnpm build",
    });
    expect(result.tasks.map((task) => task.role)).toEqual([
      "architect",
      "implementer",
      "tester",
      "security",
    ]);
    expect(result.tasks[2].dependencyIds).toEqual([
      "release_hardening:1:stabilize_candidate",
    ]);
    expect(result.tasks[2].acceptanceCriteria[0]).toContain("pnpm test");
  });

  it("keeps layer implementations parallel behind one explicit contract", () => {
    const result = expandPlaybook(FEATURE_ACROSS_LAYERS_PLAYBOOK, {
      feature_name: "Mission inbox",
      root: "/repo",
      contract_surface: "local_native",
      quality_command: "pnpm test",
    });
    const service = result.tasks.find((task) => task.key === "implement_service_layer")!;
    const product = result.tasks.find((task) => task.key === "implement_product_surface")!;
    expect(service.dependencyIds).toEqual(product.dependencyIds);
    expect(result.tasks.find((task) => task.key === "verify_feature_flow")?.dependencyIds).toEqual([
      service.id,
      product.id,
    ]);
  });

  it("bounds backlog intake and joins both repair lanes before verification", () => {
    expect(() =>
      expandPlaybook(BUG_BACKLOG_CLEANUP_PLAYBOOK, {
        backlog_name: "Launch bugs",
        root: "/repo",
        batch_size: 51,
        quality_command: "pnpm test",
      }),
    ).toThrow(/numeric bounds/);
    const result = expandPlaybook(BUG_BACKLOG_CLEANUP_PLAYBOOK, {
      backlog_name: "Launch bugs",
      root: "/repo",
      batch_size: 50,
      quality_command: "pnpm test",
    });
    expect(result.tasks.find((task) => task.key === "verify_backlog_batch")?.dependencyIds).toEqual([
      "bug_backlog_cleanup:1:repair_primary_clusters",
      "bug_backlog_cleanup:1:repair_secondary_clusters",
    ]);
  });

  it("contains briefings only and no reusable identity or memory fields", () => {
    const forbidden = new Set([
      "persona",
      "personality",
      "memory",
      "systemPrompt",
      "developerInstructions",
    ]);
    const walk = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      return Object.entries(value).some(
        ([key, child]) => forbidden.has(key) || walk(child),
      );
    };
    expect(BUILTIN_PLAYBOOKS.some(walk)).toBe(false);
  });
});
