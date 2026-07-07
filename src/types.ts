export type AgentStatus = "starting" | "running" | "attention" | "exited";
export type AgentRuntime = "claude" | "codex" | "shell";

/**
 * Agent working state. Claude reports this through terminal escape sequences;
 * Codex reports it through rollout events.
 */
export type ClaudeActivity = "busy" | "idle" | "waiting";

export interface ModelUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  reasoning_output_tokens?: number;
  message_count: number;
  cost_usd: number;
}

export interface SessionUsage {
  runtime?: AgentRuntime;
  activity?: ClaudeActivity;
  session_id: string;
  cwd: string | null;
  primary_model: string | null;
  service_tier: string | null;
  title?: string | null;
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
  reasoning_output_tokens?: number;
  cost_usd: number;
  by_model: ModelUsage[];
  codex_limits?: CodexRateLimits | null;
  /** subagents (Task tool) spawned by this session, each with its own context */
  subagents?: SubagentUsage[];
}

export interface CodexRateLimitWindow extends RateLimitWindow {
  window_minutes: number | null;
}

export interface CodexRateLimits {
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  plan_type: string | null;
}

/**
 * One subagent (Task tool) run, parsed from its own jsonl in
 * `<project>/<session>/subagents/`. Has its own context window.
 */
export interface SubagentUsage {
  agent_id: string;
  /** agent type from `attributionAgent`, e.g. "Explore" / "general-purpose" */
  agent_type: string | null;
  model: string | null;
  context_tokens: number;
  context_limit: number;
  message_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  last_activity: string | null;
  /** the subagent file was modified within the last few seconds */
  running: boolean;
}

/**
 * Persisted snapshot of one tracked agent session launched inside SwarmZ.
 * Survives app restarts so global usage stats cover all-time activity,
 * independent of the ~/.claude JSONL files still existing.
 */
export interface UsageHistoryEntry {
  runtime?: AgentRuntime;
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
  reasoning_output_tokens?: number;
  cost_usd: number;
  by_model: ModelUsage[];
}

