import { fetchGitInfo } from "./transport";
import { useSwarm } from "@/store";

const POLL_MS = 7000;

/**
 * Live git status per agent pane, polled every few seconds. One fetch per
 * distinct cwd — agents sharing a folder share the result. Pauses while the
 * window is hidden and refreshes immediately when it becomes visible again.
 */
export function startGitPolling(): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const refresh = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const { agents, order, settings } = useSwarm.getState();
      const gitBin = settings.gitPath?.trim() || undefined;
      const byCwd = new Map<string, string[]>();
      for (const id of order) {
        const cwd = agents[id]?.cwd;
        if (!cwd) continue;
        const ids = byCwd.get(cwd);
        if (ids) ids.push(id);
        else byCwd.set(cwd, [id]);
      }
      await Promise.all(
        [...byCwd].map(async ([cwd, ids]) => {
          try {
            const info = await fetchGitInfo(cwd, gitBin);
            const { setGitInfo } = useSwarm.getState();
            for (const id of ids) setGitInfo(id, info);
          } catch {
            /* backend unreachable — keep the last known state */
          }
        }),
      );
    } finally {
      inFlight = false;
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
}
