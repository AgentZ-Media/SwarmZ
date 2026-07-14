import { useVibe } from "@/lib/vibe/session-store";
import { useMissions } from "./store";
import { useMissionOutbox } from "./outbox-store";
import { useRuntimeEnvironments } from "@/lib/runtime/store";
import { missionPersistenceReady } from "./controller-shared";
import { recoverOutboxAndAttempts, settleCompletedAttempt } from "./settlement-service";
import {
  admitStarts,
  enforceRunningStops,
  pauseMissionsWithRuntimeDrift,
} from "./scheduler-service";
import { runMissionControllerCycle } from "./controller-cycle";

const TICK_MS = 1_000;

let stopActiveController: (() => void) | null = null;
let tickRunning = false;

async function controllerTick(): Promise<void> {
  if (tickRunning || !missionPersistenceReady()) return;
  tickRunning = true;
  try {
    await runMissionControllerCycle({
      pauseRuntimeDrift: pauseMissionsWithRuntimeDrift,
      enforceStops: enforceRunningStops,
      recover: recoverOutboxAndAttempts,
      attempts: () => Object.values(useMissions.getState().projection.attempts),
      isRunning: (attempt) => attempt.status === "running",
      settle: settleCompletedAttempt,
      admit: admitStarts,
    });
  } catch (error) {
    console.error("[missions] controller tick failed:", error);
  } finally {
    tickRunning = false;
  }
}

/** Start the single outside-React Mission scheduler/worker lifecycle. */
export function startMissionController(): () => void {
  if (stopActiveController) return stopActiveController;
  let stopped = false;
  const wake = () => {
    if (!stopped) void controllerTick();
  };
  const missionUnsub = useMissions.subscribe(wake);
  const outboxUnsub = useMissionOutbox.subscribe(wake);
  const vibeUnsub = useVibe.subscribe(wake);
  const runtimeUnsub = useRuntimeEnvironments.subscribe(wake);
  const timer = setInterval(wake, TICK_MS);
  wake();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    missionUnsub();
    outboxUnsub();
    vibeUnsub();
    runtimeUnsub();
    stopActiveController = null;
  };
  stopActiveController = stop;
  return stop;
}