export interface UsageTotals {
  runtime?: AgentRuntime;
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  reasoning_output_tokens?: number;
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
 * Account-level Codex rate limits: the newest `rate_limits` event found
 * across ALL of `~/.codex/sessions` (`codex_account_limits` in Rust) —
 * account-scoped like the Claude subscription limits, independent of any
 * open pane. `limits: null` = no data ever seen (Codex never ran / logged
 * out); `as_of_ms` dates the source event so stale data can be annotated.
 */
export interface CodexAccountLimits {
  limits: CodexRateLimits | null;
  as_of_ms: number | null;
}

/**
 * Read-only git snapshot of an agent's working directory, polled every few
 * seconds. Produced by `git_info` (Rust), which shells out to the git binary.
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

// ---- Git worktrees ----

/**
 * Marks an agent as living in a SwarmZ-managed git worktree (the agent's cwd
 * IS the worktree folder under `<root>/.worktrees/`). Drives the pane badge,
 * the split prefill and the close-time cleanup.
 */
export interface WorktreeMeta {
  /** main repo root the worktree belongs to */
  root: string;
  branch: string;
}

/** Result of creating a worktree (`worktree_add` in Rust). */
export interface WorktreeInfo {
  /** main repo root the worktree belongs to */
  root: string;
  /** absolute path of the new worktree (the agent's cwd) */
  path: string;
  branch: string;
  /** untracked/ignored files copied over by the environment transfer */
  copied: number;
}

/** Would closing this worktree lose work? Produced by `worktree_status` (Rust). */
export interface WorktreeStatus {
  /** false when the folder vanished (deleted by hand) — nothing left to lose */
  exists: boolean;
  /** uncommitted changes in tracked files or new (non-ignored) files */
  dirty: boolean;
  /** commits reachable only from this branch — deleting it would lose them */
  ahead: number;
  branch: string | null;
}

/** One SwarmZ worktree found on disk — feeds the title-bar management panel. */
export interface WorktreeEntry {
  root: string;
  /** repo root folder name, for grouping in the panel */
  repo: string;
  path: string;
  branch: string;
  dirty: boolean;
  ahead: number;
  /** registered with git but the folder is gone (prunable) */
  missing: boolean;
}

/**
 * Result of a worktree scan (`worktree_list` in Rust). `scanned` lists the
 * repo roots whose scan actually succeeded — registry pruning must only
 * consider those, so a root on an unmounted volume (or a broken git
 * override) is never mistaken for "no worktrees left".
 */
export interface WorktreeScan {
  entries: WorktreeEntry[];
  scanned: string[];
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
  /** runtime preselected for new agent panes; unset = Codex */
  defaultRuntime?: AgentRuntime;
  /** absolute path used instead of `claude` at the start of startup commands */
  claudePath?: string;
  /** absolute path used instead of `codex` at the start of startup commands */
  codexPath?: string;
  /** absolute path to the git binary used for the read-only pane git status */
  gitPath?: string;
  /** restore the last grid on launch and resume each tracked pane's session (default off) */
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
  /**
   * preferred recording device (getUserMedia deviceId); unset = system
   * default. Applied as an "ideal" constraint, so an unplugged device falls
   * back to the default instead of erroring
   */
  dictationMicId?: string;
  /** human label of the preferred mic — persisted so Settings can show the selection without opening the mic to re-enumerate */
  dictationMicLabel?: string;
  /**
   * transcription engine: "openrouter" = cloud via API key (default),
   * "local" = on-device Parakeet model (no internet, needs the ~670 MB
   * model downloaded in Settings)
   */
  dictationEngine?: "openrouter" | "local";
  /**
   * repo roots that ever had a SwarmZ worktree — scanned for the title-bar
   * worktree panel (so orphans survive restarts); roots with no worktrees
   * left are pruned again on refresh
   */
  worktreeRepos?: string[];
  /**
   * orchestrator brain for NEW chats: "codex" = the codex app-server
   * (ChatGPT login), "openrouter" = a tool loop over the OpenRouter API
   * (key from the Voice section). A chat keeps the provider it was created
   * with; switching this only affects new chats. Unset = codex.
   */
  orchestratorProvider?: "codex" | "openrouter";
  /** OpenRouter model id for orchestrator chats; unset = DEFAULT_ORCHESTRATOR_MODEL */
  orchestratorModel?: string;
  /**
   * let the orchestrator press Enter on prompts it types into panes
   * (default on). Off = review mode: prompt_pane and create_panes startup
   * prompts paste but never submit — the user submits manually.
   */
  orchestratorAutoSubmit?: boolean;
  /**
   * what prompt_pane does on a busy pane: "deliver" queues the text in the
   * CLI's input with a warning to the model (default), "refuse" errors so
   * the model waits instead
   */
  orchestratorBusyPolicy?: "deliver" | "refuse";
  /** default scan roots for the orchestrator's list_projects when the model passes none */
  orchestratorScanRoots?: string[];
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

/**
 * State of the local speech-to-text model (Parakeet TDT 0.6b v3 int8) on
 * disk and in RAM. Fetched at launch and after download/remove.
 */
export interface LocalSttStatus {
  installed: boolean;
  downloading: boolean;
  /** model currently resident in RAM (~2 GB while loaded) */
  loaded: boolean;
  /** full download size in bytes (~670 MB) */
  totalBytes: number;
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
  runtime?: AgentRuntime;
  name: string;
  renamed?: boolean;
  workspaceId: string;
  cwd?: string;
  /** original startup command — `--resume` is injected at spawn, never stored */
  startup: string;
  color: string;
  profileId?: string;
  fontSize?: number;
  /** agent session to resume when this pane is restored */
  sessionId?: string;
  /** set when the pane lives in a SwarmZ-managed git worktree */
  worktree?: WorktreeMeta;
}

/**
 * Continuously persisted snapshot of the live grid: every agent pane plus the
 * tiling trees referencing them. Restored on launch (settings.restoreAgents)
 * by respawning each pane with runtime-specific resume. Floating terminals are
 * plain shells without a session — they are not captured.
 */
export interface PersistedGrid {
  /** snapshot shape version — bump when the persisted shape changes so a
   * future reader can migrate instead of guessing (missing = 1) */
  version?: number;
  agents: PersistedAgent[];
  /** tiling tree per workspace id — pane nodes reference agent ids above */
  layouts: Record<string, LayoutNode | null>;
  activePaneIds?: Record<string, string | null>;
}

export interface Profile {
  id: string;
  name: string;
  runtime?: AgentRuntime;
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
  runtime?: AgentRuntime;
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
  runtime?: AgentRuntime;
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
  /** latched once this agent's own session file is discovered */
  sessionId?: string;
  /**
   * agent session this restored pane should reopen — applied at PTY spawn,
   * kept off `startup` so splits/persistence see the clean command
   */
  resume?: string;
  /** last terminal title captured from the PTY (for runtimes that emit one) */
  title?: string;
  /** true once the user named the agent themselves — captured titles stop renaming it */
  renamed?: boolean;
  /** agent working state, if reported (see ClaudeActivity) */
  activity?: ClaudeActivity;
  /**
   * epoch ms of the first Claude "busy" report. Claude session discovery is
   * gated on it: a pane that never did anything must not latch (and later
   * resume) a sibling session from the same folder.
   */
  firstBusyAt?: number;
  /**
   * epoch ms of the last busy → idle/waiting transition — drives the
   * ephemeral "✓ finished" moment in the pane header (fades after ~5 min).
   * In-memory only, never persisted.
   */
  lastBusyEndAt?: number;
  /**
   * epoch ms the pane entered needs-you via BELL attention while its
   * activity wasn't "waiting" (OSC waiting stamps `lastBusyEndAt` instead) —
   * gives the triage ordering (Deck queue, fleet Tab cycle) a waiting-since
   * for bell-only panes. Stamped in `setAttention(true)`, cleared when the
   * attention clears. In-memory only, never persisted.
   */
  waitingSince?: number;
  /** per-pane terminal font size override (⌘+/⌘− zoom); unset = default */
  fontSize?: number;
  /** live git snapshot of the cwd; null = checked and not inside a repo */
  git?: GitInfo | null;
  /** set when the pane lives in a SwarmZ-managed git worktree (cwd = worktree path) */
  worktree?: WorktreeMeta;
}

// ---- Quick notes ----

/** One line in a quick-notes list — a checkable item or a plain text note. */
export interface NoteItem {
  id: string;
  text: string;
  /** checked off (rendered struck-through and dimmed) */
  done: boolean;
  /** render as plain text without a checkbox (idea / heading-ish line) */
  plain?: boolean;
}

/**
 * All quick notes: a global list plus per-project lists keyed by repo root
 * (worktree agents resolve to their main repo, never the .worktrees path).
 */
export interface QuickNotesData {
  global: NoteItem[];
  folders: Record<string, NoteItem[]>;
}

// ---- Orchestrator chat sidebar ----

/** A pane referenced by an orchestrator tool call — rendered as a jump chip. */
export interface OrchestratorPaneRef {
  /** agent id (chips hide themselves once the pane is gone) */
  id: string;
  /** pane name captured at reference time (fallback when the agent closed) */
  name: string;
}

/**
 * One message in an orchestrator chat. `system` carries the Phase-5 status
 * pings ("«api» finished") — its `paneRefs` render the jump chip and the
 * "Review" button. Assistant messages carry a transient `streaming` flag
 * while deltas arrive — cleared on finalize and on hydrate.
 */
export type OrchestratorChatMessage =
  | { id: string; at: number; role: "user"; text: string }
  | { id: string; at: number; role: "assistant"; text: string; streaming?: boolean }
  | {
      id: string;
      at: number;
      role: "tool";
      tool: string;
      /** one-line args summary from the chat event stream */
      argsSummary: string;
      /** undefined while the call runs; patched from tool_done */
      ok?: boolean;
      /** panes this call touched/created — the UI's "→ pane" jump chips */
      paneRefs?: OrchestratorPaneRef[];
    }
  | { id: string; at: number; role: "warning"; text: string }
  | {
      id: string;
      at: number;
      role: "system";
      text: string;
      /** the pinged pane — jump chip + "Review" target (Phase 5) */
      paneRefs?: OrchestratorPaneRef[];
    };

/** A pane this chat prompted (prompt_pane / create_panes startup prompt). */
export interface OrchestratorTouchedPane {
  /** pane name at prompt time (fallback once the pane is gone) */
  name: string;
  /** last orchestrator prompt delivery into this pane, epoch ms */
  lastPromptAt: number;
}

/**
 * One "pane finished" status ping (Phase 5). Recorded per chat when a
 * touched pane transitions busy → idle/waiting; `delivered` flips once the
 * ping was injected into the wire text of an outgoing turn.
 */
export interface OrchestratorPingRecord {
  paneId: string;
  paneName: string;
  /** the activity the pane landed on */
  activity: "idle" | "waiting";
  at: number;
  delivered: boolean;
}

/** One streamed tool call of the OpenRouter loop (OpenAI wire format). */
export interface OrchestratorWireToolCall {
  id: string;
  name: string;
  /** raw JSON string of the arguments, exactly as streamed */
  arguments_json: string;
}

/**
 * One OpenAI-format wire message of an OpenRouter chat's model context
 * (Phase 6). Persisted per chat, capped — a capped history simply loses old
 * context like any long chat. The system message is NOT persisted; it is
 * rebuilt fresh each turn (instructions + current fleet-status line).
 */
export type OrchestratorWireMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OrchestratorWireToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

/**
 * One orchestrator chat (right sidebar, ⌘⇧O). `provider` is stamped at
 * creation from the settings and never changes (missing = codex, for chats
 * from pre-Phase-6 builds). Codex chats: `threadId` is the app-server thread
 * behind it — persisted so the chat reconnects across app restarts
 * (chatResume); null until the first message was sent. OpenRouter chats:
 * `model` + `wire` (the OpenAI-format model context) take that role.
 * `touchedPanes`/`pendingPings` are the Phase-5 status-ping state — persisted
 * so pings survive restarts.
 */
export interface OrchestratorChat {
  id: string;
  /** the brain behind this chat — fixed for the chat's lifetime */
  provider?: "codex" | "openrouter";
  threadId: string | null;
  /** OpenRouter model id, captured at creation (openrouter chats only) */
  model?: string;
  /** OpenRouter wire history, capped (openrouter chats only) */
  wire?: OrchestratorWireMessage[];
  title: string;
  createdAt: number;
  messages: OrchestratorChatMessage[];
  /** panes this chat prompted, keyed by pane id */
  touchedPanes: Record<string, OrchestratorTouchedPane>;
  /** ping history, oldest first, capped (delivered + undelivered) */
  pendingPings: OrchestratorPingRecord[];
}

/** Persisted shape of the orchestrator sidebar (store key `orchestratorChats`). */
export interface PersistedOrchestratorChats {
  /** shape version — bump when the persisted shape changes (missing = 1) */
  version?: number;
  chats: OrchestratorChat[];
  activeId: string | null;
  panelOpen?: boolean;
  panelWidth?: number;
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
