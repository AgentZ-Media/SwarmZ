import { describe, expect, it } from "vitest";
import {
  aggregateChangeStats,
  capDiff,
  changeKind,
  changeKindLabel,
  changeStats,
  changeToDiffData,
  diffHash,
  fnv1a32,
  langFromPath,
  parsedFileToDiffData,
  splitUnifiedDiff,
  unifiedDiffStats,
} from "./diff";
import type { VibeFileChange } from "@/types";

describe("fnv1a32 / diffHash", () => {
  it("is deterministic and unsigned", () => {
    const a = fnv1a32("hello");
    expect(a).toBe(fnv1a32("hello"));
    expect(a).toBeGreaterThanOrEqual(0);
  });

  it("differs for different inputs", () => {
    expect(fnv1a32("hello")).not.toBe(fnv1a32("hellp"));
  });

  it("encodes length + hash in base 36", () => {
    expect(diffHash("")).toBe(`0:${(0x811c9dc5 >>> 0).toString(36)}`);
    expect(diffHash("abc")).toBe(`${(3).toString(36)}:${fnv1a32("abc").toString(36)}`);
  });
});

describe("langFromPath", () => {
  it("maps common extensions", () => {
    expect(langFromPath("src/a.ts")).toBe("typescript");
    expect(langFromPath("src/a.tsx")).toBe("tsx");
    expect(langFromPath("main.rs")).toBe("rust");
    expect(langFromPath("styles.css")).toBe("css");
  });

  it("recognises special filenames", () => {
    expect(langFromPath("Dockerfile")).toBe("dockerfile");
    expect(langFromPath("build/Makefile")).toBe("makefile");
    expect(langFromPath("targets.mk")).toBe("makefile");
  });

  it("falls back to plaintext", () => {
    expect(langFromPath("README")).toBe("plaintext");
    expect(langFromPath("data.unknownext")).toBe("plaintext");
  });
});

describe("changeKind / changeKindLabel", () => {
  it("unwraps the tagged kind object", () => {
    expect(changeKind({ type: "add" })).toBe("add");
    expect(changeKind({ type: "delete" })).toBe("delete");
    expect(changeKind(null)).toBe("update");
    expect(changeKind("weird")).toBe("update");
  });

  it("labels known kinds", () => {
    expect(changeKindLabel("add")).toBe("new");
    expect(changeKindLabel("delete")).toBe("del");
    expect(changeKindLabel("rename")).toBe("ren");
    expect(changeKindLabel("update")).toBe("edit");
    expect(changeKindLabel("other")).toBe("other");
  });
});

describe("unifiedDiffStats", () => {
  it("counts +/- body lines, ignoring +++/--- headers", () => {
    const diff = "--- a/x\n+++ b/x\n@@\n+one\n+two\n-gone\n unchanged\n";
    expect(unifiedDiffStats(diff)).toEqual({ add: 2, del: 1 });
  });

  it("handles nullish input", () => {
    expect(unifiedDiffStats(null)).toEqual({ add: 0, del: 0 });
    expect(unifiedDiffStats(undefined)).toEqual({ add: 0, del: 0 });
  });
});

describe("changeStats / aggregateChangeStats", () => {
  it("counts an add as raw content lines", () => {
    const add: VibeFileChange = { path: "n.ts", kind: { type: "add" }, diff: "l1\nl2\n" };
    expect(changeStats(add)).toEqual({ add: 2, del: 0 });
  });

  it("counts an update via its unified diff", () => {
    const upd: VibeFileChange = {
      path: "a.ts",
      kind: { type: "update" },
      diff: "@@\n+added\n+added2\n-removed\n",
    };
    expect(changeStats(upd)).toEqual({ add: 2, del: 1 });
  });

  it("aggregates over multiple changes", () => {
    const changes: VibeFileChange[] = [
      { path: "n.ts", kind: { type: "add" }, diff: "l1\nl2\n" },
      { path: "a.ts", kind: { type: "update" }, diff: "@@\n+x\n-y\n" },
    ];
    expect(aggregateChangeStats(changes)).toEqual({ add: 3, del: 1, files: 2 });
  });
});

describe("capDiff", () => {
  it("passes through when under the cap", () => {
    expect(capDiff("short", 100)).toEqual({ text: "short", truncated: false });
  });

  it("clips on a line boundary and flags truncation", () => {
    const diff = "line one\nline two\nline three\n";
    const out = capDiff(diff, 12);
    expect(out.truncated).toBe(true);
    expect(out.text).toBe("line one");
  });
});

describe("changeToDiffData", () => {
  it("synthesizes a unified add-diff for a new file", () => {
    const add: VibeFileChange = { path: "src/new.ts", kind: { type: "add" }, diff: "a\nb\n" };
    const data = changeToDiffData(add);
    expect(data.newFile?.fileName).toBe("src/new.ts");
    expect(data.hunks).toHaveLength(1);
    expect(data.hunks[0]).toContain("@@ -0,0 +1,2 @@");
    expect(data.hunks[0]).toContain("+a");
    expect(data.hunks[0]).toContain("+b");
  });

  it("passes an update diff through", () => {
    const upd: VibeFileChange = { path: "a.ts", kind: { type: "update" }, diff: "@@\n+x\n" };
    expect(changeToDiffData(upd).hunks).toEqual(["@@\n+x\n"]);
  });
});

describe("splitUnifiedDiff", () => {
  it("splits a multi-file diff on diff --git headers", () => {
    // the second file carries the `index <sha>..<sha>` line codex 0.144+
    // emits in turn/diff/updated (0.142.5 omitted it) — must be tolerated
    const agg =
      "diff --git a/one.ts b/one.ts\n--- a/one.ts\n+++ b/one.ts\n@@\n+a\n-b\n" +
      "diff --git a/two.ts b/two.ts\nnew file mode 100644\nindex 0000000000000000000000000000000000000000..45b983be36b73c0788dc9cbcb76cbb80fc7bb057\n--- /dev/null\n+++ b/two.ts\n@@ -0,0 +1,1 @@\n+hello\n";
    const files = splitUnifiedDiff(agg);
    expect(files.map((f) => f.path)).toEqual(["one.ts", "two.ts"]);
    expect(files[0].kind).toBe("update");
    expect(files[0]).toMatchObject({ add: 1, del: 1 });
    expect(files[1].kind).toBe("add");
    expect(files[1].add).toBe(1);
  });

  it("returns an empty array for empty input", () => {
    expect(splitUnifiedDiff("")).toEqual([]);
    expect(splitUnifiedDiff(null)).toEqual([]);
  });

  it("shapes a parsed file into diff-view data", () => {
    const [file] = splitUnifiedDiff(
      "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@\n+q\n",
    );
    const data = parsedFileToDiffData(file);
    expect(data.newFile?.fileLang).toBe("typescript");
    expect(data.hunks).toEqual([file.diff]);
  });
});
