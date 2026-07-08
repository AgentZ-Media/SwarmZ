// Pure helpers for the Agent-Builder flow (Phase C). Kept free of Tauri/store
// imports so they unit-test in the vitest node env (like lib/vibe/mention.ts).
// The Rust `agents/builder.rs` owns the developerInstructions; this file only
// owns the small frontend-side flow logic (session naming + the stub def).

import type { AgentDef } from "./types";

/** The Vibe-session title for a Builder run — "Building:"/"Refining:" + name. */
export function builderSessionName(name: string, refine: boolean): string {
  const label = refine ? "Refining" : "Building";
  return `${label}: ${name.trim() || "agent"}`;
}

/**
 * A minimal, valid stub `agent.json` for a brand-new agent. The Builder session
 * overwrites this file (and soul.md) turn by turn — the stub only has to make
 * the folder a discoverable agent immediately. `slug` is authoritative.
 */
export function stubAgentDef(
  name: string,
  slug: string,
  model?: string,
): AgentDef {
  return {
    name: name.trim() || slug,
    slug,
    emoji: "🛠",
    accent: "",
    role: "",
    tone: "",
    principles: [],
    defaultRuntime: "vibe",
    ...(model ? { defaultModel: model } : {}),
    createdAt: "",
  };
}

/** True when `slug` already names an agent in `existing` (collision guard). */
export function slugTaken(slug: string, existing: Iterable<string>): boolean {
  if (!slug) return false;
  for (const s of existing) if (s === slug) return true;
  return false;
}
