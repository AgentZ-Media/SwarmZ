import { describe, expect, it } from "vitest";
import { agentListForModel } from "./agents";
import type { AgentSummary } from "@/lib/agents/types";

function summary(over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    name: "YouTube Coach",
    slug: "youtube-coach",
    emoji: "📺",
    accent: "#c48a8a",
    role: "strategy & scripts",
    tone: "direct",
    principles: [],
    defaultRuntime: "vibe",
    createdAt: "2026-07-08T09:00:00Z",
    description: "You coach a developer-audience channel.",
    memoryCount: 2,
    memoryMax: 40,
    knowledgeCount: 1,
    dir: "/home/x/.swarmz/agents/youtube-coach",
    ...over,
  };
}

describe("agentListForModel", () => {
  it("compacts an agent to the model-facing shape", () => {
    const [row] = agentListForModel([summary()]);
    expect(row).toEqual({
      slug: "youtube-coach",
      name: "YouTube Coach",
      role: "strategy & scripts",
      description: "You coach a developer-audience channel.",
      default_runtime: "vibe",
      default_model: null,
      default_access: null,
      memory_entries: 2,
      knowledge_files: 1,
    });
  });

  it("falls back to the role when there is no soul description, and carries defaults", () => {
    const [row] = agentListForModel([
      summary({
        description: "   ",
        role: "podcast editor",
        defaultModel: " gpt-5-codex ",
        defaultAccess: "full",
        defaultRuntime: "codex",
      }),
    ]);
    expect(row.description).toBe("podcast editor");
    expect(row.default_model).toBe("gpt-5-codex");
    expect(row.default_access).toBe("full");
    expect(row.default_runtime).toBe("codex");
  });

  it("nulls an empty role", () => {
    const [row] = agentListForModel([summary({ role: "  ", description: "blurb" })]);
    expect(row.role).toBeNull();
    expect(row.description).toBe("blurb");
  });
});
