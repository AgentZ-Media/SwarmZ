import type {
  AppSettings,
  CodexAccountLimits,
  GitInfo,
  PersistedAutonomyBudgets,
  PersistedConductorTimers,
  PersistedOrchestratorChats,
  PersistedProjects,
  PersistedVibeSessions,
  QuickNotesData,
  UsageHistoryEntry,
} from "@/types";
import type { PersistedMissions } from "@/lib/missions/types";
import type { PersistedMissionOutbox } from "@/lib/missions/outbox";
import type { PersistedRuntimeEnvironments } from "@/lib/runtime/core";

export type Unlisten = () => void;

export interface Backend {
  pickDirectory(): Promise<string | undefined>;
  getHome(): Promise<string>;

  /**
   * Read-only git snapshot for a directory; null when it isn't inside a repo.
   * `gitBin` overrides the git binary (Settings → Paths).
   */
  fetchGitInfo(cwd: string, gitBin?: string): Promise<GitInfo | null>;
  /** Open a URL in the user's default browser. */
  openUrl(url: string): Promise<void>;

  ensureNotifyPermission(): Promise<boolean>;
  notify(title: string, body: string): Promise<void>;

  /** Quick notes (checklists) — global + per project folder (repo root). */
  loadQuickNotes(): Promise<QuickNotesData | null>;
  saveQuickNotes(data: QuickNotesData): Promise<void>;

  /** Orchestrator chats — chats + active id + panel open/width. */
  loadOrchestratorChats(): Promise<PersistedOrchestratorChats | null>;
  saveOrchestratorChats(data: PersistedOrchestratorChats): Promise<void>;

  /** Native Codex sessions — session meta + normalized transcript. */
  loadVibeSessions(): Promise<PersistedVibeSessions | null>;
  saveVibeSessions(data: PersistedVibeSessions): Promise<void>;

  /** Project tabs — projects (open + closed) and the active tab. */
  loadProjects(): Promise<PersistedProjects | null>;
  saveProjects(data: PersistedProjects): Promise<void>;

  /** Conductor follow-up timers — project-scoped, survive restarts. */
  loadConductorTimers(): Promise<PersistedConductorTimers | null>;
  saveConductorTimers(data: PersistedConductorTimers): Promise<void>;

  /** Autonomy budgets / circuit breakers — a relaunch must not reset them. */
  loadAutonomyBudgets(): Promise<PersistedAutonomyBudgets | null>;
  saveAutonomyBudgets(data: PersistedAutonomyBudgets): Promise<void>;

  /** Append-only Mission Control event log and its schema envelope. */
  loadMissions(): Promise<PersistedMissions | null>;
  saveMissions(data: PersistedMissions): Promise<void>;

  /** Write-ahead Mission Control side-effect commands and delivery leases. */
  loadMissionOutbox(): Promise<PersistedMissionOutbox | null>;
  saveMissionOutbox(data: PersistedMissionOutbox): Promise<void>;

  /** Project-scoped runtime contracts. Secret values are never stored here. */
  loadRuntimeEnvironments(): Promise<PersistedRuntimeEnvironments | null>;
  saveRuntimeEnvironments(data: PersistedRuntimeEnvironments): Promise<void>;

  /**
   * Delete top-level swarmz.json keys (missing keys are a no-op) — the
   * one-time schema-v2 cleanup of the dead pane-era keys runs through this.
   */
  deleteStoreKeys(keys: string[]): Promise<void>;

  loadUsageHistory(): Promise<UsageHistoryEntry[] | null>;
  saveUsageHistory(entries: UsageHistoryEntry[]): Promise<void>;

  loadSettings(): Promise<AppSettings | null>;
  saveSettings(settings: AppSettings): Promise<void>;

  /**
   * Top-level `schemaVersion` key of swarmz.json — the migration anchor
   * (see lib/schema-version.ts). null = pre-versioning store.
   */
  loadSchemaVersion(): Promise<number | null>;
  saveSchemaVersion(version: number): Promise<void>;

  /**
   * Account-level Codex rate limits from the newest `rate_limits` session
   * event on disk. `limits: null` = no data ever (the Deck shows `CX —`).
   */
  fetchCodexAccountLimits(): Promise<CodexAccountLimits>;
}
