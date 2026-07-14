/**
 * Stable public facade for the Conductor runtime.
 *
 * Implementation state lives in focused services:
 * - chat-delivery: backend/thread binding, event streaming and human sends
 * - session-watcher: fleet transitions, pings and trigger production
 * - autonomous-dispatcher: budgeted autonomous turns and timer delivery
 */
export {
  busyConductorProjectNames,
  chatIdForBackend,
  compactChat,
  createChat,
  ensureFreshProjectChat,
  interrupt,
  refreshStatus,
  removeChat,
  sendMessage,
} from "./chat-delivery";

export { startVibeSessionActivityWatcher } from "./session-watcher";

export {
  deliverTimerTurn,
  isAutonomousTurnInFlight,
  notifyTimerNotice,
  runAutonomousTurn,
} from "./autonomous-dispatcher";
