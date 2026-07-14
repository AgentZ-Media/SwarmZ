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

/**
 * What is still running when the user tries to quit (Quit-Guard v2). The
 * dialog lists it; the guard raises only when something would genuinely be
 * interrupted (busy sessions, busy Conductors, a Conductor timer mid-fire,
 * in-flight gh writes, detached reviews or worktree git ops) — pending
 * timers are shown as info (they persist and re-fire next launch).
 */
export interface QuitBlockers {
  /** busy vibe session ids (a running turn would be interrupted) */
  sessionIds: string[];
  /** project names whose Conductor has a turn in flight */
  conductorProjects: string[];
  /** pending Conductor timers (info only — they survive a restart) */
  pendingTimers: number;
  /**
   * Conductor timers MID-FIRE (durable `firedAt` claim stamped, delivery not
   * yet finished) — quitting now drops them on the next hydrate
   * (at-most-once), so unlike pending timers they are a HARD blocker.
   */
  claimedTimers: number;
  /** gh/git write ops in flight (a push / PR mutation — interrupting is bad);
   * -1 = the counter query FAILED (unknown state → confirm, fail closed) */
  ghWrites: number;
  /** detached codex reviews in flight (manual / review_agent / auto-review —
   * they hold no busy flag but quitting kills them mid-run) */
  reviews: number;
  /** git worktree add/remove operations in flight */
  worktreeOps: number;
  /** sandboxed Runtime Environment commands/services; -1 = query failed */
  runtimeOps: number;
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
  /**
   * the ahead count could NOT be computed (git error/timeout) — deletion
   * gates must treat this as "may hold work" (fail closed), never as 0
   */
  ahead_unknown: boolean;
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
  /** the ahead count could not be computed — treat as "may hold work" */
  ahead_unknown: boolean;
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

// ---- Projects ----

/**
 * One project tab: a folder the swarm works in. Sessions belong to exactly
 * one project (`VibeSession.projectId`); Phase 3 gives every project its own
 * Conductor. Persisted under the store key `projects`.
 */
export interface Project {
  id: string;
  /** canonical absolute folder path (symlinks resolved) — the dedupe key */
  dir: string;
  /** display name — folder basename, deduped with a numeric suffix ("api 2") */
  name: string;
  /** tab position among the open projects, ascending */
  order: number;
  /** last time this project was the active tab, epoch ms */
  lastActiveAt: number;
  createdAt: number;
  /**
   * Epoch ms the tab was closed — null/absent = open (shown in the tab bar).
   * Closing a project NEVER touches its sessions; the entity stays persisted
   * so reopening the same folder brings them back under the same id.
   */
  closedAt?: number | null;
}

/** Persisted shape of the projects (store key `projects`). */
export interface PersistedProjects {
  /** shape version — bump when the persisted shape changes (missing = 1) */
  version?: number;
  projects: Project[];
  /** the active project tab — persisted so a restart lands where you left */
  activeId: string | null;
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
   * Phase 5 auto-review: when a conductor-tasked agent finishes a lane that
   * changed code, a detached codex review runs automatically BEFORE the
   * Conductor's agent-finished turn — the findings ride into that turn, so
   * the Conductor reports reviewed work. Off by default (reviews cost turns).
   */
  autoReviewFinishedLanes?: boolean;
  /**
   * Phase 8 auto-compaction: when a session/Conductor chat nears its context
   * window (≥85%), `thread/compact/start` runs BEFORE the next turn to shrink
   * the model-visible history (the UI transcript is never touched). Only when
   * idle, and at most once per cooldown. ON by default; set false to rely on
   * the manual compact button (and codex' own auto-compaction) only.
   */
  autoCompact?: boolean;
  /**
   * Motion off-switch (DESIGN.md): stamps `data-motion="off"` on the root
   * element, collapsing every nonessential animation (sweeps, pulses,
   * carets, entrances). Off by default — motion on.
   */
  reduceMotion?: boolean;
  /** absolute path to the `gh` binary (GitHub CLI) — empty = auto-resolve */
  ghPath?: string;
  /**
   * Phase 7 — the GitHub integration MASTER toggle (default OFF). ON enables:
   * the Conductor's github tools, the PR watcher, the Deck PR indicator and
   * the routine-classification of the two sanctioned agent-run gh writes
   * (`gh pr comment` / `gh pr review` — mirrored into Rust). The read-only
   * GitHub panel works regardless (local gh state only, no OAuth ever).
   */
  githubIntegration?: boolean;
  /**
   * When ON (and the integration is on), a NEWLY OPENED PR detected by the
   * watcher wakes the Conductor with an autonomous review turn. Default off.
   */
  githubAutoReviewPrs?: boolean;
  /**
   * When ON (and the integration is on), the Conductor's agent-finished turn
   * for a lane on a branch WITHOUT an open PR carries a "propose a PR"
   * suggestion line. Default off.
   */
  githubSuggestPrOnFinish?: boolean;
  /** PR watcher poll interval in seconds (default 120, floor 30). */
  githubWatchIntervalSec?: number;
  /**
   * Opt-in (default OFF) that lets the Conductor perform OUTWARD-FACING GitHub
   * writes (open a PR, comment, post a review) DURING AN AUTONOMOUS turn — a
   * fleet event drove it, not a user message. Off = those writes are refused
   * in autonomous turns and the Conductor must PROPOSE them to the user
   * instead; human-triggered turns (the user asked directly) always allow them
   * under the master toggle. The safety cap against a prompt-injected
   * autonomous cascade pushing/posting/approving on the user's repo.
   */
  autonomousGithubWrites?: boolean;
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

/**
 * What woke the Conductor for an autonomous turn (Phase 5 loop). Stamped on
 * the turn's system marker message (`autonomous: true` + `trigger`) so the
 * UI can render autonomous turns distinctly from user-triggered ones.
 */
export type AutonomousTriggerKind =
  | "agent-finished"
  | "agent-blocked"
  | "approval"
  | "timer"
  | "idle"
  | "pr-changed";

/** A session referenced by an orchestrator tool call — rendered as a jump chip. */
export interface OrchestratorPaneRef {
  /** session id (chips hide themselves once the session is gone) */
  id: string;
  /** session name captured at reference time (fallback when it closed) */
  name: string;
  /** Optional immutable runtime snapshot for audit-trail tool messages.
   * `null` model means the user's Codex configuration. */
  runtime?: { model: string | null; effort: string | null };
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
      /** true = this marker precedes an AUTONOMOUS Conductor turn (Phase 5) */
      autonomous?: boolean;
      /** what woke the Conductor — set together with `autonomous` */
      trigger?: AutonomousTriggerKind;
    };

/** A session this chat prompted (prompt_agent / spawn_agents startup task). */
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
 * One Conductor chat. `threadId` is the app-server thread behind it —
 * persisted so the chat reconnects across app restarts (chatResume); null
 * until the first message was sent. `touchedPanes`/`pendingPings` are the
 * status-ping state — persisted so pings survive restarts. Since Phase 3
 * every chat belongs to exactly one project (`projectId` — the Conductor
 * instance it runs on); pre-Phase-3 chats hydrate through a migration that
 * derives the project from the sessions the chat touched.
 */
export interface OrchestratorChat {
  id: string;
  /** owning project (`Project.id`) — the Conductor stage scopes on this */
  projectId: string;
  threadId: string | null;
  /** Dynamic-tool catalog version of the backend thread. Older/missing
   * versions start a fresh thread so newly added Conductor tools are real. */
  toolsetVersion?: number;
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
 * Version 2 = chats carry `projectId` + the per-project active map. Pre-rebuild
 * persists may additionally carry `panelOpen`/`panelWidth` (the removed ⌘⇧O
 * side panel) — ignored tolerantly on hydrate. */
export interface PersistedOrchestratorChats {
  /** shape version — bump when the persisted shape changes (missing = 1) */
  version?: number;
  chats: OrchestratorChat[];
  /** v1 leftover: the single global active chat (migrated into the map) */
  activeId?: string | null;
  /** active chat per project — the Conductor stage restores per-tab (v2) */
  activeByProject?: Record<string, string>;
}

// ---- Vibe: native Codex sessions ----

/** How much a Vibe session's Codex agent may touch the machine. */
export type VibeAccess = "workspace" | "full";

/** Who created a session: the human (dialog/palette) or the Conductor. */
export type VibeSpawnedBy = "user" | "conductor" | "mission";

/**
 * The git worktree a session's agent works in. Phase 2 only carries the
 * field (plus the WorktreePanel "open in session" flow, which knows all
 * three values); Phase 4's worktree tools fill it for conductor-spawned
 * agents. `shared` = other agents work in the same worktree.
 */
export interface VibeSessionWorktree {
  /** main repo root the worktree belongs to */
  root: string;
  branch: string;
  shared: boolean;
}

/**
 * One Vibe session (a native Codex agent driven over the app-server). `id` is
 * assigned frontend-side and keys the backend session too; `threadId` is the
 * codex thread behind it — persisted so the session reconnects across restarts
 * (vibe_session_resume), null until the first turn. `access` maps to the
 * sandbox/approval policy in Rust. Since schema v2 every session belongs to
 * exactly one project (`projectId`); pre-v2 persists hydrate through the
 * migration that derives/creates projects from their `projectDir`s.
 */
export interface VibeSession {
  id: string;
  /** display label — renamable; starts as the generated temporary lane label */
  name: string;
  /** owning project tab (`Project.id`) — the rail scopes on this */
  projectId: string;
  /**
   * Stable operational lane label (legacy field name), collision-free per
   * project. It is not a persona or reusable identity. Mission attempts will
   * derive branches from task/attempt ids; migrated sessions retain their old
   * display label for historical readability.
   */
  agentName: string;
  spawnedBy: VibeSpawnedBy;
  /** the worktree the agent works in — null = directly in the project dir */
  worktree: VibeSessionWorktree | null;
  /** the directory the session runs in (thread cwd; a worktree path when `worktree` is set) */
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
  | {
      id: string;
      at: number;
      kind: "user";
      text: string;
      /**
       * The Conductor injected this prompt (prompt_agent / spawn_agents),
       * rather than the human typing it. Lets the feed mark it "via Conductor"
       * so autonomously-issued orders are distinguishable from your own.
       * Undefined = a human message (or a pre-existing item).
       */
      via?: "conductor";
      /** Durable backend turn binding (Mission evidence boundary). */
      turnId?: string;
    }
  | {
      id: string;
      at: number;
      kind: "assistant";
      text: string;
      /** transient while deltas arrive — never restored on hydrate */
      streaming?: boolean;
      phase?: string | null;
      /**
       * This message is the schema-forced final report of a COMPLETED
       * `expect_report` turn (Phase 5 `outputSchema`) — stamped by the vibe
       * controller at turn completion, persisted with the transcript. The UI
       * renders it as a report card instead of raw JSON (ItemFeed), but only
       * when the text still parses as a valid AgentReport.
       */
      report?: boolean;
      /** Durable backend turn binding (Mission evidence boundary). */
      turnId?: string;
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
      /** Durable backend turn binding (Mission evidence boundary). */
      turnId?: string;
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
      /**
       * Conductor routing class (classified in Rust, conservative):
       * "routine" = the Conductor may decide it via decide_approval,
       * "destructive" = hard human-only. Missing (pre-Phase-4 items) =
       * treated as destructive.
       */
      escalation?: "routine" | "destructive";
      /**
       * Who decided a resolved approval — the Conductor (via the strict
       * `decide_approval` path) or the human (the takeover / inline card).
       * Undefined = still pending, or a pre-existing item resolved before this
       * field existed. Drives the "approved by Conductor" attribution so the
       * user can see, at a glance, which approvals they did NOT give themselves.
       */
      decidedBy?: "conductor" | "human";
      /** the raw request params (itemId, reason, command, cwd, …) */
      payload: Record<string, unknown>;
    }
  | { id: string; at: number; kind: "warning"; text: string }
  /** a neutral, non-error notice (e.g. a context-compaction divider) */
  | { id: string; at: number; kind: "notice"; text: string };

// ---- Conductor timers ----

/**
 * One Conductor follow-up timer (the `set_timer` tool). Project-scoped;
 * persisted (store key `conductorTimers`) so timers survive app restarts —
 * they only FIRE while the app runs, missed ones fire on the next launch.
 * Firing delivers an autonomous Conductor turn in the timer's project with
 * `note` as context (lib/orchestrator/timers.ts).
 */
export interface ConductorTimer {
  id: string;
  /** owning project (`Project.id`) — fires into that project's Conductor */
  projectId: string;
  /** what future-you should do — the fired turn's context */
  note: string;
  /** fire time, epoch ms */
  at: number;
  createdAt: number;
  /**
   * Durable at-most-once claim: stamped (and flushed) IMMEDIATELY BEFORE the
   * autonomous turn dispatches. A persisted timer carrying `firedAt` on the
   * next hydrate may already have delivered (crash between dispatch and
   * removal) — it is dropped instead of double-delivered. Cleared again when
   * a dispatch reports retry (not delivered).
   */
  firedAt?: number;
}

/** Persisted shape of the Conductor timers (store key `conductorTimers`). */
export interface PersistedConductorTimers {
  /** shape version — bump when the persisted shape changes (missing = 1) */
  version?: number;
  timers: ConductorTimer[];
}

// ---- Autonomy budget (Phase 5) ----

/**
 * One project's persisted autonomy-budget state (lib/orchestrator/autonomy.ts).
 * Persisted so an app relaunch/HMR can never mint a fresh autonomous-turn
 * allowance or silently un-latch a tripped circuit breaker — only a real
 * human message re-arms it.
 */
export interface PersistedAutonomyBudget {
  /** autonomous-turn timestamps inside the rolling window */
  firedAt: number[];
  /** autonomous turns since the last human message */
  consecutive: number;
  /** breaker latched — survives restarts until a human message */
  tripped: boolean;
}

/** Persisted shape of the autonomy budgets (store key `autonomyBudgets`). */
export interface PersistedAutonomyBudgets {
  version: 1;
  projects: Record<string, PersistedAutonomyBudget>;
}

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

/**
 * Persisted shape of the Vibe sessions (store key `vibeSessions`).
 * Version 2 = sessions carry `projectId`/`agentName`/`spawnedBy`/`worktree`;
 * version 1 / missing hydrates through the project migration (projects are
 * derived from the sessions' `projectDir`s).
 */
export interface PersistedVibeSessions {
  /** shape version — bump when the persisted shape changes (missing = 1) */
  version?: number;
  sessions: PersistedVibeSession[];
  activeId: string | null;
  /** remembered session selection per project — restored on tab switch */
  activeIdByProject?: Record<string, string>;
}
