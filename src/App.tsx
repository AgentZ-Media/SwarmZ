import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { TooltipProvider } from "./components/ui/tooltip";
import { TitleBar } from "./components/TitleBar";
import { VibeLayer } from "./components/vibe/VibeLayer";
import { Deck } from "./components/Deck";
import { Toasts } from "./components/Toasts";
import { QuitConfirmDialog } from "./components/QuitConfirmDialog";
import { CloseWorktreeDialog } from "./components/CloseWorktreeDialog";
import { useSwarm } from "./store";
import { useVibe } from "./lib/vibe/session-store";
import { humanAttention } from "./lib/vibe/attention";
import { useVibeUi } from "./lib/vibe/ui-store";
import { useUpdates } from "./lib/updates";
import { useLimits } from "./lib/limits";
import { startQuitGuard } from "./lib/quit";
import { startOrchestratorBus } from "./lib/orchestrator/bus";
import {
  deliverTimerTurn,
  notifyTimerNotice,
  runAutonomousTurn,
  startVibeSessionActivityWatcher,
} from "./lib/orchestrator/controller";
import {
  registerTimerDelivery,
  registerTimerNotice,
} from "./lib/orchestrator/timers";
import { registerAutonomousRunner } from "./lib/orchestrator/triggers";
import { startGithubController } from "./lib/github/controller";
import {
  activateProjectByIndex,
  closeSession,
} from "./lib/vibe/controller";
import { ensureNotifyPermission, notify } from "./lib/transport";
import { startMissionController } from "./lib/missions/controller";
import { startMissionSchedules } from "./lib/missions/schedules";
import { startMissionOutboxCompaction } from "./lib/missions/outbox-compaction";
import { useProjects } from "./lib/projects/store";
import { startIntegrationController } from "./lib/integration/controller";
import {
  installAttentionSoundUnlock,
  newlyWaitingSessions,
  playAttentionSound,
} from "./lib/attention/sound";

// Optional surfaces are sizeable and closed on a normal launch. Keep them out
// of the startup graph; after first use they remain mounted so Radix can finish
// close animations and restore focus correctly.
const CommandPalette = lazy(() =>
  import("./components/CommandPalette").then((module) => ({
    default: module.CommandPalette,
  })),
);
const SettingsDialog = lazy(() =>
  import("./components/SettingsDialog").then((module) => ({
    default: module.SettingsDialog,
  })),
);
const QuickNotesPanel = lazy(() =>
  import("./components/QuickNotesPanel").then((module) => ({
    default: module.QuickNotesPanel,
  })),
);
const UsageDashboard = lazy(() =>
  import("./components/UsageDashboard").then((module) => ({
    default: module.UsageDashboard,
  })),
);
const GitHubPanel = lazy(() =>
  import("./components/GitHubPanel").then((module) => ({
    default: module.GitHubPanel,
  })),
);
const RuntimeEnvironmentsPanel = lazy(() =>
  import("./components/RuntimeEnvironmentsPanel").then((module) => ({
    default: module.RuntimeEnvironmentsPanel,
  })),
);

// dev-only orchestrator smoke-test hook (`window.__orch`) — the DEV guard
// makes production builds drop the import entirely
if (import.meta.env.DEV) void import("./lib/orchestrator/dev");
// dev-only Vibe smoke-test hook (`window.__vibe`) — same DEV guard
if (import.meta.env.DEV) void import("./lib/vibe/dev");

