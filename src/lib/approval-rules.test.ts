import { describe, expect, it } from "vitest";
import {
  approvalPatternFromPayload,
  normalizeApprovalRules,
  validApprovalPattern,
} from "./approval-rules";

describe("approval rules", () => {
  it("accepts bounded argv-prefix patterns", () => {
    expect(validApprovalPattern(["pnpm", "test"])).toBe(true);
    expect(validApprovalPattern([])).toBe(false);
    expect(validApprovalPattern(["pnpm", "bad\narg"])).toBe(false);
  });

  it("extracts only structured Codex proposals", () => {
    expect(
      approvalPatternFromPayload({
        proposedExecpolicyAmendment: ["cargo", "test"],
      }),
    ).toEqual(["cargo", "test"]);
    expect(approvalPatternFromPayload({ proposedExecpolicyAmendment: "cargo" })).toBeNull();
  });

  it("sanitizes and deduplicates persisted rules", () => {
    expect(
      normalizeApprovalRules([
        { id: "a", pattern: ["pnpm", "test"], createdAt: 1 },
        { id: "b", pattern: ["pnpm", "test"], createdAt: 2 },
        { id: "bad", pattern: [], createdAt: 3 },
      ]),
    ).toEqual([{ id: "a", pattern: ["pnpm", "test"], createdAt: 1 }]);
  });
});
