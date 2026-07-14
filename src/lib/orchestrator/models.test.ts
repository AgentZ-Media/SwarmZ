import { describe, expect, it } from "vitest";
import {
  catalogModel,
  validateCatalogModelEffort,
  type CodexModelCatalogEntry,
} from "./models";

const catalog: CodexModelCatalogEntry[] = [
  {
    id: "sol",
    model: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    description: "Frontier",
    isDefault: true,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [
      { effort: "low", description: "Fast" },
      { effort: "max", description: "Deep" },
      // Defense-in-depth: even a malformed/unfiltered caller may not use it.
      { effort: "ultra", description: "Multi-agent" },
    ],
  },
  {
    id: "luna",
    model: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    description: "Repeatable",
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [{ effort: "medium", description: "Balanced" }],
  },
];

describe("Codex model catalog selection", () => {
  it("resolves both exact override values and catalog ids", () => {
    expect(catalogModel(catalog, "gpt-5.6-sol")?.id).toBe("sol");
    expect(catalogModel(catalog, "sol")?.model).toBe("gpt-5.6-sol");
  });

  it("accepts advertised model/effort pairs", () => {
    expect(validateCatalogModelEffort(catalog, "sol", "max").model).toBe(
      "gpt-5.6-sol",
    );
  });

  it("rejects unknown models and unsupported efforts", () => {
    expect(() => validateCatalogModelEffort(catalog, "made-up", "low")).toThrow(
      /not in the live Codex catalog/,
    );
    expect(() =>
      validateCatalogModelEffort(catalog, "gpt-5.6-luna", "max"),
    ).toThrow(/not supported/);
  });

  it("always refuses ultra because it is not an effort level", () => {
    expect(() => validateCatalogModelEffort(catalog, "sol", "ultra")).toThrow(
      /multi-agent mode/,
    );
  });
});