export default function App() {
  const hydrate = useSwarm((s) => s.hydrate);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const activeProjectId = useProjects((state) => state.activeProjectId);
  const activeProjectDir = useProjects((state) =>
    state.activeProjectId ? state.projects[state.activeProjectId]?.dir ?? null : null,
  );
  const paletteOpen = useSwarm((s) => s.paletteOpen);
  const dashboardOpen = useSwarm((s) => s.dashboardOpen);
  const notesOpen = useSwarm((s) => s.notesOpen);
  const githubOpen = useSwarm((s) => s.githubOpen);
  const paletteRequested = useLoadOnce(paletteOpen);
  const settingsRequested = useLoadOnce(settingsOpen);
  const dashboardRequested = useLoadOnce(dashboardOpen);
  const notesRequested = useLoadOnce(notesOpen);
  const githubRequested = useLoadOnce(githubOpen);
  const runtimeRequested = useLoadOnce(runtimeOpen);
  const notifyGranted = useRef(false);

  // init
  useEffect(() => {
    // conductor timers deliver autonomous turns through the controller —
    // registered BEFORE hydrate so missed timers can fire right away; the
    // notice sink makes expired/claim-dropped timers visible in the chat
    registerTimerDelivery(deliverTimerTurn);
    registerTimerNotice(notifyTimerNotice);
    // the Phase-5 trigger router runs event-triggered autonomous turns
    // (agent finished/blocked, approval escalation, idle) through the same
    // budget-gated core — registered, not imported, to keep imports acyclic
    registerAutonomousRunner(runAutonomousTurn);
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
    // GitHub integration (Phase 7): repo/PR detection, the Rust write-gate
    // sync, the PR watcher and its pr-changed → ticker/autonomy routing
    const stopGithub = startGithubController();
    // Durable Mission scheduler: remains fail-closed until missions, outbox
    // and session stores hydrate; owns only temporary one-assignment workers.
    const stopMissions = startMissionController();
    const stopMissionSchedules = startMissionSchedules();
    const stopMissionOutboxCompaction = startMissionOutboxCompaction();
    // Integration trains consume only independently verified attempt commits
    // and execute combined regression behind the durable outbox boundary.
    const stopIntegration = startIntegrationController();
    return () => {
      updates.stopBackgroundPolling();
      stopLimits();
      stopQuitGuard();
      stopOrchestratorBus();
      stopVibePings();
      stopGithub();
      stopMissions();
      stopMissionSchedules();
      stopMissionOutboxCompaction();
      stopIntegration();
    };
  }, [hydrate]);

  // the motion off-switch (Settings → Appearance): data-motion="off" on the
  // root collapses every nonessential animation (styles.css)
  const reduceMotion = useSwarm((s) => !!s.settings.reduceMotion);
  useEffect(() => {
    document.documentElement.setAttribute(
      "data-motion",
      reduceMotion ? "off" : "on",
    );
  }, [reduceMotion]);

  // WebKit and other browser engines allow Web Audio after a user gesture.
  // Prime only while the persisted preference is enabled; enabling it from
  // Settings plays an intentional preview in that same click gesture.
  const attentionSoundEnabled = useSwarm(
    (s) => s.settings.attentionSound !== false,
  );
  useEffect(() => {
    if (!attentionSoundEnabled) return;
    return installAttentionSoundUnlock();
  }, [attentionSoundEnabled]);

  // Notify/sound only on a NEW no-attention → attention edge. The first fully
  // hydrated state is the seed, so historic blockers never make noise merely
  // because SwarmZ launched. Structured needs_human reports share the sound;
  // native notifications retain their existing approval-only contract.
  useEffect(() => {
    let seeded = false;
    let previous = new Set<string>();
    const unsub = useVibe.subscribe((state) => {
      if (!state.hydrated) return;
      const current = new Set<string>();
      const kinds = new Map<string, "approval" | "report">();
      for (const id of state.order) {
        const entry = state.sessions[id];
        const attention = entry ? humanAttention(entry) : null;
        if (!attention) continue;
        current.add(id);
        kinds.set(id, attention.kind);
      }
      if (!seeded) {
        previous = current;
        seeded = true;
        return;
      }
      const newlyWaiting = newlyWaitingSessions(previous, current);
      for (const id of newlyWaiting) {
        const entry = state.sessions[id];
        if (entry && kinds.get(id) === "approval" && notifyGranted.current) {
          void notify(`🔔 ${entry.session.name}`, "Session needs your approval");
        }
      }
      if (
        newlyWaiting.length > 0 &&
        useSwarm.getState().settings.attentionSound !== false
      ) {
        void playAttentionSound();
      }
      previous = current;
    });
    // subscribe() does not call the listener immediately. If hydration already
    // completed before this effect, seed from the authoritative current state.
    const initial = useVibe.getState();
    if (initial.hydrated) {
      previous = new Set(
        initial.order.filter((id) => {
          const entry = initial.sessions[id];
          return !!entry && humanAttention(entry) !== null;
        }),
      );
      seeded = true;
    }
    return unsub;
  }, []);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⎋ — collapse the focused agent back to the fleet grid (wide first).
      // Guards: dialogs own their Escape (Radix + the approval takeover call
      // preventDefault before this window listener runs), and typing surfaces
      // keep Escape for themselves.
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey) {
        if (e.defaultPrevented) return;
        if (document.querySelector('[role="dialog"]')) return;
        const t = e.target as HTMLElement | null;
        if (
          t &&
          (t.tagName === "INPUT" ||
            t.tagName === "TEXTAREA" ||
            t.isContentEditable)
        )
          return;
        const ui = useVibeUi.getState();
        if (ui.wide) {
          e.preventDefault();
          ui.setWide(false);
        } else if (ui.stageMode === "session") {
          e.preventDefault();
          ui.backToFleet();
        }
        return;
      }
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
        // new native Codex agent
        e.preventDefault();
        useVibeUi.getState().setNewSessionOpen(true);
      } else if (k === "m" && e.shiftKey) {
        // mission intake is intentionally distinct from the low-level worker
        e.preventDefault();
        useVibeUi.getState().setMissionCreateOpen(true);
      } else if (k === "b") {
        // ⌘B — toggle the Conductor sidebar
        e.preventDefault();
        useVibeUi.getState().toggleConductor();
      } else if (k === "o" && e.shiftKey) {
        // ⌘⇧O — the orchestrator surface: show the Conductor sidebar + fleet
        e.preventDefault();
        useVibeUi.getState().showConductor();
      } else if (k === "a" && e.shiftKey) {
        // unified queue: mission blockers and live worker approvals
        e.preventDefault();
        useVibeUi.getState().setAttentionOpen(true);
      } else if (k === "n") {
        // quick notes drawer (closing while open is handled in the dialog branch)
        e.preventDefault();
        s.setNotesOpen(true);
      } else if (k >= "1" && k <= "9" && !e.shiftKey && !e.altKey) {
        // ⌘1–⌘9 — switch to the n-th project tab
        e.preventDefault();
        activateProjectByIndex(Number(k) - 1);
      } else if (k === "w") {
        // ⌘W — close the FOCUSED agent (browser-tab muscle memory). Always
        // preventDefault first: unhandled it falls through to the native menu's
        // Close Window item and quits the whole app (the invariant). With no
        // agent focused it stays a safe no-op — ⌘W never closes a project tab
        // (that stays an explicit gesture, and closing a tab keeps its agents).
        e.preventDefault();
        const ui = useVibeUi.getState();
        if (ui.stageMode === "session") {
          const v = useVibe.getState();
          const id = v.activeId;
          if (id && v.sessions[id]) {
            // busy → the same confirm dialog the card's close button raises
            if (v.busy[id]) ui.setCloseConfirmId(id);
            else void closeSession(id);
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg">
        <TitleBar
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenRuntime={() => setRuntimeOpen(true)}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 min-w-0 flex-1">
            <VibeLayer />
          </div>
          {/* the Deck: fleet counters, event ticker, meters, conductor dot */}
          <Deck />
        </main>
      </div>

      <Toasts />
      <QuitConfirmDialog />
      <CloseWorktreeDialog />
      {paletteRequested && (
        <Suspense fallback={<SurfaceLoading label="Opening search" />}>
          <CommandPalette onOpenSettings={() => setSettingsOpen(true)} />
        </Suspense>
      )}
      {settingsRequested && (
        <Suspense fallback={<SurfaceLoading label="Opening settings" />}>
          <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        </Suspense>
      )}
      {dashboardRequested && (
        <Suspense fallback={<SurfaceLoading label="Opening usage" side />}>
          <UsageDashboard />
        </Suspense>
      )}
      {notesRequested && (
        <Suspense fallback={<SurfaceLoading label="Opening notes" side />}>
          <QuickNotesPanel />
        </Suspense>
      )}
      {githubRequested && (
        <Suspense fallback={<SurfaceLoading label="Opening GitHub" side />}>
          <GitHubPanel />
        </Suspense>
      )}
      {runtimeRequested && (
        <Suspense fallback={<SurfaceLoading label="Opening runtimes" side />}>
          <RuntimeEnvironmentsPanel
            open={runtimeOpen}
            onOpenChange={setRuntimeOpen}
            projectId={activeProjectId}
            projectDir={activeProjectDir}
          />
        </Suspense>
      )}
    </TooltipProvider>
  );
}

/** Request a lazy surface on first open, then keep it mounted permanently. */
function useLoadOnce(open: boolean): boolean {
  const [requested, setRequested] = useState(open);
  useEffect(() => {
    if (open) setRequested(true);
  }, [open]);
  return requested || open;
}

/** Branded, non-empty first-load state for optional dialogs and drawers. */
function SurfaceLoading({
  label,
  side = false,
}: {
  label: string;
  side?: boolean;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-50 flex bg-black/45"
    >
      <div
        role="status"
        aria-live="polite"
        className={
          side
            ? "ml-auto flex h-full w-[min(92vw,32rem)] items-center justify-center border-l border-line bg-panel"
            : "m-auto flex h-24 w-[min(88vw,28rem)] items-center justify-center rounded-xl border border-line bg-panel shadow-2xl"
        }
      >
        <span aria-hidden className="mr-2 h-2 w-2 animate-pulse rounded-full bg-acc" />
        <span className="font-mono text-12 text-mut">{label}…</span>
      </div>
    </div>
  );
}
