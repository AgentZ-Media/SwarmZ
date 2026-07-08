import { describe, expect, it } from "vitest";
import { injectAgentIntoStartup, shellQuote } from "./startup";

const PATH = "/Users/me/.swarmz/agents/youtube-coach/.compiled.md";

describe("injectAgentIntoStartup", () => {
  it("appends --append-system-prompt-file for claude", () => {
    expect(
      injectAgentIntoStartup("claude --dangerously-skip-permissions", "claude", PATH),
    ).toBe(
      `claude --dangerously-skip-permissions --append-system-prompt-file '${PATH}'`,
    );
  });

  it("appends -c developer_instructions command-substitution for codex", () => {
    expect(
      injectAgentIntoStartup("codex --no-alt-screen", "codex", PATH),
    ).toBe(`codex --no-alt-screen -c developer_instructions="$(cat '${PATH}')"`);
  });

  it("leaves shell startups untouched", () => {
    expect(injectAgentIntoStartup("", "shell", PATH)).toBe("");
    expect(injectAgentIntoStartup("htop", "shell", PATH)).toBe("htop");
  });

  it("is a no-op when there is no compiled path (no-agent path unchanged)", () => {
    expect(injectAgentIntoStartup("claude", "claude", "")).toBe("claude");
    expect(injectAgentIntoStartup("codex", "codex", "")).toBe("codex");
  });

  it("escapes single quotes in the path", () => {
    const weird = "/tmp/o'brien/.compiled.md";
    expect(shellQuote(weird)).toBe(`'/tmp/o'\\''brien/.compiled.md'`);
    expect(injectAgentIntoStartup("claude", "claude", weird)).toBe(
      `claude --append-system-prompt-file '/tmp/o'\\''brien/.compiled.md'`,
    );
  });
});
