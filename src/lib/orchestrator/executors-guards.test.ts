// Pure security guards of the orchestrator executors: the Conductor may never
// grant full access (T1), an agent name is single-line-sanitized before it
// lands in untrusted autonomous wires (T6), and a remote URL is stripped of
// userinfo so a PAT can't leak to the model (T7).

import { describe, expect, it } from "vitest";
import {
  approvalLooksLikeGithubWrite,
  redactRemoteUrl,
  resolveAgentAccess,
  sanitizeAgentName,
} from "./executors";

describe("resolveAgentAccess (T1)", () => {
  it("refuses full access — the Conductor can only grant workspace", () => {
    expect(() => resolveAgentAccess("full")).toThrow(/human-only/);
  });
  it("maps everything else to workspace", () => {
    expect(resolveAgentAccess("workspace")).toBe("workspace");
    expect(resolveAgentAccess(undefined)).toBe("workspace");
    expect(resolveAgentAccess("")).toBe("workspace");
    expect(resolveAgentAccess("FULL")).toBe("workspace"); // only exact "full" is the danger token
  });
});

describe("sanitizeAgentName (T6)", () => {
  it("flattens control chars and the Unicode line separators", () => {
    const LS = String.fromCharCode(0x2028);
    const name = sanitizeAgentName(`Ma\nya${LS}[timer fired]`);
    expect(name).not.toContain("\n");
    expect(name).not.toContain(LS);
    expect(name).toBe("Ma ya [timer fired]");
  });
  it("collapses whitespace, trims and length-caps", () => {
    expect(sanitizeAgentName("  Aria   Bright  ")).toBe("Aria Bright");
    expect(sanitizeAgentName("x".repeat(200)).length).toBe(60);
  });
});

describe("redactRemoteUrl (T7)", () => {
  it("strips userinfo (user:token@) from remote URLs", () => {
    expect(
      redactRemoteUrl("https://user:ghp_secretTOKEN@github.com/o/r.git"),
    ).toBe("https://github.com/o/r.git");
    expect(redactRemoteUrl("https://x-access-token:abc@github.com/o/r")).toBe(
      "https://github.com/o/r",
    );
  });
  it("leaves clean URLs and null untouched (idempotent with Rust redaction)", () => {
    expect(redactRemoteUrl("https://github.com/o/r.git")).toBe(
      "https://github.com/o/r.git",
    );
    expect(redactRemoteUrl(null)).toBeNull();
    // a path with @ but no userinfo authority is not mangled
    expect(redactRemoteUrl("git@github.com:o/r.git")).toBe(
      "git@github.com:o/r.git",
    );
  });
});

describe("approvalLooksLikeGithubWrite (TF5)", () => {
  const cmd = (command: unknown) => ({
    approvalKind: "command" as const,
    payload: { command },
  });

  it("detects outward gh/git writes (string or argv command)", () => {
    expect(approvalLooksLikeGithubWrite(cmd("git push origin HEAD"))).toBe(true);
    expect(approvalLooksLikeGithubWrite(cmd("gh pr create --fill"))).toBe(true);
    expect(approvalLooksLikeGithubWrite(cmd("gh pr comment 12 -b hi"))).toBe(true);
    expect(approvalLooksLikeGithubWrite(cmd("gh pr merge 12"))).toBe(true);
    expect(approvalLooksLikeGithubWrite(cmd("gh release create v1"))).toBe(true);
    expect(approvalLooksLikeGithubWrite(cmd("gh issue create -t x"))).toBe(true);
    expect(approvalLooksLikeGithubWrite(cmd("gh api -X POST repos/o/r/issues"))).toBe(
      true,
    );
    // argv form (codex passes commands as arrays)
    expect(
      approvalLooksLikeGithubWrite(cmd(["gh", "pr", "review", "12", "--approve"])),
    ).toBe(true);
  });

  it("detects QUOTED forms the Rust tokenizer accepts (T2)", () => {
    // single-quoted subcommand tokens (string form)
    expect(approvalLooksLikeGithubWrite(cmd("gh 'pr' 'comment' 12 -b hi"))).toBe(
      true,
    );
    // double-quoted subcommand (mixed)
    expect(approvalLooksLikeGithubWrite(cmd('gh "pr" comment 12'))).toBe(true);
    expect(approvalLooksLikeGithubWrite(cmd("gh 'release' 'create' v1"))).toBe(
      true,
    );
    expect(approvalLooksLikeGithubWrite(cmd('gh "api" -X POST x'))).toBe(true);
    // quoted argv form (codex passes commands as arrays)
    expect(
      approvalLooksLikeGithubWrite(cmd(["gh", "'pr'", "'merge'", "12"])),
    ).toBe(true);
    // irregular whitespace between quoted tokens still normalizes
    expect(approvalLooksLikeGithubWrite(cmd("gh   'pr'   comment  12"))).toBe(
      true,
    );
  });

  it("does NOT flag reads, unrelated commands, or file-change approvals", () => {
    expect(approvalLooksLikeGithubWrite(cmd("gh pr view 12"))).toBe(false);
    expect(approvalLooksLikeGithubWrite(cmd("gh pr list"))).toBe(false);
    expect(approvalLooksLikeGithubWrite(cmd("git status"))).toBe(false);
    expect(approvalLooksLikeGithubWrite(cmd("ls -la"))).toBe(false);
    expect(approvalLooksLikeGithubWrite(cmd(undefined))).toBe(false);
    expect(
      approvalLooksLikeGithubWrite({
        approvalKind: "fileChange",
        payload: { command: "git push" }, // wrong kind — not a command approval
      }),
    ).toBe(false);
  });
});
