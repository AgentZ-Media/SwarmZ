// GitHub controller — OUTSIDE React (the vibe/orchestrator controller
// pattern). Owns:
//   · lazy per-project detection: repo info + open PRs into the github store
//     (read-only, works with the integration OFF — the panel shows it)
//   · the Rust-gate + watcher sync: mirrors the Settings master toggle into
//     `github_set_integration` (the server-side gate for gh writes AND the
//     classify_approval gh routing) and declaratively configures the PR
//     watcher with every open project that verifiably HAS a GitHub repo
//   · `github://pr-changed` events: PR cache updates, Deck ticker entries,
//     and — for PRs the Conductor watches (watch_pr) or, opt-in, for newly
//     opened PRs (auto-review toggle) — budget-gated autonomous Conductor
//     turns through the trigger router (never around it).

import { listen } from "@tauri-apps/api/event";
import { IS_TAURI } from "@/lib/transport";
import { useSwarm } from "@/store";
import { useProjects, openProjectIds } from "@/lib/projects/store";
import { pushFleetEvent } from "@/lib/events";
import { enqueueAutonomousTrigger } from "@/lib/orchestrator/triggers";
import {
  prChangedMarker,
  prChangedWire,
} from "@/lib/orchestrator/triggers-core";
import {
  configureGithubWatch,
  fetchGhAuthStatus,
  fetchGhPrList,
  fetchGhRepoInfo,
  setAutonomousGithubWrites,
  setGithubIntegration,
} from "./api";
import { describeGhUnavailable, prEventLabel } from "./core";
import { useGithub, isWatched, EMPTY_PROJECT_GITHUB } from "./store";
import type { GhOutcome, PrChangedEvent } from "./types";

/** Default watcher interval when the Settings field is unset. */
export const DEFAULT_WATCH_INTERVAL_SEC = 120;

/** PR data older than this refreshes when the panel asks again. */
const PR_STALE_MS = 60_000;

let started = false;

/**
 * In-flight detection per project. Parallel callers get the SAME promise —
 * `github_status` awaits a running detection instead of reading a transient
 * "loading" state and answering "detection failed".
 */
const detecting = new Map<string, Promise<void>>();

function integrationOn(): boolean {
  return !!useSwarm.getState().settings.githubIntegration;
}

function watchIntervalSec(): number {
  const raw = useSwarm.getState().settings.githubWatchIntervalSec;
  return typeof raw === "number" && raw > 0 ? raw : DEFAULT_WATCH_INTERVAL_SEC;
}

// ---- detection (read-only, integration-independent) ----

/** Refresh the gh auth digest (panel header chip). */
export async function refreshGithubAuth(): Promise<void> {
  if (!IS_TAURI) return;
  try {
    useGithub.getState().setAuth(await fetchGhAuthStatus());
  } catch {
    /* leave the last known digest */
  }
}

/**
 * Detect one project's GitHub context (repo info + open PRs) into the store.
 * `force` bypasses the staleness window (panel refresh button). Safe to call
 * repeatedly — parallel calls for the same project collapse onto ONE shared
 * promise (awaitable, so the `github_status` executor never reads a
 * transient "loading"). Failures land in the store as terminal states — a
 * thrown invoke must not leave "loading" forever, and a failed PR fetch must
 * not masquerade as "no open PRs" (it sets `prsError` instead).
 */
