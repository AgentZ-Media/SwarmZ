import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { IS_TAURI } from "./transport";
import { flushAllPersists, useSwarm } from "@/store";
import { vibeBusyIds } from "./vibe/controller";
import { busyConductorProjectNames } from "./orchestrator/controller";
import { useConductorTimers } from "./orchestrator/timers";
import { inflightCount } from "./inflight";
import { hasHardBlocker } from "./quit-core";
import type { QuitBlockers } from "@/types";

// set once the user confirmed quitting — lets the re-issued close() pass the guard
let confirmed = false;

/** gh/git write ops currently in flight (Rust counter; -1 = the query
 * FAILED — unknown state must confirm, never silently pass, fail closed). */
async function ghWritesInFlight(): Promise<number> {
  try {
    return (await invoke<number>("github_writes_in_flight")) || 0;
  } catch {
    return -1;
  }
}

async function runtimeOperationsInFlight(): Promise<number> {
  try {
    return (await invoke<number>("runtime_operations_in_flight")) || 0;
  } catch {
    return -1;
  }
}

/** Gather everything that would be interrupted by quitting right now. */
async function gatherBlockers(): Promise<QuitBlockers> {
  const timers = useConductorTimers.getState().timers;
  const [ghWrites, runtimeOps] = await Promise.all([
    ghWritesInFlight(),
    runtimeOperationsInFlight(),
  ]);
  return {
    sessionIds: vibeBusyIds(),
    conductorProjects: busyConductorProjectNames(),
    pendingTimers: timers.length,
    // mid-fire (durable claim stamped, delivery not finished): quitting now
    // would drop the timer on the next hydrate — a HARD blocker
    claimedTimers: timers.filter((t) => t.firedAt !== undefined).length,
    ghWrites,
    reviews: inflightCount("review"),
    worktreeOps: inflightCount("worktree"),
    runtimeOps,
  };
}

async function closeOrConfirm(win: { close: () => Promise<void> }) {
  // anything that would lose work if we quit now → warn first
  if (!confirmed) {
    const blockers = await gatherBlockers();
    if (hasHardBlocker(blockers)) {
      useSwarm.getState().setQuitConfirm(blockers);
      return;
    }
  }
  // every debounced persist must hit disk before the webview goes away;
  // the re-issued close() passes the guard via `confirmed` (window-state
  // plugin still saves on the real close)
  await flushAllPersists();
  confirmed = true;
  void win.close();
}

/**
 * Warn before the app closes while quitting would lose something: sessions
 * with a turn still running.
 *
 * Window close (red button) is intercepted via onCloseRequested; ⌘Q / menu
 * quit is prevented in Rust (lib.rs) and forwarded here as
 * `app://quit-requested`. Both raise the QuitConfirmDialog listing the
 * affected sessions; confirming closes the window the normal way (window-
 * state plugin still saves, the app exits once the last window is gone).
 */
export function startQuitGuard(): () => void {
  if (!IS_TAURI) return () => {};

  const win = getCurrentWindow();
  const unlistenClose = win.onCloseRequested((e) => {
    if (confirmed) return;
    // always prevent this close; closeOrConfirm re-issues it (or raises the
    // dialog) once the persist flush settled
    e.preventDefault();
    void closeOrConfirm(win);
  });
  const unlistenQuit = listen("app://quit-requested", () => {
    void closeOrConfirm(win);
  });
  return () => {
    void unlistenClose.then((u) => u());
    void unlistenQuit.then((u) => u());
  };
}

/** Resolve the quit warning: actually quit, or keep working. */
export function resolveQuitConfirm(quit: boolean) {
  useSwarm.getState().setQuitConfirm(null);
  if (!quit || !IS_TAURI) return;
  void flushAllPersists().finally(() => {
    confirmed = true;
    void getCurrentWindow().close();
  });
}
