// Compact, cheap text rendering of a native Vibe session's transcript for the
// orchestrator's read_agent tool. Pure: items in → text out, no
// React / store — so the executor and unit tests share one implementation.
//
// The goal is DENSE and cheap, like the pane transcript tails: user/assistant
// texts, `$ command → exit N` lines (output only for failed commands, last few
// lines), fileChange as a file list with +N −M, approvals with their status,
// and the plan standing. Reasoning and streaming carets never reach here.

import type { VibeItem } from "@/types";
import { changeStats } from "./diff";

/** Cap one string to a single line, umlaut-safe truncation with an ellipsis. */
function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return [...flat].length > max ? `${[...flat].slice(0, max).join("")}…` : flat;
}

/** Multi-line text, capped by characters (keeps newlines for readability). */
function capText(text: string, max = 600): string {
  const trimmed = text.trim();
  return [...trimmed].length > max
    ? `${[...trimmed].slice(0, max).join("")}…`
    : trimmed;
}

export interface RenderSessionOptions {
  /** render only the last N items (default 20) */
  tail?: number;
  /** output lines kept for a FAILED command's tail (default 5) */
  failOutputLines?: number;
}

/**
 * Render a native session's transcript items into a compact text block. The
 * `tail` limits to the last N items (like the pane transcript's tail_messages).
 */
export function renderSessionTranscript(
  items: VibeItem[],
  options: RenderSessionOptions = {},
): string {
  const tail = options.tail && options.tail > 0 ? Math.floor(options.tail) : 20;
  const failLines =
    options.failOutputLines && options.failOutputLines > 0
      ? Math.floor(options.failOutputLines)
      : 5;
  const slice = items.slice(-tail);
  const lines: string[] = [];

  for (const it of slice) {
    switch (it.kind) {
      case "user":
        lines.push(`user: ${oneLine(it.text)}`);
        break;
      case "assistant":
        if (it.text.trim()) lines.push(`assistant: ${capText(it.text)}`);
        break;
      case "command": {
        const status =
          typeof it.exitCode === "number"
            ? `exit ${it.exitCode}`
            : it.status || "running";
        lines.push(`$ ${oneLine(it.command, 200)} → ${status}`);
        // only surface output for a real failure, and only the last few lines
        if (
          typeof it.exitCode === "number" &&
          it.exitCode !== 0 &&
          it.output.trim()
        ) {
          const outTail = it.output.trimEnd().split("\n").slice(-failLines);
          for (const l of outTail) lines.push(`    ${oneLine(l, 200)}`);
        }
        break;
      }
      case "fileChange": {
        const parts = it.changes.map((c) => {
          const { add, del } = changeStats(c);
          return `${c.path} +${add} −${del}`;
        });
        lines.push(
          `files (${it.status || "changed"}): ${parts.join(", ") || "(none)"}`,
        );
        break;
      }
      case "plan": {
        const done = it.steps.filter((s) => s.status === "completed").length;
        const bits: string[] = [];
        if (it.explanation) bits.push(oneLine(it.explanation, 160));
        if (it.steps.length) bits.push(`${done}/${it.steps.length} steps done`);
        lines.push(`plan: ${bits.join(" — ") || "(empty)"}`);
        break;
      }
      case "webSearch":
        lines.push(`web search: ${oneLine(it.query, 160)}`);
        break;
      case "approval":
        lines.push(`approval (${it.approvalKind}): ${it.status}`);
        break;
      case "warning":
        lines.push(`warning: ${oneLine(it.text, 200)}`);
        break;
    }
  }

  return lines.join("\n");
}
