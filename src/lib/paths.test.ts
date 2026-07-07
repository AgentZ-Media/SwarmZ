import { describe, expect, it } from "vitest";
import {
  basename,
  dirname,
  elideMiddle,
  isPathHref,
  pathPillLabel,
  splitLineSuffix,
  splitTextWithPaths,
} from "./paths";

/** Just the detected path strings, for terse assertions. */
function paths(text: string): string[] {
  return splitTextWithPaths(text)
    .filter((s) => s.path)
    .map((s) => s.text);
}

describe("splitTextWithPaths", () => {
  it("detects absolute paths", () => {
    expect(paths("open /Users/timo/foo.ts please")).toEqual([
      "/Users/timo/foo.ts",
    ]);
  });

  it("detects home-relative paths", () => {
    expect(paths("see ~/Desktop/Code/SwarmZ next")).toEqual([
      "~/Desktop/Code/SwarmZ",
    ]);
  });

  it("detects multiple paths in one run", () => {
    expect(paths("moved /a/b.txt to ~/c/d")).toEqual(["/a/b.txt", "~/c/d"]);
  });

  it("ignores prose slashes and single-segment paths", () => {
    expect(paths("read/write access to /etc only")).toEqual([]);
    expect(paths("and/or maybe")).toEqual([]);
  });

  it("does not match inside URLs", () => {
    expect(paths("visit https://example.com/a/b now")).toEqual([]);
  });

  it("detects bare relative paths with a file extension", () => {
    expect(paths("hier als Beispiel src-tauri/src/codex/sessions.rs:407")).toEqual([
      "src-tauri/src/codex/sessions.rs:407",
    ]);
    expect(paths("see docs/ARCHITECTURE.md for details")).toEqual([
      "docs/ARCHITECTURE.md",
    ]);
    expect(paths("dotfolder .claude/settings.json works")).toEqual([
      ".claude/settings.json",
    ]);
  });

  it("rejects relative lookalikes: packages, domains, extension-less dirs", () => {
    // scoped npm package — the @ lookbehind rejects it
    expect(paths("install @git-diff-view/react today")).toEqual([]);
    // domain-shaped first segment (dot inside a directory segment)
    expect(paths("open example.com/file.ts now")).toEqual([]);
    // no file extension on the last segment → prose
    expect(paths("the src/components folder")).toEqual([]);
  });

  it("hands trailing sentence punctuation back to the prose", () => {
    const segs = splitTextWithPaths("edit /a/b/c.ts.");
    expect(segs).toEqual([
      { path: false, text: "edit " },
      { path: true, text: "/a/b/c.ts" },
      { path: false, text: "." },
    ]);
  });

  it("keeps a path inside parentheses clean", () => {
    expect(paths("(/src/lib/paths.ts)")).toEqual(["/src/lib/paths.ts"]);
  });

  it("leaves a lone slash or tilde as prose", () => {
    expect(paths("the / key and ~ symbol")).toEqual([]);
    expect(splitTextWithPaths("just text")).toEqual([
      { path: false, text: "just text" },
    ]);
  });

  it("absorbs a trailing :line into the path", () => {
    expect(paths("see /Users/timo/foo.ts:201 here")).toEqual([
      "/Users/timo/foo.ts:201",
    ]);
  });

  it("absorbs a :line:col location", () => {
    expect(paths("at ~/a/b.ts:12:5 exactly")).toEqual(["~/a/b.ts:12:5"]);
  });

  it("does not greedily span whitespace", () => {
    expect(paths("edit /a/b.ts then /c/d.ts")).toEqual([
      "/a/b.ts",
      "/c/d.ts",
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(splitTextWithPaths("")).toEqual([]);
  });

  it("reassembles to the original text", () => {
    const text = "moved /a/b.txt and ~/c/d, then read/write /x here.";
    expect(splitTextWithPaths(text).map((s) => s.text).join("")).toBe(text);
  });
});

describe("basename / dirname", () => {
  it("splits a path", () => {
    expect(basename("/Users/timo/foo.ts")).toBe("foo.ts");
    expect(dirname("/Users/timo/foo.ts")).toBe("/Users/timo/");
    expect(basename("~/Desktop/Code")).toBe("Code");
    expect(dirname("~/Desktop/Code")).toBe("~/Desktop/");
  });

  it("handles a trailing slash", () => {
    expect(basename("/a/b/")).toBe("b");
  });
});

describe("splitLineSuffix", () => {
  it("splits off a :line", () => {
    expect(splitLineSuffix("/a/foo.ts:201")).toEqual({
      path: "/a/foo.ts",
      line: "201",
    });
  });

  it("keeps only the line from :line:col", () => {
    expect(splitLineSuffix("/a/foo.ts:12:5")).toEqual({
      path: "/a/foo.ts",
      line: "12",
    });
  });

  it("leaves a plain path untouched", () => {
    expect(splitLineSuffix("/a/foo.ts")).toEqual({
      path: "/a/foo.ts",
      line: null,
    });
  });

  it("ignores a trailing colon with no number", () => {
    expect(splitLineSuffix("/a/foo.ts:")).toEqual({
      path: "/a/foo.ts:",
      line: null,
    });
  });
});

describe("pathPillLabel", () => {
  it("shows basename + :line", () => {
    expect(pathPillLabel("/Users/timo/placement.ts:201")).toEqual({
      base: "placement.ts",
      line: "201",
    });
  });

  it("drops the column, keeps the line", () => {
    expect(pathPillLabel("~/a/b/file.ts:12:5")).toEqual({
      base: "file.ts",
      line: "12",
    });
  });

  it("shows just the basename when there is no line", () => {
    expect(pathPillLabel("/Users/timo/foo.ts")).toEqual({
      base: "foo.ts",
      line: null,
    });
  });
});

describe("isPathHref", () => {
  it("accepts absolute and home-relative paths", () => {
    expect(isPathHref("/Users/timo/foo.ts:9")).toBe(true);
    expect(isPathHref("~/Desktop/foo.ts")).toBe(true);
  });

  it("rejects URLs and bare fragments", () => {
    expect(isPathHref("https://example.com/a/b")).toBe(false);
    expect(isPathHref("mailto:me@x.com")).toBe(false);
    expect(isPathHref("#anchor")).toBe(false);
    expect(isPathHref("foo/bar")).toBe(false);
  });
});

describe("elideMiddle", () => {
  it("keeps short strings intact", () => {
    expect(elideMiddle("/a/b", 32)).toBe("/a/b");
  });

  it("elides the middle of long strings", () => {
    const out = elideMiddle("/Users/timo/very/deep/nested/path/file.ts", 20);
    expect(out).toContain("…");
    expect(out.length).toBeLessThanOrEqual(20);
  });
});
