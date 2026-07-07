// Payload types of the orchestrator sensing commands (Phase 1) and the tool
// bus (Phase 2) — keep in sync with the serde structs in
// src-tauri/src/transcript.rs / projects.rs / orchestrator/ (field names
// arrive snake_case, like the usage payloads in types.ts).

/** One transcript entry. Tool activity is a one-line summary, never a payload. */
export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  /** rfc3339 timestamp of the source line, when present */
  at: string | null;
  /** "tool" = a `[tool: …]` / `[tool result: …]` one-liner */
  kind: "text" | "tool";
}

/** Result of `transcript_read` — the readable tail of one agent session. */
export interface TranscriptView {
  /** the session's first real user message (the Ursprungsprompt), capped */
  first_user_message: string | null;
  /** compaction summaries (Claude `type:"summary"` lines) in the read window */
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
  /** where it came from: "workspace" | "profile" | "preset" | "notes" | … */
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

// ---- Tool bus (Phase 2) ----
//
// Tool names/schemas live in ONE place: the Rust registry
// (src-tauri/src/orchestrator/registry.rs). The TS side mirrors the NAMES
// only (executor lookup + typing); schemas are never duplicated here.

/** The V1 tool names — must match the Rust registry exactly. */
export const ORCHESTRATOR_TOOL_NAMES = [
  "fleet_snapshot",
  "read_transcript",
  "read_project_docs",
  "read_notes",
  "git_status",
  "list_projects",
  "list_blueprints",
  "prompt_pane",
  "create_panes",
  "create_workspace",
] as const;

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
 * (ORCHESTRATOR_INSTRUCTIONS in appserver.rs) plus the tool catalog — the
 * OpenRouter loop consumes both, the dev hook exposes the whole object.
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
}

/** Pane identity echoed in tool responses. */
export interface ToolPaneRef {
  id: string;
  name: string;
  runtime: string;
}

/** `read_notes` — NoteItems reduced to content (ids dropped). */
export interface ToolNoteItem {
  text: string;
  done: boolean;
}

/** `prompt_pane` result. */
export interface PromptPaneResult {
  delivered: true;
  pane: ToolPaneRef;
  /** the pane's activity right before the paste */
  activity_at_send: "busy" | "idle" | "waiting" | null;
  submitted: boolean;
  /** set when the pane was busy — the text queued in the CLI's input */
  warning?: string;
  /** set when review mode (orchestratorAutoSubmit off) blocked the submit */
  note?: string;
}

/** One pane request inside `create_panes`. */
export interface CreatePaneSpec {
  cwd: string;
  runtime?: "claude" | "codex" | "shell";
  profile_id?: string;
  /** model id appended to the startup (claude: --model, codex: -m); omit = default config */
  model?: string;
  /** codex-only: model_reasoning_effort */
  reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh";
  name?: string;
  /** initial prompt, submitted once the agent CLI is ready */
  prompt?: string;
  /** run the pane in a fresh git worktree of the repo at cwd */
  worktree?: boolean;
  /** worktree branch; omitted = generated */
  branch?: string;
}

/** Per-pane outcome of `create_panes` — errors never abort the batch. */
export interface CreatePaneResult {
  /** set on success */
  id?: string;
  name?: string | null;
  cwd?: string | null;
  worktree?: { root: string; branch: string } | null;
  /** prompt delivery note (e.g. the pane never became ready) */
  warning?: string;
  /** set when this pane failed (worktree creation, unknown profile, …) */
  error?: string;
}

export interface CreatePanesResult {
  workspace_id: string;
  panes: CreatePaneResult[];
}
