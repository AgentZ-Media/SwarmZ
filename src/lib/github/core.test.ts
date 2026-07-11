import { describe, expect, it } from "vitest";
import {
  deckPrSignature,
  describeGhUnavailable,
  hasOpenPrForBranch,
  prEventLabel,
  unwrapGh,
} from "./core";
import type { GhPr } from "./types";

function pr(
  number: number,
  head: string,
  checks: Partial<GhPr["checks"]> = {},
): GhPr {
  return {
    number,
    title: `PR ${number}`,
    author: "x",
    head_ref: head,
    base_ref: "main",
    is_draft: false,
    mergeable: "MERGEABLE",
    review_decision: "",
    url: `https://example.com/pull/${number}`,
    updated_at: "",
    checks: { passing: 0, failing: 0, pending: 0, total: 0, ...checks },
  };
}

describe("unwrapGh", () => {
  it("passes ok data through", () => {
    expect(unwrapGh({ status: "ok", data: 7 }, "x")).toBe(7);
  });

  it("throws readable messages for typed degradations", () => {
    expect(() => unwrapGh({ status: "not_installed" }, "list PRs")).toThrow(
      /not installed/,
    );
    expect(() =>
      unwrapGh({ status: "not_authenticated" }, "list PRs"),
    ).toThrow(/gh auth login/);
    expect(() => unwrapGh({ status: "no_remote" }, "list PRs")).toThrow(
      /no GitHub remote/,
    );
    expect(() =>
      unwrapGh({ status: "error", data: "boom" }, "list PRs"),
    ).toThrow(/list PRs failed: boom/);
  });

  it("describes every unavailable state", () => {
    expect(describeGhUnavailable("not_installed")).toContain("brew install gh");
    expect(describeGhUnavailable("not_authenticated")).toContain("gh auth login");
    expect(describeGhUnavailable("no_remote")).toContain("no GitHub remote");
  });
});

describe("hasOpenPrForBranch", () => {
  it("matches by head ref, tolerates missing inputs", () => {
    const prs = [pr(1, "swarm/maya-checkout"), pr(2, "feat/x")];
    expect(hasOpenPrForBranch(prs, "swarm/maya-checkout")).toBe(true);
    expect(hasOpenPrForBranch(prs, "swarm/other")).toBe(false);
    expect(hasOpenPrForBranch(undefined, "x")).toBe(false);
    expect(hasOpenPrForBranch(prs, null)).toBe(false);
    expect(hasOpenPrForBranch([], "x")).toBe(false);
  });
});

describe("deckPrSignature", () => {
  it("is empty without PRs and encodes open/failing/pending", () => {
    expect(deckPrSignature(undefined)).toBe("");
    expect(deckPrSignature([])).toBe("");
    expect(deckPrSignature([pr(1, "a", { passing: 2 })])).toBe("1:0:0");
    expect(
      deckPrSignature([
        pr(1, "a", { failing: 1 }),
        pr(2, "b", { pending: 2 }),
        pr(3, "c", { passing: 3 }),
      ]),
    ).toBe("3:1:1");
    // a PR that both fails and pends counts as failing (worst state wins)
    expect(deckPrSignature([pr(1, "a", { failing: 1, pending: 1 })])).toBe(
      "1:1:0",
    );
  });
});

describe("prEventLabel", () => {
  it("renders the ticker line", () => {
    expect(prEventLabel(12, "checks: 1 failing")).toBe("PR #12 checks: 1 failing");
  });
});
