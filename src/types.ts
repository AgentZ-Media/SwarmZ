export type AgentStatus = "starting" | "running" | "attention" | "exited";

/**
 * Claude Code's own working state, captured from terminal escape sequences:
 * OSC 9;4 progress reporting (busy/idle, emitted because SwarmZ advertises
 * support via ConEmuANSI=ON) and the OSC 21337 tab-status protocol
 * (idle/busy/waiting — dormant in current Claude Code builds, pre-wired here).
 */
export type ClaudeActivity = "busy" | "idle" | "waiting";

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
  /** current context occupancy = full prompt of the latest main-chain turn */
  context_tokens: number;
  /** context window of the model that served that turn (200k, or 1m variants) */
  context_limit: number;
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

/** One rate-limit window of the Claude subscription (5h session, 7d week, …). */
export interface RateLimitWindow {
  /** percent used, 0–100 */
  utilization: number | null;
  /** ISO timestamp when the window resets */
  resets_at: string | null;
}

/**
 * Usage limits of the Claude subscription logged in on this machine,
 * fetched from the Anthropic OAuth usage endpoint with Claude Code's
 * own credentials (Keychain / ~/.claude/.credentials.json).
 */
export interface SubscriptionLimits {
  five_hour: RateLimitWindow | null;
  seven_day: RateLimitWindow | null;
  seven_day_sonnet: RateLimitWindow | null;
  seven_day_opus: RateLimitWindow | null;
}

/** Small app-wide preferences, persisted across restarts. */
export interface AppSettings {
  /** last working directory an agent was launched in — prefilled in the New Agent dialog */
  lastCwd?: string;
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
  /** last terminal title captured from the PTY (claude's auto-generated topic) */
  title?: string;
  /** true once the user named the agent themselves — captured titles stop renaming it */
  renamed?: boolean;
  /** claude's working state, if it reported one (see ClaudeActivity) */
  activity?: ClaudeActivity;
  /** per-pane terminal font size override (⌘+/⌘− zoom); unset = default */
  fontSize?: number;
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
