// Human, English activity labels for orchestrator tool calls — the chat UI
// never shows raw tool names anymore (the redesign's "human-readable" rule).
// Pure functions so the mapping + grouping are unit-tested; the raw tool name
// and args summary survive as a tooltip in the view (second level).

import type { OrchestratorChatMessage } from "@/types";

type ToolMessage = Extract<OrchestratorChatMessage, { role: "tool" }>;

/**
 * Turn a tool call into a human activity verb (English, UI-copy rule). Names
 * and counts come from the message's resolved `paneRefs` (transcript/prompt
 * targets, freshly-created panes) — never from the raw tool name.
 */
export function toolActivityLabel(
  tool: string,
  opts: { names?: string[]; count?: number } = {},
): string {
  const first = opts.names?.[0];
  const n = opts.count ?? opts.names?.length ?? 0;
  switch (tool) {
    case "fleet_snapshot":
      return "Checked the fleet";
    case "read_agent":
      return first ? `Read «${first}»` : "Read a transcript";
    case "read_project_docs":
      return "Read project docs";
    case "read_notes":
      return "Read notes";
    case "git_status":
      return "Checked git";
    case "list_files":
      return "Listed project files";
    case "read_file":
      return "Read a file";
    case "list_projects":
      return "Looked up projects";
    case "prompt_agent":
      return first ? `Prompted «${first}»` : "Prompted an agent";
    case "spawn_agents":
      return n > 0
        ? `Spawned ${n} agent${n === 1 ? "" : "s"}`
        : "Spawned agents";
    case "interrupt_agent":
      return first ? `Stopped «${first}»` : "Stopped an agent";
    case "close_agent":
      return first ? `Closed «${first}»` : "Closed an agent";
    case "set_agent_config":
      return first ? `Retuned «${first}»` : "Retuned an agent";
    case "review_agent":
      return first ? `Reviewed «${first}»` : "Ran a code review";
    case "decide_approval":
      return first ? `Decided an approval for «${first}»` : "Decided an approval";
    case "create_worktree":
      return "Created a worktree";
    case "assign_worktree":
      return first ? `Moved «${first}» to a worktree` : "Assigned a worktree";
    case "worktree_status":
      return "Checked worktrees";
    case "cleanup_worktree":
      return "Cleaned up a worktree";
    case "set_timer":
      return "Set a timer";
    case "list_timers":
      return "Checked timers";
    case "cancel_timer":
      return "Cancelled a timer";
    case "write_plan":
      return "Wrote a plan";
    case "list_plans":
      return "Checked plans";
    case "read_plan":
      return "Read a plan";
    case "remember":
      return "Noted to memory";
    // GitHub (Phase 7): the outward-facing actions especially must be
    // legible in the audit trail — never a generic "Used a tool"
    case "github_status":
      return "Checked GitHub";
    case "list_prs":
      return "Checked pull requests";
    case "read_pr":
      return "Read a pull request";
    case "create_pr":
      return "Opened a pull request";
    case "review_pr":
      return "Reviewed a pull request";
    case "comment_pr":
      return "Commented on a pull request";
    case "watch_pr":
      return "Updated a PR watch";
    default:
      return "Used a tool";
  }
}

/** Label for a whole activity block header, e.g. "6 steps" / "1 step". */
export function activityCountLabel(n: number): string {
  return `${n} step${n === 1 ? "" : "s"}`;
}

/**
 * Rendering decision for a folded activity group: a lone step renders as one
 * quiet line (status icon + verb, details in a tooltip) instead of the bulky
 * "Worked · 1 step" disclosure; multiple steps keep the collapsible group.
 * Pure so the decision is unit-tested.
 */
export function isSingleStepActivity(tools: { length: number }): boolean {
  return tools.length === 1;
}

/**
 * Classify a status-ping system message purely from its text so the view can
 * give it the same iconography as an activity step (✓ finished / ⚑ waiting).
 * Presentation-only: the message format is owned by the controller — this reads
 * it, it never rewrites it. Unknown/future ping wording falls back to "info"
 * (a neutral marker) so no ping ever renders iconless.
 */
export function systemPingKind(text: string): "finished" | "waiting" | "info" {
  const t = text.toLowerCase();
  if (t.includes("waiting")) return "waiting";
  if (t.includes("finished")) return "finished";
  return "info";
}

/**
 * A render group for the chat list: either a single non-tool message, or a run
 * of consecutive tool calls folded into one activity block. Presentation only
 * — the underlying chat-store message list is never mutated.
 */
export type ChatRenderGroup =
  | { kind: "message"; msg: OrchestratorChatMessage }
  | { kind: "activity"; id: string; tools: ToolMessage[] };

/** Fold consecutive `tool` messages into one activity group (t3code pattern). */
export function groupChatMessages(
  messages: OrchestratorChatMessage[],
): ChatRenderGroup[] {
  const groups: ChatRenderGroup[] = [];
  let run: ToolMessage[] = [];
  const flush = () => {
    if (run.length) {
      groups.push({ kind: "activity", id: run[0].id, tools: run });
      run = [];
    }
  };
  for (const msg of messages) {
    if (msg.role === "tool") {
      run.push(msg);
    } else {
      flush();
      groups.push({ kind: "message", msg });
    }
  }
  flush();
  return groups;
}
