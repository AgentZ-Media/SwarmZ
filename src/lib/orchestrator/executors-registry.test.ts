import { describe, expect, it } from "vitest";
import {
  composeExecutorRegistry,
  EXECUTOR_TOOL_NAMES,
} from "./executor-registry";
import { executors } from "./executors";
import type { ToolExecutor } from "./executor-types";

const noop: ToolExecutor = async () => null;

describe("Conductor executor registry", () => {
  it("matches all 34 native tool names exactly", () => {
    expect(EXECUTOR_TOOL_NAMES).toEqual([
      "fleet_snapshot", "read_agent", "read_project_docs", "read_notes",
      "git_status", "list_files", "read_file", "list_projects", "list_models",
      "spawn_agents", "prompt_agent", "interrupt_agent", "close_agent",
      "set_agent_config", "review_agent", "decide_approval", "create_worktree",
      "assign_worktree", "worktree_status", "cleanup_worktree", "set_timer",
      "list_timers", "cancel_timer", "write_plan", "list_plans", "read_plan",
      "github_status", "list_prs", "read_pr", "create_pr", "review_pr",
      "comment_pr", "watch_pr", "remember",
    ]);
    expect(Object.keys(executors)).toEqual(EXECUTOR_TOOL_NAMES);
    expect(Object.values(executors).every((executor) => typeof executor === "function"))
      .toBe(true);
  });

  it("routes representative family guards through the facade", async () => {
    const context = { chatId: "chat", projectId: null };
    await expect(executors.remember({}, context)).rejects.toThrow(
      "text must not be empty",
    );
    await expect(executors.create_worktree({}, context)).rejects.toThrow(
      "needs a project context",
    );
    await expect(executors.list_files({}, context)).rejects.toThrow(
      "needs a project context",
    );
  });

  it("rejects duplicate, missing and unexpected family registrations", () => {
    const complete = Object.fromEntries(
      EXECUTOR_TOOL_NAMES.map((name) => [name, noop]),
    );
    expect(() => composeExecutorRegistry([complete, { remember: noop }])).toThrow(
      "duplicate Conductor executor: remember",
    );
    const { remember: _remember, ...missing } = complete;
    expect(() => composeExecutorRegistry([missing])).toThrow("missing: remember");
    expect(() => composeExecutorRegistry([{ ...complete, alien: noop }])).toThrow(
      "unexpected: alien",
    );
  });
});
