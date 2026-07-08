// Custom-agent types — the frontend mirror of `src-tauri/src/agents/`. Field
// names arrive camelCase (agent.json is camel-cased on disk + the Rust structs
// use `rename_all = "camelCase"`), so no snake→camel mapping is needed here.

/** The suggested start runtime for an agent. "vibe" = a native Codex session. */
export type AgentDefaultRuntime = "vibe" | "claude" | "codex";

/** agent.json — identity + start defaults. The machine-readable card. */
export interface AgentDef {
  name: string;
  /** folder identity (kebab-case) — authoritative */
  slug: string;
  emoji: string;
  /** identity color (hex) — IDENTITY, never status */
  accent: string;
  /** short role line, e.g. "strategy & scripts" */
  role: string;
  /** voice / directness hint */
  tone: string;
  principles: string[];
  defaultRuntime: AgentDefaultRuntime;
  defaultModel?: string;
  defaultEffort?: string;
  defaultAccess?: string;
  createdAt: string;
}

/** One curated memory entry (mirrors the Rust `MemoryEntry`). */
export interface AgentMemoryEntry {
  /** ISO date the entry was stored (may be empty for hand-edited lines) */
  date: string;
  text: string;
}

/** Result of `agent_memory_append` (mirrors the orchestrator append result). */
export interface AgentMemoryAppend {
  stored: boolean;
  dropped: number;
  total: number;
  note: string;
}

/** A library-card summary: def + on-disk-derived counts + a soul blurb. */
export interface AgentSummary extends AgentDef {
  /** one-line blurb lifted from soul.md */
  description: string;
  memoryCount: number;
  memoryMax: number;
  knowledgeCount: number;
  /** absolute folder path (for the Files reveal action) */
  dir: string;
}

/** Full detail for the editor (mirrors the Rust `AgentDetail`). */
export interface AgentDetail extends AgentDef {
  soul: string;
  memory: AgentMemoryEntry[];
  knowledge: string[];
  dir: string;
}

/** Result of `agent_compile_context` — the Phase-B start pipeline output. */
export interface CompiledAgentContext {
  text: string;
  /** true when `bytes` exceeds the hard budget — nothing was silently trimmed */
  overBudget: boolean;
  bytes: number;
  budget: number;
}

/**
 * Derive a slug from a free-form agent name (New-agent flow). Lowercase,
 * runs of non-alphanumerics → single dashes, trimmed, capped. Mirrors the
 * `is_valid_slug` guard in Rust (which rejects anything this doesn't produce).
 */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}
