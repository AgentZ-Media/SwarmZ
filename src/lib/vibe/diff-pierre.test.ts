import { describe, expect, it } from "vitest";
import { toFileDiff } from "./diff-pierre";
import { changeToPatchText, hasFileHeader } from "./diff-patch";
import type { VibeFileChange } from "@/types";

// Patch construction stays engine-independent; one empty-file assertion also
// crosses the lazy renderer boundary and verifies that Pierre can parse it.

describe("hasFileHeader", () => {
  it("accepts a leading diff --git header", () => {
    expect(
      hasFileHeader("diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n"),
    ).toBe(true);
  });

  it("accepts an adjacent ---/+++ pair in the preamble", () => {
    expect(hasFileHeader("--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n")).toBe(
      true,
    );
  });

  it("rejects a bare hunk chunk (headers must be synthesized)", () => {
    expect(hasFileHeader("@@ -1,2 +1,2 @@\n-a\n+b\n")).toBe(false);
  });

  it("is not fooled by a deleted '--- ' content line inside the hunk body", () => {
    // deleting the content line `-- separator` renders as `--- separator`
    const diff = "@@ -1,3 +1,2 @@\n context\n--- separator\n+kept\n";
    expect(hasFileHeader(diff)).toBe(false);
  });

  it("is not fooled by an adjacent ---/+++-looking pair inside the hunk body", () => {
    const diff = "@@ -1,2 +1,2 @@\n--- separator\n+++ added twice\n";
    expect(hasFileHeader(diff)).toBe(false);
  });

  it("rejects a lone '--- ' line without its '+++ ' partner", () => {
    expect(hasFileHeader("--- strange preamble\n@@ -1 +1 @@\n-a\n+b\n")).toBe(
      false,
    );
  });

  it("rejects empty input", () => {
    expect(hasFileHeader("")).toBe(false);
  });
});

describe("changeToPatchText", () => {
  // kinds arrive as tagged objects ({ type: "add" }) — see diff.ts changeKind
  const change = (over: Partial<VibeFileChange>): VibeFileChange => ({
    path: "src/new.ts",
    kind: { type: "add" },
    diff: "",
    ...over,
  });

  it("synthesizes an all-add patch from raw new-file content", () => {
    const patch = changeToPatchText(change({ diff: "one\ntwo\n" }));
    expect(patch).toBe(
      "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n",
    );
  });

  it("emits the git-canonical header-only patch for an EMPTY new file (no bogus @@ -0,0 +1,0 @@ hunk)", () => {
    const patch = changeToPatchText(change({ diff: "" }));
    expect(patch).toBe("--- /dev/null\n+++ b/src/new.ts\n");
    expect(patch).not.toContain("@@");
    // and pierre parses it as a file (renders as "new, empty" — no <pre> fallback)
    expect(toFileDiff(patch)).not.toBeNull();
  });

  it("adds headers to a headerless update chunk", () => {
    const patch = changeToPatchText(
      change({ kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b\n" }),
    );
    expect(patch.startsWith("--- a/src/new.ts\n+++ b/src/new.ts\n@@")).toBe(true);
  });

  it("adds headers even when the hunk body contains a '--- ' content line", () => {
    const patch = changeToPatchText(
      change({ kind: { type: "update" }, diff: "@@ -1,3 +1,2 @@\n context\n--- separator\n+kept\n" }),
    );
    expect(patch.startsWith("--- a/src/new.ts\n+++ b/src/new.ts\n@@")).toBe(true);
  });

  it("passes a fully-headed patch through untouched", () => {
    const headed = "--- a/src/new.ts\n+++ b/src/new.ts\n@@ -1 +1 @@\n-a\n+b\n";
    expect(changeToPatchText(change({ kind: { type: "update" }, diff: headed }))).toBe(
      headed,
    );
  });
});
