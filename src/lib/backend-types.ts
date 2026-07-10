import type {
  AppSettings,
  CodexAccountLimits,
  GitInfo,
  PersistedOrchestratorChats,
  PersistedVibeSessions,
  QuickNotesData,
  UsageHistoryEntry,
} from "@/types";

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
