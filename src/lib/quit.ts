import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { IS_TAURI } from "./transport";
import { flushPersistGrid, useSwarm } from "@/store";
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
 * warning about them would just be noise.
 */
export function quitBlockerIds(): string[] {
  const { agents, order, settings } = useSwarm.getState();
  const open = order.filter((id) => !!agents[id]);
  const busy = open.filter((id) => agentIsBusy(agents[id]));
  if (settings.restoreAgents === true) return busy;
  return [...busy, ...open.filter((id) => !agentIsBusy(agents[id]))];
}

// set once the user confirmed quitting — lets the re-issued close() pass the guard
let confirmed = false;

/**
 * Warn before the app closes while quitting would lose something: agents
 * still working, or open terminals that won't be restored (quitBlockerIds).
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
    e.preventDefault();
    const blockers = quitBlockerIds();
    if (blockers.length > 0) {
      useSwarm.getState().setQuitConfirm(blockers);
      return;
    }
    // the debounced grid snapshot must hit disk before the webview goes away;
    // the re-issued close() passes the guard via `confirmed` (window-state
    // plugin still saves on the real close)
    void flushPersistGrid().finally(() => {
      confirmed = true;
      void win.close();
    });
  });
  const unlistenQuit = listen("app://quit-requested", () => {
    const blockers = quitBlockerIds();
    if (blockers.length === 0 || confirmed) {
      void flushPersistGrid().finally(() => {
        confirmed = true;
        void win.close();
      });
    } else {
      useSwarm.getState().setQuitConfirm(blockers);
    }
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
  void flushPersistGrid().finally(() => {
    confirmed = true;
    void getCurrentWindow().close();
  });
}
