import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { IS_TAURI } from "./transport";
import { flushPersistGrid, useSwarm } from "@/store";

/** Agents whose Claude is actively working right now (OSC 9;4 busy). */
export function workingAgentIds(): string[] {
  const { agents, order } = useSwarm.getState();
  return order.filter((id) => {
    const a = agents[id];
    return (
      !!a &&
      (a.status === "running" || a.status === "attention") &&
      a.activity === "busy"
    );
  });
}

// set once the user confirmed quitting — lets the re-issued close() pass the guard
let confirmed = false;

/**
 * Warn before the app closes while agents are still working.
 *
 * Native: window close (red button) is intercepted via onCloseRequested;
 * ⌘Q / menu quit is prevented in Rust (lib.rs) and forwarded here as
 * `app://quit-requested`. Both raise the QuitConfirmDialog listing the busy
 * agents; confirming closes the window the normal way (window-state plugin
 * still saves, the app exits once the last window is gone).
 *
 * Web: a plain beforeunload guard — browsers only allow their generic prompt.
 */
export function startQuitGuard(): () => void {
  if (!IS_TAURI) {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (workingAgentIds().length > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }

  const win = getCurrentWindow();
  const unlistenClose = win.onCloseRequested((e) => {
    if (confirmed) return;
    e.preventDefault();
    const busy = workingAgentIds();
    if (busy.length > 0) {
      useSwarm.getState().setQuitConfirm(busy);
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
    const busy = workingAgentIds();
    if (busy.length === 0 || confirmed) {
      void flushPersistGrid().finally(() => {
        confirmed = true;
        void win.close();
      });
    } else {
      useSwarm.getState().setQuitConfirm(busy);
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
