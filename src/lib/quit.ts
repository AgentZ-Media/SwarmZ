import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { IS_TAURI } from "./transport";
import { flushAllPersists, useSwarm } from "@/store";
import { vibeBusyIds } from "./vibe/controller";

// set once the user confirmed quitting — lets the re-issued close() pass the guard
let confirmed = false;

async function closeOrConfirm(win: { close: () => Promise<void> }) {
  // a Vibe session with a turn in flight loses the run — warn first
  const blockers = vibeBusyIds();
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
