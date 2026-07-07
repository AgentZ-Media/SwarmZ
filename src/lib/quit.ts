import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { IS_TAURI, ptyHasChildren } from "./transport";
import { flushAllPersists, useSwarm } from "@/store";
import { vibeBusyIds } from "./vibe/controller";
import type { Agent } from "@/types";

/** Claude is actively working in this pane right now (OSC 9;4 busy). */
export function agentIsBusy(a: Agent): boolean {
  return (
    (a.status === "running" || a.status === "attention") &&
    a.activity === "busy"
  );
}

/**
 * Agents that quitting would actually hurt, busy ones first. Busy agents are
 * always at risk (the run gets interrupted). Idle panes only count when
 * restore-on-launch is disabled — with it enabled they come back anyway, so
 * warning about them would just be noise. Exited panes never count: a dead
 * shell loses nothing.
 */
export function quitBlockerIds(): string[] {
  const { agents, order, settings } = useSwarm.getState();
  const open = order.filter(
    (id) => !!agents[id] && agents[id].status !== "exited",
  );
  const busy = open.filter((id) => agentIsBusy(agents[id]));
  if (settings.restoreAgents === true) return busy;
  return [...busy, ...open.filter((id) => !agentIsBusy(agents[id]))];
}

/**
 * Floating terminals with a live child process (dev server, build, …) —
 * quitting SIGKILLs them, and floats are never restored, so they block the
 * quit just like the per-pane close flow does (pty_has_children check).
 */
async function floatBlockerIds(): Promise<string[]> {
  const { floatingTerminals, floatingOrder } = useSwarm.getState();
  const ids: string[] = [];
  await Promise.all(
    floatingOrder.map(async (tid) => {
      const t = floatingTerminals[tid];
      if (!t || t.status === "exited") return;
      try {
        if (await ptyHasChildren(tid)) ids.push(tid);
      } catch {
        /* unknown → don't block */
      }
    }),
  );
  return ids;
}

// set once the user confirmed quitting — lets the re-issued close() pass the guard
let confirmed = false;

async function closeOrConfirm(win: { close: () => Promise<void> }) {
  const blockers = [
    ...quitBlockerIds(),
    ...(await floatBlockerIds()),
    // a Vibe session with a turn in flight loses the run just like a busy pane
    ...vibeBusyIds(),
  ];
  if (blockers.length > 0 && !confirmed) {
    useSwarm.getState().setQuitConfirm(blockers);
    return;
  }
  // every debounced persist must hit disk before the webview goes away;
  // the re-issued close() passes the guard via `confirmed` (window-state
  // plugin still saves on the real close)
  await flushAllPersists();
  confirmed = true;
  void win.close();
}

/**
 * Warn before the app closes while quitting would lose something: agents
 * still working, open terminals that won't be restored (quitBlockerIds), or
 * floating terminals with running processes.
 *
 * Native: window close (red button) is intercepted via onCloseRequested;
 * ⌘Q / menu quit is prevented in Rust (lib.rs) and forwarded here as
 * `app://quit-requested`. Both raise the QuitConfirmDialog listing the
 * affected agents; confirming closes the window the normal way (window-state
 * plugin still saves, the app exits once the last window is gone).
 *
 * Web: a plain beforeunload guard — browsers only allow their generic prompt.
 */
export function startQuitGuard(): () => void {
  if (!IS_TAURI) {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (quitBlockerIds().length > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }

  const win = getCurrentWindow();
  const unlistenClose = win.onCloseRequested((e) => {
    if (confirmed) return;
    // always prevent this close; closeOrConfirm re-issues it (or raises the
    // dialog) once the async float check settled
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
