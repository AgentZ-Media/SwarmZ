import { useEffect, useRef, useState } from "react";
import { TooltipProvider } from "./components/ui/tooltip";
import { TitleBar } from "./components/TitleBar";
import { VibeLayer } from "./components/vibe/VibeLayer";
import { Deck } from "./components/Deck";
import { CommandPalette } from "./components/CommandPalette";
import { QuitConfirmDialog } from "./components/QuitConfirmDialog";
import { CloseWorktreeDialog } from "./components/CloseWorktreeDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { QuickNotesPanel } from "./components/QuickNotesPanel";
import { UsageDashboard } from "./components/UsageDashboard";
import { useSwarm } from "./store";
import { useVibe } from "./lib/vibe/session-store";
import { hasPendingApproval } from "./lib/vibe/ui";
import { useVibeUi } from "./lib/vibe/ui-store";
import { useUpdates } from "./lib/updates";
import { useLimits } from "./lib/limits";
import { startQuitGuard } from "./lib/quit";
import { startOrchestratorBus } from "./lib/orchestrator/bus";
import {
  deliverTimerTurn,
  notifyTimerNotice,
  startVibeSessionActivityWatcher,
} from "./lib/orchestrator/controller";
import {
  registerTimerDelivery,
  registerTimerNotice,
} from "./lib/orchestrator/timers";
import { vibeTriageEntries } from "./lib/vibe/triage";
import { activateProjectByIndex, focusSession } from "./lib/vibe/controller";
import { ensureNotifyPermission, notify } from "./lib/transport";

// dev-only orchestrator smoke-test hook (`window.__orch`) — the DEV guard
// makes production builds drop the import entirely
if (import.meta.env.DEV) void import("./lib/orchestrator/dev");
// dev-only Vibe smoke-test hook (`window.__vibe`) — same DEV guard
if (import.meta.env.DEV) void import("./lib/vibe/dev");

export default function App() {
  const hydrate = useSwarm((s) => s.hydrate);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const notifyGranted = useRef(false);
  const prevPending = useRef<Set<string>>(new Set());

  // init
  useEffect(() => {
    // conductor timers deliver autonomous turns through the controller —
    // registered BEFORE hydrate so missed timers can fire right away; the
    // notice sink makes expired/claim-dropped timers visible in the chat
    registerTimerDelivery(deliverTimerTurn);
    registerTimerNotice(notifyTimerNotice);
    void hydrate();
    void ensureNotifyPermission().then((g) => (notifyGranted.current = g));
    const updates = useUpdates.getState();
    updates.startBackgroundPolling();
    const stopLimits = useLimits.getState().start();
    const stopQuitGuard = startQuitGuard();
    // orchestrator tool bus: executes Rust-dispatched tool requests against
    // the stores — registered once, guarded against double starts
    const stopOrchestratorBus = startOrchestratorBus();
    // orchestrator status pings: busy → idle / pending-approval transitions
    // of sessions an orchestrator chat prompted become system pings there
    const stopVibePings = startVibeSessionActivityWatcher();
    return () => {
      updates.stopBackgroundPolling();
      stopLimits();
      stopQuitGuard();
      stopOrchestratorBus();
      stopVibePings();
    };
  }, [hydrate]);

  // native notification when a session raises a pending approval (needs-you)
  useEffect(() => {
    const unsub = useVibe.subscribe((state) => {
      const nowPending = new Set<string>();
      for (const id of state.order) {
        const entry = state.sessions[id];
        if (entry && hasPendingApproval(entry)) {
          nowPending.add(id);
          if (!prevPending.current.has(id) && notifyGranted.current) {
            void notify(`🔔 ${entry.session.name}`, "Session needs your approval");
          }
        }
      }
      prevPending.current = nowPending;
    });
    return unsub;
  }, []);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      const s = useSwarm.getState();
      // Radix dialogs trap focus but keydown still bubbles to the window —
      // shortcuts must not act on the app underneath an open dialog
      const dialogOpen = !!document.querySelector('[role="dialog"]');
      if (dialogOpen) {
        // the palette owns its toggle — ⌘K may still close it; the notes
        // drawer counts as a dialog — ⌘N may still toggle it shut. ⌘W stays
        // claimed (no-op): unprevented it'd reach the native menu's Close
        // Window item and quit the app from under the dialog.
        if (k === "k" && s.paletteOpen) {
          e.preventDefault();
          s.setPaletteOpen(false);
        } else if (k === "n" && !e.shiftKey && s.notesOpen) {
          e.preventDefault();
          s.setNotesOpen(false);
        } else if (k === "w") {
          e.preventDefault();
        }
        return;
      }
      if (k === ",") {
        // macOS convention: ⌘, opens settings
        e.preventDefault();
        setSettingsOpen(true);
      } else if (k === "k") {
        e.preventDefault();
        s.setPaletteOpen(!s.paletteOpen);
      } else if (k === "t") {
        // new native Codex session
        e.preventDefault();
        useVibeUi.getState().setNewSessionOpen(true);
      } else if (k === "o" && e.shiftKey) {
        // ⌘⇧O — the orchestrator surface: the Conductor stage
        e.preventDefault();
        useVibeUi.getState().setStageMode("conductor");
      } else if (k === "a" && e.shiftKey) {
        // jump to the oldest session waiting on the human
        e.preventDefault();
        const entries = vibeTriageEntries(useVibe.getState());
        if (entries.length) focusSession(entries[0].id);
      } else if (k === "n") {
        // quick notes drawer (closing while open is handled in the dialog branch)
        e.preventDefault();
        s.setNotesOpen(true);
      } else if (k >= "1" && k <= "9" && !e.shiftKey && !e.altKey) {
        // ⌘1–⌘9 — switch to the n-th project tab
        e.preventDefault();
        activateProjectByIndex(Number(k) - 1);
      } else if (k === "w") {
        // always claim ⌘W: unhandled it falls through to the native menu's
        // Close Window item and closes the whole app
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
        <TitleBar onOpenSettings={() => setSettingsOpen(true)} />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 min-w-0 flex-1">
            <VibeLayer />
          </div>
          {/* the Deck: triage queue, event ticker, meters, orch status */}
          <Deck />
        </main>
      </div>

      <QuitConfirmDialog />
      <CloseWorktreeDialog />
      <CommandPalette onOpenSettings={() => setSettingsOpen(true)} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <UsageDashboard />
      <QuickNotesPanel />
    </TooltipProvider>
  );
}
