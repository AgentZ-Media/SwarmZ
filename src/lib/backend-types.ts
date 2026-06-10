import type {
  AppSettings,
  DetectedCommand,
  FolderCommands,
  GitInfo,
  Profile,
  SessionUsage,
  SubscriptionLimits,
  UsageHistoryEntry,
  UsageTotals,
} from "@/types";

export interface PtyDataEvent {
  id: string;
  data: string; // base64
}
export interface PtyExitEvent {
  id: string;
}

export type Unlisten = () => void;

export interface Backend {
  ptySpawn(args: {
    id: string;
    cwd?: string;
    startup?: string;
    cols: number;
    rows: number;
  }): Promise<void>;
  ptyWrite(id: string, data: string): Promise<void> | void;
  ptyResize(id: string, cols: number, rows: number): Promise<void> | void;
  ptyKill(id: string): Promise<void> | void;
  /**
   * True when the shell in this PTY has a foreground child process (dev
   * server, build, …) — used to warn before killing a floating terminal.
   * Unknown sessions and check failures resolve false.
   */
  ptyHasChildren(id: string): Promise<boolean>;

  /** Subscribe to output / exit of ONE agent's PTY (events are addressed per agent). */
  onPtyData(id: string, cb: (e: PtyDataEvent) => void): Promise<Unlisten>;
  onPtyExit(id: string, cb: (e: PtyExitEvent) => void): Promise<Unlisten>;

  fetchUsageForDir(cwd: string): Promise<SessionUsage | null>;
  fetchUsageForSession(
    cwd: string,
    sinceMs: number,
    sessionId?: string,
    /** session ids already claimed by other agents — never match these */
    excludeSessionIds?: string[],
  ): Promise<SessionUsage | null>;
  fetchUsageTotals(): Promise<UsageTotals>;
  /**
   * Fires when session files changed. `changedDirs` holds the affected
   * project-dir names (encoded cwds); empty/undefined = unknown → refresh all.
   */
  onUsageChanged(cb: (changedDirs?: string[]) => void): Promise<Unlisten>;

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

  /** Runnable commands found in a folder's project files (scripts, targets, …). */
  detectProjectCommands(cwd: string): Promise<DetectedCommand[]>;

  loadProfiles(): Promise<Profile[] | null>;
  saveProfiles(profiles: Profile[]): Promise<void>;

  /** Quick-command customizations (presets + hidden), keyed by project folder (cwd). */
  loadCommandPresets(): Promise<Record<string, FolderCommands> | null>;
  saveCommandPresets(presets: Record<string, FolderCommands>): Promise<void>;

  loadUsageHistory(): Promise<UsageHistoryEntry[] | null>;
  saveUsageHistory(entries: UsageHistoryEntry[]): Promise<void>;

  loadSettings(): Promise<AppSettings | null>;
  saveSettings(settings: AppSettings): Promise<void>;

  /**
   * null when no Claude Code login is found (UI hides the meters); transient
   * fetch errors reject so callers can keep showing the last known values.
   */
  fetchSubscriptionLimits(): Promise<SubscriptionLimits | null>;
}
