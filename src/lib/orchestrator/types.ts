// Payload types of the orchestrator sensing commands and the tool bus —
// keep in sync with the serde structs in src-tauri/src/transcript.rs /
// projects.rs / orchestrator/ (field names arrive snake_case).

/** One transcript entry. Tool activity is a one-line summary, never a payload. */
export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  /** rfc3339 timestamp of the source line, when present */
  at: string | null;
  /** "tool" = a `[tool: …]` / `[tool result: …]` one-liner */
  kind: "text" | "tool";
}

/** Result of `transcript_read` — the readable tail of one codex session file. */
export interface TranscriptView {
  /** the session's first real user message (the Ursprungsprompt), capped */
  first_user_message: string | null;
  /** compaction summaries in the read window */
  summaries: string[];
  messages: TranscriptMessage[];
  /** true when the byte cap cut the file or the tail limit dropped messages */
  truncated: boolean;
}

/** One project doc (README.md / AGENTS.md / CLAUDE.md), content capped. */
export interface ProjectDocFile {
  name: string;
  content: string;
  truncated: boolean;
  /** full on-disk size in bytes */
  size: number;
}

/** Result of `project_docs`. Missing files are omitted. */
export interface ProjectDocs {
  files: ProjectDocFile[];
  /** the root actually read (worktree paths resolve to the main repo) */
  root_used: string;
}

/** A folder the frontend already knows, passed into `discover_projects`. */
export interface KnownFolder {
  path: string;
  /** where it came from: "session" | "notes" | "worktree-repo" | … */
  source: string;
}

/** One discovered project folder, merged across all sources. */
export interface ProjectEntry {
  path: string;
  /** folder basename */
  name: string;
  /** newest observed activity, epoch ms — null for sources without one */
  last_activity: number | null;
  sources: string[];
  exists: boolean;
}

// ---- Tool bus ----
//
// Tool names/schemas live in ONE place: the Rust registry
// (src-tauri/src/orchestrator/registry.rs). The TS side mirrors the NAMES
// only (executor lookup + typing); schemas are never duplicated here.

/** The tool names — must match the Rust registry exactly (Phase 4: 24). */
export const ORCHESTRATOR_TOOL_NAMES = [
  "fleet_snapshot",
  "read_agent",
  "read_project_docs",
  "read_notes",
  "git_status",
  "list_projects",
  "spawn_agents",
  "prompt_agent",
  "interrupt_agent",
  "close_agent",
  "set_agent_config",
  "review_agent",
  "decide_approval",
  "create_worktree",
  "assign_worktree",
  "worktree_status",
  "cleanup_worktree",
  "set_timer",
  "list_timers",
  "cancel_timer",
  "write_plan",
  "list_plans",
  "read_plan",
  "remember",
] as const;

/** One curated memory entry (`orchestrator_memory_read` / `_remove`). */
export interface OrchestratorMemoryEntry {
  /** ISO date the entry was stored (may be empty for hand-edited lines) */
  date: string;
  text: string;
}

/** Result of `orchestrator_memory_append` (the `remember` tool). */
export interface OrchestratorMemoryAppend {
  stored: boolean;
  /** how many oldest entries the cap dropped */
  dropped: number;
  total: number;
  /** human-readable note surfaced to the model */
  note: string;
}

export type OrchestratorToolName = (typeof ORCHESTRATOR_TOOL_NAMES)[number];

/** One catalog entry inside the `orchestrator_tools` response. */
export interface OrchestratorToolDefinition {
  name: OrchestratorToolName;
  description: string;
  /** JSON Schema of the arguments object */
  parameters: Record<string, unknown>;
  timeout_ms: number;
}

/**
 * Response of `orchestrator_tools`: the single-source system instructions
 * (compiled by `persona::build_instructions` — persona + memory + operative
 * core) plus the tool catalog — the dev hook exposes the whole object.
 */
export interface OrchestratorToolsResponse {
  instructions: string;
  tools: OrchestratorToolDefinition[];
}

/** Payload of the `orchestrator://tool-request` event. */
export interface OrchestratorToolRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** BACKEND chat id of the triggering chat — null for dev-hook calls */
  chat_id?: string | null;
  /** project of the Conductor instance behind the call — null = unscoped
   * (dev-hook); executors scope session resolution + fleet_snapshot on it */
  project_id?: string | null;
}

/** `read_notes` — NoteItems reduced to content (ids dropped). */
export interface ToolNoteItem {
  text: string;
  done: boolean;
}

/** One plan document's info (`conductor_plan_write` / `_list`). */
export interface ConductorPlanInfo {
  slug: string;
  title: string;
  /** absolute file path — hand this to agents */
  path: string;
  modified_ms: number;
  size: number;
}

/** One plan document's content (`conductor_plan_read`). */
export interface ConductorPlanDocument {
  slug: string;
  path: string;
  content: string;
}

/** `prompt_agent` result. */
export interface PromptAgentResult {
  delivered: true;
  agent: { id: string; name: string };
  /** how the text reached the agent: a fresh turn, or steered mid-turn */
  mode: "turn" | "steered";
}

/** One agent request inside `spawn_agents`. */
export interface SpawnAgentSpec {
  /** the agent's first order — self-contained */
  task: string;
  /** "new" | "shared:<agentName>" | "none" */
  worktree: string;
  /** codex model id; omit = the default */
  model?: string;
  /** reasoning effort (open string — catalog-driven); omit = medium */
  effort?: string;
  access?: "workspace" | "full";
  name?: string;
}

/** Per-agent outcome of `spawn_agents` — errors never abort the batch. */
export interface SpawnAgentResult {
  /** set on success */
  id?: string;
  name?: string | null;
  /** the agent's working directory (worktree path or project folder) */
  cwd?: string | null;
  /** worktree branch (null = works directly in the project folder) */
  branch?: string | null;
  /** true when the agent shares its worktree with another agent */
  shared?: boolean;
  /** task delivery note */
  warning?: string;
  /** set when this agent failed to start */
  error?: string;
}

export interface SpawnAgentsResult {
  agents: SpawnAgentResult[];
  /** honest, human-readable account of what was created */
  summary?: string;
}
