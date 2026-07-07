import { create } from "zustand";
import {
  fetchCodexAccountLimits,
  fetchSubscriptionLimits,
} from "./transport";
import type { CodexAccountLimits, SubscriptionLimits } from "@/types";

const POLL_MS = 60_000;

interface LimitsState {
  limits: SubscriptionLimits | null;
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
 * Subscription/rate limits, polled once a minute: the Claude OAuth usage
 * endpoint plus the account-level Codex `rate_limits` scan. Pauses while the
 * window is hidden and refreshes immediately when it becomes visible again.
 */
export const useLimits = create<LimitsState>((set) => ({
  limits: null,
  codex: null,
  loaded: false,
  start: () => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const refresh = async () => {
      try {
        // null = no Claude login on this machine → hide the meters
        set({ limits: await fetchSubscriptionLimits(), loaded: true });
      } catch {
        // transient fetch error → keep showing the last known values
        set({ loaded: true });
      }
      try {
        const codex = await fetchCodexAccountLimits();
        // `limits: null` = still no data on disk — keep the last real values
        // so a purged/rotated session tree doesn't blank a live meter
        if (codex.limits) set({ codex });
      } catch {
        /* transient error → keep the last known values */
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
