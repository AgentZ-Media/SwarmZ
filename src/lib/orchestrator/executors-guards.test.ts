// Pure security guards of the orchestrator executors: the Conductor may never
// grant full access (T1), an agent name is single-line-sanitized before it
// lands in untrusted autonomous wires (T6), and a remote URL is stripped of
// userinfo so a PAT can't leak to the model (T7).

import { describe, expect, it } from "vitest";
import {
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
