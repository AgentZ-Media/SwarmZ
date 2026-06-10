import { create } from "zustand";
import { fetchSubscriptionLimits } from "./transport";
import type { SubscriptionLimits } from "@/types";

const POLL_MS = 60_000;

interface LimitsState {
  limits: SubscriptionLimits | null;
  /** false until the first fetch settles — lets the UI hide instead of flicker */
  loaded: boolean;
  start: () => () => void;
}

/**
 * Claude subscription limits, polled once a minute. Pauses while the window
 * is hidden and refreshes immediately when it becomes visible again.
 */
export const useLimits = create<LimitsState>((set) => ({
  limits: null,
  loaded: false,
  start: () => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const refresh = async () => {
      try {
        set({ limits: await fetchSubscriptionLimits(), loaded: true });
      } catch {
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
