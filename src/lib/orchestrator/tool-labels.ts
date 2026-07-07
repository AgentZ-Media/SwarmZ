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
    case "read_transcript":
      return first ? `Read «${first}»` : "Read a transcript";
    case "read_project_docs":
      return "Read project docs";
    case "read_notes":
      return "Read notes";
    case "git_status":
      return "Checked git";
    case "list_projects":
      return "Looked up projects";
    case "list_blueprints":
      return "Looked up models";
    case "prompt_pane":
      return first ? `Prompted «${first}»` : "Prompted an agent";
    case "create_panes":
      return n > 0 ? `Started ${n} agent${n === 1 ? "" : "s"}` : "Started agents";
    case "create_workspace":
      return "Created workspace";
    case "remember":
      return "Noted to memory";
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