export function refreshProjectGithub(
  projectId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (!IS_TAURI) return Promise.resolve();
  const inflight = detecting.get(projectId);
  if (inflight) return inflight;
  const dir = useProjects.getState().projects[projectId]?.dir?.trim();
  if (!dir) return Promise.resolve();
  const gh = useGithub.getState();
  const cur = gh.byProject[projectId] ?? EMPTY_PROJECT_GITHUB;
  if (
    !opts.force &&
    cur.prsFetchedAt !== null &&
    Date.now() - cur.prsFetchedAt < PR_STALE_MS
  ) {
    return Promise.resolve(); // fresh enough
  }
  gh.patchProject(projectId, { repoStatus: cur.repo ? "ok" : "loading" });
  const run = (async () => {
    try {
      const repoOutcome = await fetchGhRepoInfo(dir);
      if (repoOutcome.status !== "ok") {
        useGithub.getState().patchProject(projectId, {
          repoStatus:
            repoOutcome.status === "error" ? "error" : repoOutcome.status,
          repoError: repoOutcome.status === "error" ? repoOutcome.data : null,
          repo: null,
          prs: [],
          prsError: null,
        });
        return;
      }
      useGithub.getState().patchProject(projectId, {
        repoStatus: "ok",
        repoError: null,
        repo: repoOutcome.data,
      });
      const prsOutcome: GhOutcome<PrChangedEvent["prs"]> =
        await fetchGhPrList(dir);
      if (prsOutcome.status === "ok") {
        useGithub.getState().patchProject(projectId, {
          prs: prsOutcome.data,
          prsFetchedAt: Date.now(),
          prsError: null,
        });
      } else {
        // repo detected but the PR list failed (rate limit, network) — keep
        // the last known PRs, flag the staleness instead of faking "none"
        useGithub.getState().patchProject(projectId, {
          prsError:
            prsOutcome.status === "error"
              ? prsOutcome.data
              : describeGhUnavailable(prsOutcome.status),
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const known = useGithub.getState().byProject[projectId];
      if (known?.repo) {
        useGithub.getState().patchProject(projectId, { prsError: msg });
      } else {
        // detection never got anywhere — a terminal error, never eternal
        // "loading"
        useGithub
          .getState()
          .patchProject(projectId, { repoStatus: "error", repoError: msg });
      }
    } finally {
      detecting.delete(projectId);
      // a repo appearing/disappearing changes what the watcher should poll
      scheduleSync();
    }
  })();
  detecting.set(projectId, run);
  return run;
}

// ---- Rust gate + watcher sync ----

let syncTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced: settings/projects churn collapses into one sync. */
function scheduleSync() {
  if (!IS_TAURI || syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncGithubIntegration();
  }, 250);
}

/** How often a failed Rust-gate sync is retried before surfacing. */
const GATE_SYNC_RETRIES = 5;
const GATE_SYNC_RETRY_MS = 1_000;
let disarmRetryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The FALLING edge — never debounced, never fire-and-forget: the UI showing
 * "off" while Rust still accepts writes is the one state that must not
 * exist. The Rust command itself drains in-flight writes before acking, so
 * an awaited success means "no gh write is running and none can start". A
 * failed IPC retries with backoff and finally SURFACES instead of being
 * swallowed.
 */
async function disarmIntegrationNow(attempt = 0): Promise<void> {
  if (!IS_TAURI || integrationOn()) return; // re-enabled meanwhile
  try {
    await setGithubIntegration(false);
  } catch (e) {
    if (integrationOn()) return; // re-enabled while we failed — sync handles it
    if (attempt < GATE_SYNC_RETRIES) {
      disarmRetryTimer = setTimeout(
        () => void disarmIntegrationNow(attempt + 1),
        GATE_SYNC_RETRY_MS,
      );
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[github] failed to disable the Rust write gate:", msg);
    pushFleetEvent({
      kind: "pr",
      sessionId: "",
      sessionName: "GitHub",
      label: `GitHub disable did not reach the backend (${msg}) — restart the app if writes must stop`,
    });
  }
}

/**
 * Mirror the master toggle into Rust and (re)configure the watcher: with the
 * integration ON, every OPEN project with a verified GitHub repo is polled;
 * OFF (or nothing to poll) configures an empty list, which stops polling.
 */
async function syncGithubIntegration(): Promise<void> {
  const enabled = integrationOn();
  try {
    await setGithubIntegration(enabled);
  } catch (e) {
    // a failed DISABLE must not be swallowed — retry + surface
    if (!enabled) void disarmIntegrationNow(1);
    else console.error("[github] gate sync failed:", e);
  }
  const projects = useProjects.getState();
  const gh = useGithub.getState();
  const repos = enabled
    ? openProjectIds(projects)
        .filter((id) => gh.byProject[id]?.repoStatus === "ok")
        .map((id) => ({
          project_id: id,
          dir: projects.projects[id]!.dir,
        }))
    : [];
  try {
    await configureGithubWatch(repos, watchIntervalSec());
  } catch (e) {
    console.error("[github] watcher sync failed:", e);
  }
  // with the integration freshly ON, detect open projects we know nothing
  // about yet (their repos then join the watcher on the next sync)
  if (enabled) {
    for (const id of openProjectIds(projects)) {
      if ((gh.byProject[id]?.repoStatus ?? "unknown") === "unknown") {
        void refreshProjectGithub(id);
      }
    }
  }
}

/**
 * Mirror the "Autonomous GitHub actions" toggle into Rust — independent of
 * the master integration gate: the server-side gh-write approval
 * classification consults it, so Rust must always know the current state.
 * Best-effort and TOLERANT: on a backend without the command yet (parallel
 * rollout) the invoke rejects and we only log — the TS-side
 * `guardOutwardGithub` still gates autonomous writes; this is the Rust twin.
 */
async function syncAutonomousGithubWrites(): Promise<void> {
  if (!IS_TAURI) return;
  const enabled = !!useSwarm.getState().settings.autonomousGithubWrites;
  try {
    await setAutonomousGithubWrites(enabled);
  } catch (e) {
    console.error(
      "[github] autonomous-writes sync failed (non-fatal — backend may lack the command):",
      e,
    );
  }
}

// ---- watch_pr (Conductor tool surface) ----

/** Watch a PR: its watcher changes wake the Conductor. This-app-run only. */
export function watchPr(projectId: string, number: number): void {
  const gh = useGithub.getState();
  const cur = gh.watched[projectId] ?? [];
  if (!cur.includes(number)) gh.setWatched(projectId, [...cur, number]);
}

export function unwatchPr(projectId: string, number: number): boolean {
  const gh = useGithub.getState();
  const cur = gh.watched[projectId] ?? [];
  if (!cur.includes(number)) return false;
  gh.setWatched(
    projectId,
    cur.filter((n) => n !== number),
  );
  return true;
}

// ---- pr-changed events → cache, ticker, autonomy loop ----

function onPrChanged(ev: PrChangedEvent): void {
  const projectId = ev.project_id;
  // the PR snapshot always refreshes the cache (baseline included)
  useGithub.getState().patchProject(projectId, {
    repoStatus: "ok",
    prs: ev.prs,
    prsFetchedAt: Date.now(),
    prsError: null,
  });
  if (ev.baseline) return;
  const settings = useSwarm.getState().settings;
  for (const change of ev.changes) {
    // Deck ticker (toasts deliberately skip unknown kinds — ticker-only)
    pushFleetEvent({
      kind: "pr",
      sessionId: "",
      sessionName: `PR #${change.number}`,
      label: prEventLabel(change.number, change.note),
      url: change.url,
    });
    // autonomy loop: watched PRs always; newly OPENED PRs when the user
    // opted into automatic PR review. Both go through the trigger router
    // (dedupe per (project, "pr-changed", pr-N), closed-tab muting, bounded
    // retries) and the budget-gated runner — never around either.
    const watched = (useGithub.getState().watched[projectId] ?? []).includes(
      change.number,
    );
    const autoReviewNew =
      change.kind === "opened" && !!settings.githubAutoReviewPrs;
    if (!watched && !autoReviewNew) continue;
    const reason = watched ? ("watched" as const) : ("auto-review" as const);
    const { number, title, note } = change;
    // a watched PR that closed/merged is a final notice — drop the watch
    // (that final notice still delivers: the drop is OUR bookkeeping, not an
    // unwatch decision, so the build's re-check exempts it)
    const finalNotice = watched && change.kind === "closed";
    if (finalNotice) unwatchPr(projectId, number);
    enqueueAutonomousTrigger({
      projectId,
      kind: "pr-changed",
      subjectId: `pr-${number}`,
      build: async () => {
        // re-checked at DELIVERY: integration toggled off, or a watched PR
        // un-watched (watch_pr "unwatch") while the trigger sat queued →
        // stay silent (auto-review turns don't depend on a watch)
        if (!integrationOn()) return null;
        if (
          reason === "watched" &&
          !finalNotice &&
          !isWatched(useGithub.getState(), projectId, number)
        ) {
          return null;
        }
        return {
          marker: prChangedMarker(number, note),
          wire: prChangedWire({ number, title, note, reason }),
        };
      },
    });
  }
}

// ---- bootstrap ----

/**
 * Start the GitHub controller: event listener + settings/projects
 * subscriptions + the initial sync. Returns a stop function. Registered once
 * from App.tsx (double-start guarded).
 */
export function startGithubController(): () => void {
  if (!IS_TAURI || started) return () => {};
  started = true;

  const unlistenP = listen<PrChangedEvent>("github://pr-changed", (event) =>
    onPrChanged(event.payload),
  );

  // settings: master toggle / interval / gh path changes re-sync the gate.
  // The FALLING edge additionally disarms Rust IMMEDIATELY (un-debounced,
  // awaited, retried) — the debounce only serves the noisy directions.
  const unsubSettings = useSwarm.subscribe((state, prev) => {
    const a = state.settings;
    const b = prev.settings;
    if (a.githubIntegration !== b.githubIntegration && !a.githubIntegration) {
      void disarmIntegrationNow();
    }
    if (
      a.githubIntegration !== b.githubIntegration ||
      a.githubWatchIntervalSec !== b.githubWatchIntervalSec ||
      a.ghPath !== b.ghPath
    ) {
      scheduleSync();
    }
    // the autonomous-writes gate mirrors independently of the master toggle
    if (a.autonomousGithubWrites !== b.autonomousGithubWrites) {
      void syncAutonomousGithubWrites();
    }
  });

  // projects: opening/closing tabs changes what the watcher polls; a newly
  // opened project gets detected (integration on)
  let prevOpenSig = "";
  const unsubProjects = useProjects.subscribe((state) => {
    const sig = openProjectIds(state).join("|");
    if (sig === prevOpenSig) return;
    prevOpenSig = sig;
    scheduleSync();
  });

  scheduleSync();
  void syncAutonomousGithubWrites(); // mirror the current state to Rust on start
  void refreshGithubAuth();

  return () => {
    started = false;
    unsubSettings();
    unsubProjects();
    void unlistenP.then((u) => u());
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    if (disarmRetryTimer) {
      clearTimeout(disarmRetryTimer);
      disarmRetryTimer = null;
    }
  };
}
