// Pure report-item classification (Phase 6 live-fix). An `expect_report`
// turn ends with a schema-forced JSON report as its final assistant message
// (lib/orchestrator/report.ts). The Conductor parses it machine-side — the
// SESSION transcript however must render it as a readable report card, never
// as raw JSON. Two pure helpers, unit-tested:
//   · `reportItemIdOf` — which item the vibe controller stamps `report: true`
//     on when a schema turn COMPLETES (the last assistant message, and only
//     when its text genuinely parses as a report — no false alarms)
//   · `reportForItem` — the AUTHORITY gate: parsed only for a final stamped
//     item (attention/Mission logic consumes this)
//   · `reportPreviewForItem` — PRESENTATION only: turns any valid report-
//     shaped assistant update into readable UI instead of raw JSON

import { parseAgentReport, type AgentReport } from "@/lib/orchestrator/report";
import type { VibeItem } from "@/types";

/**
 * The transcript item carrying a completed `expect_report` turn's report:
 * the LAST assistant message in the feed — the `outputSchema` constrains
 * exactly the turn's final message, so an earlier assistant message is never
 * the report. Returns its id only when the text parses as a valid
 * AgentReport (a schema turn that somehow ended without report JSON stays
 * unmarked and renders as plain text). Null = nothing to mark.
 */
export function reportItemIdOf(
  order: readonly string[],
  items: Readonly<Record<string, VibeItem>>,
): string | null {
  for (let i = order.length - 1; i >= 0; i--) {
    const it = items[order[i]];
    if (it?.kind !== "assistant") continue;
    // only the last assistant message can be the schema-forced report —
    // if it doesn't parse, there is no report item in this turn
    return parseAgentReport(it.text) ? it.id : null;
  }
  return null;
}

/**
 * The parsed report an item renders as a card — non-null ONLY when the item
 * is an assistant message stamped `report: true` (the final message of a
 * completed `expect_report` turn) whose text still parses. Everything else
 * (unstamped JSON-looking text, streaming messages, stale/edited payloads)
 * falls back to the normal assistant rendering.
 */
export function reportForItem(item: VibeItem): AgentReport | null {
  if (item.kind !== "assistant" || !item.report || item.streaming) return null;
  return parseAgentReport(item.text);
}

/**
 * Presentation-only parser for schema-shaped intermediate updates. Codex may
 * emit a valid `{done:false,...}` status before the controller stamps the
 * final report. Rendering it as a progress card is safe; it does NOT grant
 * report authority and must never feed attention, settlement or evidence.
 */
export function reportPreviewForItem(item: VibeItem): AgentReport | null {
  if (item.kind !== "assistant") return null;
  return parseAgentReport(item.text);
}
