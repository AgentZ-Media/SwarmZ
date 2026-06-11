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

/**
 * Read-only git snapshot of an agent's working directory, polled every few
 * seconds. Produced by `git_info` (Rust) / `/api/git` (web) — both shell out
 * to the git binary and must stay in sync.
 */
export interface GitInfo {
  /** repo root folder name */
  repo: string;
  /** branch name, or the short commit SHA when HEAD is detached */
  branch: string;
  /** added lines of tracked files (working tree + index vs HEAD) */
  insertions: number;
  /** removed lines of tracked files (working tree + index vs HEAD) */
  deletions: number;
  /** files git doesn't track yet (.gitignore respected) */
  untracked: number;
  /** browsable https URL of the `origin` remote, if one exists */
  remote_url: string | null;
}

/** Small app-wide preferences, persisted across restarts. Edited in the Settings dialog. */
export interface AppSettings {
  /** last working directory an agent was launched in — prefilled in the New Agent dialog */
  lastCwd?: string;
  /** download updates in the background as soon as they're found (native only; installing still needs a restart) */
  autoUpdate?: boolean;
  /** default terminal font size for panes without a per-pane zoom override */
  defaultFontSize?: number;
  /** startup command the New Agent dialog opens with; unset = built-in default, "" = plain shell */
  defaultStartup?: string;
  /** absolute path used instead of `claude` at the start of startup commands */
  claudePath?: string;
  /** absolute path to the git binary used for the read-only pane git status */
  gitPath?: string;
  /** restore the last grid on launch and resume each pane's claude session (default off) */
  restoreAgents?: boolean;
  /** voice dictation hotkey behavior: hold ⌘⇧M like push-to-talk, or press to start/stop (default "hold") */
  dictationHotkeyMode?: "hold" | "toggle";
  /** submit the transcript with Enter right after pasting it (default off) */
  dictationAutoSubmit?: boolean;
  /** polish transcripts with an LLM after transcription (default off) */
  dictationCleanup?: boolean;
  /** OpenRouter model for the cleanup pass; unset = DEFAULT_CLEANUP_MODEL */
  dictationCleanupModel?: string;
  /** system prompt of the cleanup pass; unset = DEFAULT_CLEANUP_PROMPT (must never translate) */
  dictationCleanupPrompt?: string;
  /** OpenRouter speech-to-text model; unset = DEFAULT_STT_MODEL */
  dictationSttModel?: string;
}

// ---- OpenRouter voice dictation ----

/**
 * State of the OpenRouter API key in the macOS Keychain. `valid: null` means
 * "present but unverifiable right now" (offline/5xx) — dictation stays
 * enabled then; only an explicit 401/403 rejection turns it off.
 */
export interface OpenrouterKeyStatus {
  present: boolean;
  valid: boolean | null;
}

/** One entry of OpenRouter's public model catalog (cleanup-model picker). */
export interface OpenrouterModel {
  id: string;
  name: string;
}

/** Result of transcribing one audio segment. */
export interface TranscriptionResult {
  text: string;
  /** duration of the input audio in seconds (what OpenRouter bills) */
  seconds: number;
  /** cost of the request in USD */
  cost: number;
}

/** A voice dictation in flight, keyed to the pty it will paste into (in-memory). */
export interface DictationState {
  /** agent pane or floating terminal receiving the transcript */
  targetId: string;
  phase: "recording" | "transcribing" | "error";
  /** epoch ms recording started — drives the elapsed readout in the pill */
  startedAt: number;
  error?: string;
}

/**
 * A named container with its own tiling grid — the top-level organization
 * unit (title-bar tabs, ⌘1–9). Deliberately NOT bound to a project: one
 * workspace can be a repo, a feature with several worktrees, or a mixed
 * monitoring wall. Name/order/defaultCwd persist across restarts; the agents
 * inside are in-memory like everywhere else.
 */
export interface Workspace {
  id: string;
  name: string;
  /** true once the user named it — auto-naming from the first project folder stops */
  renamed?: boolean;
  /** prefilled working directory for new agents in this workspace */
  defaultCwd?: string;
}

/** Shape persisted for workspaces (tabs survive restarts). */
export interface PersistedWorkspaces {
  workspaces: Workspace[];
  activeId: string | null;
}

/** Restore-relevant slice of an Agent, snapshotted into the persisted grid. */
export interface PersistedAgent {
  id: string;
  name: string;
  renamed?: boolean;
  workspaceId: string;
  cwd?: string;
  /** original startup command — `--resume` is injected at spawn, never stored */
  startup: string;
  color: string;
  profileId?: string;
  fontSize?: number;
  /** claude session to resume when this pane is restored */
  sessionId?: string;
}

/**
 * Continuously persisted snapshot of the live grid: every agent pane plus the
 * tiling trees referencing them. Restored on launch (settings.restoreAgents)
 * by respawning each pane with `claude --resume <sessionId>`. Floating
 * terminals are plain shells without a session — they are not captured.
 */
