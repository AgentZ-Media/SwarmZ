// SwarmZ domain types — Codex-only. The app drives native `codex app-server`
// sessions (Vibe) plus one orchestrator; there are no terminals, panes or
// grid workspaces anymore (removed in the codex-only rebuild, Phase 1).

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

/**
 * Persisted snapshot of one tracked Codex session launched inside SwarmZ.
 * Survives app restarts so global usage stats cover all-time activity,
 * independent of the ~/.codex JSONL files still existing. (Entries from the
 * pre-rebuild era may carry other `runtime` values — tolerated on read.)
 */
export interface UsageHistoryEntry {
  runtime?: string;
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

/** One rate-limit window of the Codex subscription (5h session, 7d week, …). */
export interface RateLimitWindow {
  /** percent used, 0–100 */
  utilization: number | null;
  /** ISO timestamp when the window resets */
  resets_at: string | null;
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
 * Account-level Codex rate limits: the newest `rate_limits` event found
 * across ALL of `~/.codex/sessions` (`codex_account_limits` in Rust).
 * `limits: null` = no data ever seen (Codex never ran / logged out);
 * `as_of_ms` dates the source event so stale data can be annotated.
 */
export interface CodexAccountLimits {
  limits: CodexRateLimits | null;
  as_of_ms: number | null;
}

/**
 * Read-only git snapshot of a directory, produced by `git_info` (Rust),
 * which shells out to the git binary. Used by the orchestrator's git_status
 * tool and the worktree flows.
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

/** Marks a SwarmZ-managed git worktree (folder under `<root>/.worktrees/`). */
export interface WorktreeMeta {
  /** main repo root the worktree belongs to */
  root: string;
  branch: string;
}

/** Result of creating a worktree (`worktree_add` in Rust). */
export interface WorktreeInfo {
  /** main repo root the worktree belongs to */
  root: string;
  /** absolute path of the new worktree */
  path: string;
  branch: string;
  /** untracked/ignored files copied over by the environment transfer */
  copied: number;
}

/** Would removing this worktree lose work? Produced by `worktree_status` (Rust). */
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

// ---- Settings ----

/** Small app-wide preferences, persisted across restarts. Edited in the Settings dialog. */
export interface AppSettings {
  /** last project directory a session was launched in — prefilled in the New Session dialog */
  lastCwd?: string;
  /** download updates in the background as soon as they're found (installing still needs a restart) */
  autoUpdate?: boolean;
  /** absolute path used instead of `codex` when spawning the app-server */
  codexPath?: string;
  /** absolute path to the git binary used for git status / worktrees */
  gitPath?: string;
  /**
   * repo roots that ever had a SwarmZ worktree — scanned for the title-bar
   * worktree panel (so orphans survive restarts); roots with no worktrees
   * left are pruned again on refresh
   */
  worktreeRepos?: string[];
  /**
   * Default model + reasoning effort NEW orchestrator chats are stamped
   * with (a per-chat override the model picker can then change). Unset =
   * the user's plain codex default.
   */
  orchestratorCodexModel?: string;
  orchestratorCodexEffort?: string;
  /** default scan roots for the orchestrator's list_projects when the model passes none */
  orchestratorScanRoots?: string[];
  /**
   * the orchestrator's persona (voice/self-image only — never its tools or
   * safety rules, those are hard-wired in the operative core). Unset = the
   * "Maestro" default seed; edited in Settings → Orchestrator. Only
   * name/role/tone/principles reach the backend; emoji/accent are UI-only.
   */
  orchestratorPersona?: OrchestratorPersona;
}

/**
 * The orchestrator persona. `name`/`role`/`tone`/`principles` are compiled
 * into the system instructions (Rust `build_instructions`); `emoji`/`accent`
 * are UI-only (Conductor card, panel header, composer placeholder).
 */
export interface OrchestratorPersona {
  name: string;
  /** one-sentence self-image, compiled after "You are {name} — " */
  role: string;
  /** voice/directness, e.g. "Calm, precise, leading." */
  tone: string;
  /** 1–6 short principles */
  principles: string[];
  /** UI avatar emoji (Conductor dot / panel header) */
  emoji?: string;
  /** UI accent tint (optional dot color) */
  accent?: string;
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
 * All quick notes: a global list plus per-project lists keyed by repo root.
 */
export interface QuickNotesData {
  global: NoteItem[];
  folders: Record<string, NoteItem[]>;
}

// ---- Orchestrator chat ----

/** A session referenced by an orchestrator tool call — rendered as a jump chip. */
export interface OrchestratorPaneRef {
  /** session id (chips hide themselves once the session is gone) */
  id: string;
  /** session name captured at reference time (fallback when it closed) */
  name: string;
}

/**
 * One message in an orchestrator chat. `system` carries the status pings
 * ("«api» finished") — its `paneRefs` render the jump chip and the "Review"
 * button. Assistant messages carry a transient `streaming` flag while deltas
 * arrive — cleared on finalize and on hydrate.
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
      /** sessions this call touched/created — the UI's jump chips */
      paneRefs?: OrchestratorPaneRef[];
    }
  | { id: string; at: number; role: "warning"; text: string }
  | {
      id: string;
      at: number;
      role: "system";
      text: string;
      /** the pinged session — jump chip + "Review" target */
      paneRefs?: OrchestratorPaneRef[];
    };

/** A session this chat prompted (prompt_pane / create_panes startup prompt). */
export interface OrchestratorTouchedPane {
  /** session name at prompt time (fallback once it is gone) */
  name: string;
  /** last orchestrator prompt delivery into this session, epoch ms */
  lastPromptAt: number;
}

/**
 * One "session finished" status ping. Recorded per chat when a touched
 * session transitions busy → idle/waiting; `delivered` flips once the ping
 * was injected into the wire text of an outgoing turn.
 */
export interface OrchestratorPingRecord {
  paneId: string;
  paneName: string;
  /** the activity the session landed on */
  activity: "idle" | "waiting";
  at: number;
  delivered: boolean;
}

/**
 * One orchestrator chat. `threadId` is the app-server thread behind it —
 * persisted so the chat reconnects across app restarts (chatResume); null
 * until the first message was sent. `touchedPanes`/`pendingPings` are the
 * status-ping state — persisted so pings survive restarts.
 */
export interface OrchestratorChat {
  id: string;
  threadId: string | null;
  /** codex model override (a per-turn override, editable mid-chat). Unset = the user's default. */
  model?: string;
  /** codex reasoning-effort override, e.g. "high". Unset = default. */
  effort?: string;
  title: string;
  createdAt: number;
  messages: OrchestratorChatMessage[];
  /** sessions this chat prompted, keyed by session id */
  touchedPanes: Record<string, OrchestratorTouchedPane>;
  /** ping history, oldest first, capped (delivered + undelivered) */
  pendingPings: OrchestratorPingRecord[];
}

/** Persisted shape of the orchestrator chats (store key `orchestratorChats`).
 * Pre-rebuild persists may additionally carry `panelOpen`/`panelWidth` (the
 * removed ⌘⇧O side panel) — ignored tolerantly on hydrate. */
export interface PersistedOrchestratorChats {
  /** shape version — bump when the persisted shape changes (missing = 1) */
  version?: number;
  chats: OrchestratorChat[];
  activeId: string | null;
}

// ---- Vibe: native Codex sessions ----

/** How much a Vibe session's Codex agent may touch the machine. */
export type VibeAccess = "workspace" | "full";

/**
 * One Vibe session (a native Codex agent driven over the app-server). `id` is
 * assigned frontend-side and keys the backend session too; `threadId` is the
 * codex thread behind it — persisted so the session reconnects across restarts
 * (vibe_session_resume), null until the first turn. `access` maps to the
 * sandbox/approval policy in Rust.
 */
export interface VibeSession {
  id: string;
  name: string;
  /** the project directory the session runs in (thread cwd) */
  projectDir: string;
  /** codex model id (unset = the user's codex default) */
  model?: string;
  /** reasoning effort, e.g. "low" | "medium" | "high" */
  effort?: string;
  access: VibeAccess;
  /** app-server thread id — survives restarts; null until the first turn */
  threadId: string | null;
  createdAt: number;
}

/** Status of an approval item over its lifetime. */
export type VibeApprovalStatus =
  | "pending"
  | "accepted"
  | "acceptedForSession"
  | "declined"
  | "cancelled";

/** One change inside a fileChange item (the `add` diff is the raw new content). */
export interface VibeFileChange {
  path: string;
  /** tagged PatchChangeKind, e.g. `{ type: "add" }` */
  kind: unknown;
  diff: string;
}

/** One step of a turn plan (turn/plan/updated). */
export interface VibePlanStep {
  step: string;
  status: string;
}

/**
 * One item in a Vibe session's transcript — the normalized-by-id domain unit
 * (t3code lesson: a delta replaces only its own item object, never the others).
 * `command.output` is the (capped) aggregatedOutput; `approval.payload` is the
 * raw request (itemId links a fileChange approval to its fileChange item).
 */
export type VibeItem =
  | { id: string; at: number; kind: "user"; text: string }
  | {
      id: string;
      at: number;
      kind: "assistant";
      text: string;
      /** transient while deltas arrive — never restored on hydrate */
      streaming?: boolean;
      phase?: string | null;
    }
  | {
      id: string;
      at: number;
      kind: "command";
      command: string;
      cwd?: string;
      status: string;
      exitCode?: number | null;
      /** aggregatedOutput, capped */
      output: string;
    }
  | {
      id: string;
      at: number;
      kind: "fileChange";
      status: string;
      changes: VibeFileChange[];
    }
  | {
      id: string;
      at: number;
      kind: "plan";
      explanation?: string | null;
      steps: VibePlanStep[];
    }
  | { id: string; at: number; kind: "webSearch"; query: string; action?: unknown }
  | {
      id: string;
      at: number;
      kind: "approval";
      approvalKind: "command" | "fileChange";
      status: VibeApprovalStatus;
      /** the raw request params (itemId, reason, command, cwd, …) */
      payload: Record<string, unknown>;
    }
  | { id: string; at: number; kind: "warning"; text: string };

/** Per-turn token accounting (thread/tokenUsage/updated). */
export interface VibeTokenUsage {
  total?: Record<string, number> | null;
  last?: Record<string, number> | null;
  modelContextWindow?: number | null;
}

/**
 * One persisted Vibe session: its meta + the normalized transcript. Items are
 * kept as a map + order (identity-preserving delta updates); runtime-only
 * fields (busy, turnId, diff, plan, tokenUsage) are NOT persisted.
 */
export interface PersistedVibeSession {
  session: VibeSession;
  items: VibeItem[];
}

/** Persisted shape of the Vibe sessions (store key `vibeSessions`). */
export interface PersistedVibeSessions {
  /** shape version — bump when the persisted shape changes (missing = 1) */
  version?: number;
  sessions: PersistedVibeSession[];
  activeId: string | null;
}
