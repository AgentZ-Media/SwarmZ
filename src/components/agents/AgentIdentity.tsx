// Agent identity chrome — the emoji + accent dot that marks a pane / session /
// fleet card as running AS a custom agent. accent is IDENTITY, never status
// (DESIGN.md): it never encodes working/needs-you, it just says "this is the
// YouTube Coach". The Signal-Triade colors keep their status meaning elsewhere.
//
// The agent folder on disk is the source of truth, so panes/sessions persist
// only the slug; the emoji/accent/name are looked up from the agent library
// here. `useAgentSummary` lazily loads the library once (idempotent) so the
// identity shows up even before the Agents dialog was ever opened.

import { useEffect } from "react";
import { useAgents } from "@/lib/agents/store";
import type { AgentSummary } from "@/lib/agents/types";

/** Resolve a slug → its library summary, loading the library once if needed. */
export function useAgentSummary(
  slug: string | null | undefined,
): AgentSummary | undefined {
  const ensureAgents = useAgents((s) => s.ensureAgents);
  // stable reference: `.find` returns an existing array element (or undefined),
  // never a freshly-built object — safe as a selector return.
  const summary = useAgents((s) =>
    slug ? s.agents?.find((a) => a.slug === slug) : undefined,
  );
  useEffect(() => {
    if (slug) void ensureAgents();
  }, [slug, ensureAgents]);
  return summary ?? undefined;
}

/**
 * The identity mark for an agent: its emoji (tinted with the accent) or, when
 * it has no emoji, a small accent dot. Sized via `size` (px). Renders nothing
 * when there is no summary.
 */
export function AgentIdentityMark({
  summary,
  size = 12,
}: {
  summary: AgentSummary | undefined;
  size?: number;
}) {
  if (!summary) return null;
  if (summary.emoji) {
    return (
      <span
        className="shrink-0 leading-none"
        style={{ fontSize: size }}
        title={summary.name}
        aria-hidden
      >
        {summary.emoji}
      </span>
    );
  }
  return (
    <span
      className="shrink-0 rounded-full"
      style={{
        width: Math.round(size * 0.6),
        height: Math.round(size * 0.6),
        backgroundColor: summary.accent || "var(--faint)",
      }}
      title={summary.name}
      aria-hidden
    />
  );
}
