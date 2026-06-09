export type AgentStatus = "starting" | "running" | "attention" | "exited";

export interface ModelUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  message_count: number;
  cost_usd: number;
}

export interface SessionUsage {
  session_id: string;
  cwd: string | null;
  primary_model: string | null;
  service_tier: string | null;
  git_branch: string | null;
  last_activity: string | null;
  message_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  by_model: ModelUsage[];
}

/**
 * Persisted snapshot of one claude session launched inside SwarmZ.
 * Survives app restarts so global usage stats cover all-time activity,
 * independent of the ~/.claude JSONL files still existing.
 */
export interface UsageHistoryEntry {
  session_id: string;
  agent_name: string;
  cwd: string | null;
  started_at: number;
  last_updated: number;
  message_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  by_model: ModelUsage[];
}

export interface UsageTotals {
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  message_count: number;
  session_count: number;
  by_model: ModelUsage[];
}

export interface Profile {
  id: string;
  name: string;
  /** command typed into the shell on spawn, e.g. `claude --dangerously-skip-permissions` */
  startup: string;
  defaultCwd?: string;
  color: string;
}

export interface Agent {
  id: string;
  name: string;
  cwd?: string;
  startup: string;
  color: string;
  status: AgentStatus;
  attention: boolean;
  createdAt: number;
  profileId?: string;
  usage?: SessionUsage;
  /** latched once this agent's own claude session file is discovered */
  sessionId?: string;
}

// ---- Tiling layout tree ----
export interface PaneNode {
  type: "pane";
  id: string;
  agentId: string;
}

export interface SplitNode {
  type: "split";
  id: string;
  direction: "row" | "column"; // row = side-by-side, column = stacked
  /** flex-grow weights, one per child, summing is not required */
  sizes: number[];
  children: LayoutNode[];
}

export type LayoutNode = PaneNode | SplitNode;
