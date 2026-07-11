import { create } from "zustand";
import { fetchCodexAccountLimits } from "./transport";
import type { CodexAccountLimits } from "@/types";

const POLL_MS = 60_000;

interface LimitsState {
  /**
   * Account-level Codex limits (newest `rate_limits` event on disk).
   * `null` (or `limits: null` inside) = no data ever → the Deck shows
   * `CX —`; data with an old `as_of_ms` is annotated "as of HH:MM" there.
   */
  codex: CodexAccountLimits | null;
  /** false until the first fetch settles — lets the UI hide instead of flicker */
  loaded: boolean;
  start: () => () => void;
}

/**
 * Codex subscription/rate limits, polled once a minute (the account-level
 * `rate_limits` scan). Pauses while the window is hidden and refreshes
 * immediately when it becomes visible again.
 */
export const useLimits = create<LimitsState>((set) => ({
  codex: null,
  loaded: false,
  start: () => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const refresh = async () => {
      try {
        const codex = await fetchCodexAccountLimits();
        // `limits: null` = still no data on disk — keep the last real values
        // so a purged/rotated session tree doesn't blank a live meter
        set((s) => ({ loaded: true, codex: codex.limits ? codex : s.codex }));
      } catch {
        // transient error → keep the last known values
        set({ loaded: true });
      }
    };
    const startTimer = () => {
      if (!timer) timer = setInterval(refresh, POLL_MS);
    };
    const stopTimer = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        stopTimer();
      } else {
        void refresh();
        startTimer();
      }
    };

    void refresh();
    startTimer();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  },
}));
