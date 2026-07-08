// Pure shaping of the custom-agent library for the orchestrator's `list_agents`
// tool: an AgentSummary (frontend mirror of the Rust card) → a compact,
// model-facing row. Kept pure (no Tauri/store) so it unit-tests in the vitest
// node env; the executor just calls `listAgents()` and maps through this.

import type { AgentSummary } from "@/lib/agents/types";

/** One agent as the orchestrator model sees it — slug is the create_panes key. */
export interface AgentForModel {
  slug: string;
  name: string;
  /** short role line, or null when the agent has none */
  role: string | null;
  /** one-line blurb (soul first line, falling back to the role) */
  description: string;
  /** "vibe" = start as a native session (create_panes native:true), else a terminal runtime */
  default_runtime: string;
  /** the agent's default model, when it pins one (null = user default) */
  default_model: string | null;
  /** "workspace" | "full" for native sessions, when set */
  default_access: string | null;
  memory_entries: number;
  knowledge_files: number;
}

/** Map discovered agents to the compact list handed to the model. */
export function agentListForModel(agents: AgentSummary[]): AgentForModel[] {
  return agents.map((a) => {
    const role = a.role.trim();
    return {
      slug: a.slug,
      name: a.name,
      role: role || null,
      description: a.description.trim() || role,
      default_runtime: a.defaultRuntime,
      default_model: a.defaultModel?.trim() || null,
      default_access: a.defaultAccess?.trim() || null,
      memory_entries: a.memoryCount,
      knowledge_files: a.knowledgeCount,
    };
  });
}
