import { describe, expect, it } from "vitest";
import {
  activityCountLabel,
  groupChatMessages,
  isSingleStepActivity,
  systemPingKind,
  toolActivityLabel,
} from "./tool-labels";
import type { OrchestratorChatMessage } from "@/types";

describe("toolActivityLabel", () => {
  it("maps the known tools to human verbs", () => {
    expect(toolActivityLabel("fleet_snapshot")).toBe("Checked the fleet");
    expect(toolActivityLabel("read_project_docs")).toBe("Read project docs");
    expect(toolActivityLabel("read_notes")).toBe("Read notes");
    expect(toolActivityLabel("git_status")).toBe("Checked git");
    expect(toolActivityLabel("list_projects")).toBe("Looked up projects");
    expect(toolActivityLabel("list_blueprints")).toBe("Looked up models");
    expect(toolActivityLabel("create_workspace")).toBe("Created workspace");
    expect(toolActivityLabel("remember")).toBe("Noted to memory");
  });

  it("weaves in the pane/session name for transcript + prompt", () => {
    expect(toolActivityLabel("read_transcript", { names: ["api"] })).toBe(
      "Read «api»",
    );
    expect(toolActivityLabel("prompt_pane", { names: ["worker-2"] })).toBe(
      "Prompted «worker-2»",
    );
    // no name resolved yet → generic
    expect(toolActivityLabel("read_transcript")).toBe("Read a transcript");
    expect(toolActivityLabel("prompt_pane")).toBe("Prompted an agent");
  });

  it("pluralizes create_panes by count", () => {
    expect(toolActivityLabel("create_panes", { count: 1 })).toBe(
      "Started 1 agent",
    );
    expect(toolActivityLabel("create_panes", { count: 3 })).toBe(
      "Started 3 agents",
    );
    expect(toolActivityLabel("create_panes")).toBe("Started agents");
  });

  it("falls back for unknown tools", () => {
    expect(toolActivityLabel("some_new_tool")).toBe("Used a tool");
  });
});

describe("activityCountLabel", () => {
  it("pluralizes steps", () => {
    expect(activityCountLabel(1)).toBe("1 step");
    expect(activityCountLabel(6)).toBe("6 steps");
  });
});

describe("isSingleStepActivity", () => {
  it("is true only for a lone step (renders as a quiet line)", () => {
    expect(isSingleStepActivity([tool("t1", "fleet_snapshot")])).toBe(true);
    expect(
      isSingleStepActivity([
        tool("t1", "fleet_snapshot"),
        tool("t2", "git_status"),
      ]),
    ).toBe(false);
  });
});

describe("systemPingKind", () => {
  it("classifies the controller's ping wording", () => {
    expect(systemPingKind("«api» finished")).toBe("finished");
    expect(systemPingKind("«api» waiting for input")).toBe("waiting");
  });
  it("is case-insensitive", () => {
    expect(systemPingKind("Pane FINISHED its work")).toBe("finished");
  });
  it("prefers waiting when both words appear", () => {
    expect(systemPingKind("finished, now waiting")).toBe("waiting");
  });
  it("falls back to info for unknown wording", () => {
    expect(systemPingKind("«api» reached a checkpoint")).toBe("info");
  });
});

const tool = (id: string, name: string): OrchestratorChatMessage => ({
  id,
  at: 0,
  role: "tool",
  tool: name,
  argsSummary: "",
});
const user = (id: string): OrchestratorChatMessage => ({
  id,
  at: 0,
  role: "user",
  text: "hi",
});
const asst = (id: string): OrchestratorChatMessage => ({
  id,
  at: 0,
  role: "assistant",
  text: "ok",
});

describe("groupChatMessages", () => {
  it("folds consecutive tool calls into one activity group", () => {
    const groups = groupChatMessages([
      user("u1"),
      tool("t1", "fleet_snapshot"),
      tool("t2", "git_status"),
      asst("a1"),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["message", "activity", "message"]);
    const activity = groups[1];
    if (activity.kind !== "activity") throw new Error("expected activity");
    expect(activity.tools).toHaveLength(2);
    expect(activity.id).toBe("t1"); // keyed on the first tool
  });

  it("keeps non-adjacent tool calls in separate groups", () => {
    const groups = groupChatMessages([
      tool("t1", "fleet_snapshot"),
      asst("a1"),
      tool("t2", "git_status"),
    ]);
    expect(groups.map((g) => g.kind)).toEqual([
      "activity",
      "message",
      "activity",
    ]);
  });

  it("passes a pure message list through unchanged", () => {
    const groups = groupChatMessages([user("u1"), asst("a1")]);
    expect(groups.map((g) => g.kind)).toEqual(["message", "message"]);
  });

  it("handles an empty list", () => {
    expect(groupChatMessages([])).toEqual([]);
  });
});
