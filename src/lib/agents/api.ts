// Typed wrappers around the custom-agent Tauri commands (native-only direct
// invoke, like lib/worktree.ts and lib/orchestrator/memory.ts). The agent
// folders under `~/.swarmz/agents/` are the source of truth; Rust owns the
// caps, atomic writes and slug guards.

import { invoke } from "@tauri-apps/api/core";
import type {
  AgentDef,
  AgentDetail,
  AgentMemoryAppend,
  AgentMemoryEntry,
  AgentSummary,
  CompiledAgentContext,
} from "./types";

/** Discover every agent (library cards). Broken agents are skipped in Rust. */
export function listAgents(): Promise<AgentSummary[]> {
  return invoke<AgentSummary[]>("agent_list");
}

/** Full detail for one agent (editor): def + soul + memory + knowledge files. */
export function readAgent(slug: string): Promise<AgentDetail> {
  return invoke<AgentDetail>("agent_read", { slug });
}

/** Create a new agent folder. Rejects if the slug already exists. */
export function createAgent(
  def: AgentDef,
  soul: string,
): Promise<AgentDetail> {
  return invoke<AgentDetail>("agent_create", { def, soul });
}

/** Overwrite an existing agent's agent.json + soul.md (editor Save). */
export function writeAgent(
  slug: string,
  def: AgentDef,
  soul: string,
): Promise<AgentDetail> {
  return invoke<AgentDetail>("agent_write", { slug, def, soul });
}

/** Delete an agent folder (idempotent, slug-guarded in Rust). */
export function deleteAgent(slug: string): Promise<void> {
  return invoke<void>("agent_delete", { slug });
}

/** Append one fact to an agent's own memory.md; Rust enforces the caps. */
export function appendAgentMemory(
  slug: string,
  text: string,
): Promise<AgentMemoryAppend> {
  return invoke<AgentMemoryAppend>("agent_memory_append", { slug, text });
}

/** Remove one memory entry by index; returns the remaining entries. */
export function removeAgentMemory(
  slug: string,
  index: number,
): Promise<AgentMemoryEntry[]> {
  return invoke<AgentMemoryEntry[]>("agent_memory_remove", { slug, index });
}

/** Compile an agent's runtime context (Phase-B start pipeline preview). */
export function compileAgentContext(
  slug: string,
): Promise<CompiledAgentContext> {
  return invoke<CompiledAgentContext>("agent_compile_context", { slug });
}

/**
 * Compile + write the agent's context to `<dir>/.compiled.md` and return the
 * absolute path. The terminal start-ways read the persona from this file:
 * Claude via `--append-system-prompt-file <path>`, Codex via
 * `-c developer_instructions="$(cat <path>)"`. Rewritten fresh on every start.
 */
export function writeAgentCompiled(slug: string): Promise<string> {
  return invoke<string>("agent_write_compiled", { slug });
}

/**
 * The Agent-Builder developer-instructions (Phase C) for a new-agent (or
 * refine) Vibe session whose cwd is the agent's own folder. `refine` switches
 * the opening: a fresh build starts the question round, a refine reads the
 * existing files first and edits them surgically.
 */
export function agentBuilderInstructions(
  slug: string,
  refine: boolean,
): Promise<string> {
  return invoke<string>("agent_builder_instructions", { slug, refine });
}