export interface PersistedGrid {
  agents: PersistedAgent[];
  /** tiling tree per workspace id — pane nodes reference agent ids above */
  layouts: Record<string, LayoutNode | null>;
  activePaneIds?: Record<string, string | null>;
}

export interface Profile {
  id: string;
  name: string;
  /** command typed into the shell on spawn, e.g. `claude --dangerously-skip-permissions` */
  startup: string;
  defaultCwd?: string;
  color: string;
}

// ---- Workspace presets ----

/** One pane template inside a workspace preset. */
export interface PresetPaneNode {
  type: "pane";
  id: string;
  /** fixed working directory; unset = inherit the folder asked for at load time */
  cwd?: string;
  /** startup command; unset = the configured default startup command, "" = plain shell */
  startup?: string;
  /** agent name; unset = auto ("Agent N" + captured terminal titles) */
  name?: string;
  profileId?: string;
  color?: string;
}

export interface PresetSplitNode {
  type: "split";
  direction: "row" | "column";
  /** flex-grow weights, one per child (same semantics as SplitNode) */
  sizes: number[];
  children: PresetLayoutNode[];
}

export type PresetLayoutNode = PresetPaneNode | PresetSplitNode;

/**
 * A reusable workspace blueprint: a tiling layout whose leaves are agent
 * templates. Loaded from the empty-workspace screen — every pane spawns as a
 * fresh agent. Persisted (store key `workspacePresets`); seeded with a few
 * standard grids on first launch.
 */
export interface WorkspacePreset {
  id: string;
  name: string;
  layout: PresetLayoutNode;
}

export interface Agent {
  id: string;
  name: string;
  /** workspace this agent's pane lives in */
  workspaceId: string;
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
  /**
   * claude session this restored pane should reopen — applied at PTY spawn
   * (`--resume`), kept off `startup` so splits/persistence see the clean command
   */
  resume?: string;
  /** last terminal title captured from the PTY (claude's auto-generated topic) */
  title?: string;
  /** true once the user named the agent themselves — captured titles stop renaming it */
  renamed?: boolean;
  /** claude's working state, if it reported one (see ClaudeActivity) */
  activity?: ClaudeActivity;
  /**
   * epoch ms of the first "busy" report — proof this pane's claude actually
   * worked. Session discovery is gated on it: a pane that never did anything
   * must not latch (and later resume) a sibling session from the same folder
   */
  firstBusyAt?: number;
  /** per-pane terminal font size override (⌘+/⌘− zoom); unset = default */
  fontSize?: number;
  /** live git snapshot of the cwd; null = checked and not inside a repo */
  git?: GitInfo | null;
}

// ---- Floating terminals & quick commands ----

/** One saved quick command. Stored per project folder, keyed by cwd. */
export interface CommandPreset {
  id: string;
  label: string;
  command: string;
}

/**
 * Everything the user customized about quick commands in one project folder:
 * saved presets and auto-detected commands they removed. A preset whose label
 * or command matches a detected command overrides it.
 */
export interface FolderCommands {
  presets: CommandPreset[];
  /** detected commands hidden by the user, matched by command string */
  hidden: string[];
}

/**
 * One user-defined prompt/command snippet, inserted (pasted, not run) into
 * the active agent pane via the insert picker (⌘⇧K). `text` may contain
 * `{{…}}` placeholders, substituted at insert time (see lib/command-vars.ts).
 */
export interface CustomCommand {
  id: string;
  label: string;
  text: string;
}

/** All custom commands: global ones plus per-project-folder lists (keyed by presetKey(cwd)). */
export interface CustomCommandsData {
  global: CustomCommand[];
  folders: Record<string, CustomCommand[]>;
}

/**
 * A runnable command auto-detected from project files in a folder —
 * package.json scripts (package-manager aware via the lockfile), Cargo.toml,
 * Makefile and justfile targets. Produced by `project_commands` (Rust) /
 * `/api/project-commands` (web) — keep both implementations in sync.
 */
export interface DetectedCommand {
  label: string;
  command: string;
  /** where it was found: "package.json" | "cargo" | "make" | "just" */
  source: string;
}

/**
 * A small PiP-style shell terminal floating above the grid (in-memory).
 * Owned by an agent pane; detaching (when the pane closes while a process is
 * still running) keeps the PTY alive with `agentId: null`.
 */
export interface FloatingTerminal {
  id: string;
  /** owning agent; null once detached */
  agentId: string | null;
  cwd?: string;
  /** display name — the last command run, or "Terminal" */
  name: string;
  status: "running" | "exited";
  /** collapsed to just the title bar (PTY keeps running) */
  minimized: boolean;
  /** window rect in px relative to the grid area; x/y null until first layout */
  x: number | null;
  y: number | null;
  w: number;
  h: number;
  /** stacking order — raised on click; render order stays stable (xterm canvas) */
  z: number;
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
