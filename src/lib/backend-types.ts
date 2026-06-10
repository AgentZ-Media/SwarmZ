import type {
  AppSettings,
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

  /** Subscribe to output / exit of ONE agent's PTY (events are addressed per agent). */
  onPtyData(id: string, cb: (e: PtyDataEvent) => void): Promise<Unlisten>;
  onPtyExit(id: string, cb: (e: PtyExitEvent) => void): Promise<Unlisten>;

  fetchUsageForDir(cwd: string): Promise<SessionUsage | null>;
  fetchUsageForSession(
    cwd: string,
    sinceMs: number,
    sessionId?: string,
  ): Promise<SessionUsage | null>;
  fetchUsageTotals(): Promise<UsageTotals>;
  /**
   * Fires when session files changed. `changedDirs` holds the affected
   * project-dir names (encoded cwds); empty/undefined = unknown → refresh all.
   */
  onUsageChanged(cb: (changedDirs?: string[]) => void): Promise<Unlisten>;

  pickDirectory(): Promise<string | undefined>;
  getHome(): Promise<string>;

  ensureNotifyPermission(): Promise<boolean>;
  notify(title: string, body: string): Promise<void>;

  loadProfiles(): Promise<Profile[] | null>;
  saveProfiles(profiles: Profile[]): Promise<void>;

  loadUsageHistory(): Promise<UsageHistoryEntry[] | null>;
  saveUsageHistory(entries: UsageHistoryEntry[]): Promise<void>;

  loadSettings(): Promise<AppSettings | null>;
  saveSettings(settings: AppSettings): Promise<void>;

  /** null when no Claude Code login is found or the request fails. */
  fetchSubscriptionLimits(): Promise<SubscriptionLimits | null>;
}
