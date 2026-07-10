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

/** The tool names — must match the Rust registry exactly. */
export const ORCHESTRATOR_TOOL_NAMES = [
  "fleet_snapshot",
  "read_transcript",
  "read_project_docs",
  "read_notes",
  "git_status",
  "list_projects",
  "prompt_pane",
  "create_panes",
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

/** `prompt_pane` result. */
export interface PromptPaneResult {
  delivered: true;
  session: { id: string; name: string };
  submitted: boolean;
}

/** One session request inside `create_panes`. */
export interface CreatePaneSpec {
  /** absolute working directory; omit = the Conductor's project folder */
  cwd?: string;
  /** codex model id; omit = the user's default configuration */
  model?: string;
  /** model_reasoning_effort */
  reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
  name?: string;
  /** initial prompt, submitted as the session's first turn */
  prompt?: string;
}

/** Per-session outcome of `create_panes` — errors never abort the batch. */
export interface CreatePaneResult {
  /** set on success */
  id?: string;
  name?: string | null;
  cwd?: string | null;
  /** scoping note — set when a foreign cwd opened its own project tab (the
   * session is then outside this Conductor's fleet) */
  note?: string;
  /** prompt delivery note */
  warning?: string;
  /** set when this session failed to start */
  error?: string;
}

export interface CreatePanesResult {
  sessions: CreatePaneResult[];
  /** honest, human-readable account of what was created */
  summary?: string;
}
