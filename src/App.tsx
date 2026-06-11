import { useEffect, useRef, useState } from "react";
import { TooltipProvider } from "./components/ui/tooltip";
import { TitleBar } from "./components/TitleBar";
import { WorkspaceLayer } from "./components/WorkspaceLayer";
import { FloatingTerminals } from "./components/FloatingTerminals";
import { CloseAgentDialog } from "./components/CloseAgentDialog";
import { CloseWorkspaceDialog } from "./components/CloseWorkspaceDialog";
import { CommandPalette } from "./components/CommandPalette";
import { InsertCommandPalette } from "./components/InsertCommandPalette";
import { QuitConfirmDialog } from "./components/QuitConfirmDialog";
import { NewAgentDialog } from "./components/NewAgentDialog";
import { LoadPresetDialog } from "./components/LoadPresetDialog";
import { SavePresetDialog } from "./components/SavePresetDialog";
import { ProfilesDialog } from "./components/ProfilesDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { UsageDashboard } from "./components/UsageDashboard";
import { WebDirectoryPicker } from "./components/WebDirectoryPicker";
import { useSwarm } from "./store";
import { useUpdates } from "./lib/updates";
import { useLimits } from "./lib/limits";
import { startGitPolling } from "./lib/git";
import { startQuitGuard } from "./lib/quit";
import { startFileDropListener } from "./lib/dnd";
import { fetchKeyStatus } from "./lib/openrouter";
import { fetchLocalSttStatus } from "./lib/local-stt";
import {
  armHoldDictation,
  cancelHoldDictation,
  dictationReady,
  finishHoldDictation,
  startDictation,
  stopDictation,
} from "./lib/dictation";
import { encodeProjectDir } from "./lib/utils";
import {
  ensureNotifyPermission,
  fetchUsageForSession,
  getHome,
  notify,
  onUsageChanged,
} from "./lib/transport";

export default function App() {
  const hydrate = useSwarm((s) => s.hydrate);
  const setUsage = useSwarm((s) => s.setUsage);
  const setNewAgentOpen = useSwarm((s) => s.setNewAgentOpen);
  const splitActive = useSwarm((s) => s.splitActive);
  const requestRemoveAgent = useSwarm((s) => s.requestRemoveAgent);
  const createFloatingTerminal = useSwarm((s) => s.createFloatingTerminal);
  const adjustFontSize = useSwarm((s) => s.adjustFontSize);

  const [profilesOpen, setProfilesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const homeRef = useRef<string>("");
  const notifyGranted = useRef(false);
  const prevAttention = useRef<Set<string>>(new Set());

  // init
  useEffect(() => {
    void hydrate();
    void getHome().then((h) => (homeRef.current = h));
    void ensureNotifyPermission().then((g) => (notifyGranted.current = g));
    const updates = useUpdates.getState();
    updates.startBackgroundPolling();
    const stopLimits = useLimits.getState().start();
    const stopGit = startGitPolling();
    const stopQuitGuard = startQuitGuard();
    const stopFileDrop = startFileDropListener();
    // dictation UI is hidden until a working OpenRouter key is found
    // (or, with the local engine, the local speech model is installed)
    void fetchKeyStatus()
      .then((st) => useSwarm.getState().setOpenrouterStatus(st))
      .catch(() => {});
    void fetchLocalSttStatus()
      .then((st) => useSwarm.getState().setLocalSttStatus(st))
      .catch(() => {});
    return () => {
      updates.stopBackgroundPolling();
      stopLimits();
      stopGit();
      stopQuitGuard();
      stopFileDrop();
    };
  }, [hydrate]);

  // usage refresh — each agent shows ONLY its own session's usage.
  // Watcher events are filtered to the project dirs of open agents, all
  // triggers are coalesced (min 2s apart), and nothing runs while the
  // window is hidden (one refresh fires on becoming visible again).
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastRun = 0;
    let pendingWhileHidden = false;
    const MIN_GAP_MS = 2000;

    const refresh = async () => {
      const { agents, order } = useSwarm.getState();
      await Promise.all(
        order.map(async (id) => {
          const a = agents[id];
          if (!a) return;
          const dir = a.cwd || homeRef.current;
          if (!dir) return;
          // session discovery is gated on real activity: a pane whose claude
          // never went busy has no session file of its own and would latch
          // (and later resume) a sibling session born in the same folder
          if (!a.sessionId && !a.firstBusyAt) return;
          // discovery floor: only files born around the first activity match,
          // not anything since pane creation (5s + backend skew). A latched
          // session parses the whole file — the backend ignores `since` then
          const since = a.sessionId
            ? a.createdAt
            : Math.max(a.createdAt, a.firstBusyAt! - 5000);
          // sessions other agents have latched onto — with several agents in
          // the same folder, an unlatched pane must never match a sibling's file
          const exclude = order
            .filter((oid) => oid !== id)
            .map((oid) => agents[oid]?.sessionId)
            .filter((s): s is string => !!s);
          try {
            const u = await fetchUsageForSession(dir, since, a.sessionId, exclude);
            if (alive && u) setUsage(id, u);
          } catch {
            /* ignore */
          }
        }),
      );
    };

    const schedule = () => {
      if (!alive) return;
      if (document.hidden) {
        pendingWhileHidden = true;
        return;
      }
      if (timer) return; // a run is already scheduled — coalesce
      const wait = Math.max(0, lastRun + MIN_GAP_MS - Date.now());
      timer = setTimeout(() => {
        timer = null;
        lastRun = Date.now();
        void refresh();
      }, wait);
    };

    lastRun = Date.now();
    void refresh();
    const interval = setInterval(schedule, 4000);
    const unlistenP = onUsageChanged((changedDirs) => {
      // ignore changes from sessions we're not displaying (other Claude
      // instances writing to ~/.claude/projects); empty = unknown → refresh
      if (changedDirs && changedDirs.length > 0) {
        const { agents, order } = useSwarm.getState();
        const watched = new Set(
          order
            .map((id) => agents[id]?.cwd || homeRef.current)
            .filter(Boolean)
            .map(encodeProjectDir),
        );
        if (!changedDirs.some((d) => watched.has(d))) return;
      }
      schedule();
    });
    const onVisibility = () => {
      if (!document.hidden && pendingWhileHidden) {
        pendingWhileHidden = false;
        schedule();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      void unlistenP.then((u) => u());
    };
  }, [setUsage]);

  // native notification when an agent rings the bell / needs attention
  useEffect(() => {
    const unsub = useSwarm.subscribe((state) => {
      const nowAttention = new Set<string>();
      for (const id of state.order) {
        const a = state.agents[id];
        if (a?.attention) {
          nowAttention.add(id);
          if (!prevAttention.current.has(id) && notifyGranted.current) {
            void notify(`🔔 ${a.name}`, "Agent needs your attention");
          }
        }
      }
      prevAttention.current = nowAttention;
    });
    return unsub;
  }, []);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      const s = useSwarm.getState();
      if (k === "meta") {
        // plain ⌘ is the push-to-talk key (hold mode): recording arms after a
        // short delay so ⌘-shortcuts never open the mic
        if (
          (s.settings.dictationHotkeyMode ?? "hold") === "hold" &&
          !e.repeat
        ) {
          armHoldDictation(() => {
            const st = useSwarm.getState();
            return st.focusedAgentId ?? st.activeAgentId();
          });
        }
        return;
      }
      // any other key while plain-⌘ dictation is armed/recording means a
      // shortcut, not speech — abort silently, then handle the shortcut
      cancelHoldDictation();
      if (k === "t") {
        e.preventDefault();
        setNewAgentOpen(true);
      } else if (k === ",") {
        // macOS convention: ⌘, opens settings
        e.preventDefault();
        setSettingsOpen(true);
      } else if (k === "k" && e.shiftKey) {
        // ⌘⇧K must come before plain ⌘K — that branch doesn't check shift
        e.preventDefault();
        s.setCommandPickerOpen(!s.commandPickerOpen);
      } else if (k === "k") {
        e.preventDefault();
        s.setPaletteOpen(!s.paletteOpen);
      } else if (k === "e") {
        e.preventDefault();
        s.setFleetOpen(!s.fleetOpen);
      } else if (k === "a" && e.shiftKey) {
        // jump to the next agent waiting for input, across all workspaces
        e.preventDefault();
        s.attentionJump();
      } else if (k === "n" && e.shiftKey) {
        e.preventDefault();
        s.createWorkspace();
      } else if (k === "d") {
        e.preventDefault();
        splitActive(e.shiftKey ? "column" : "row");
      } else if (k === "w" && e.shiftKey) {
        e.preventDefault();
        s.requestCloseWorkspace(s.activeWorkspaceId);
      } else if (k === "w") {
        const id = s.activeAgentId();
        if (id) {
          e.preventDefault();
          requestRemoveAgent(id);
        }
      } else if (k === "j") {
        // floating terminal for the active pane
        const id = s.activeAgentId();
        if (id) {
          e.preventDefault();
          createFloatingTerminal(id);
        }
      } else if (k === "m" && e.shiftKey) {
        // ⌘⇧M — toggle-mode dictation (hold mode listens to plain ⌘ instead)
        e.preventDefault();
        if (e.repeat || !dictationReady()) return;
        if ((s.settings.dictationHotkeyMode ?? "hold") !== "toggle") return;
        const d = s.dictation;
        if (d?.phase === "recording") {
          void stopDictation();
          return;
        }
        if (d) return; // transcribing — let it finish
        const target = s.focusedAgentId ?? s.activeAgentId();
        if (target) void startDictation(target);
      } else if (k >= "1" && k <= "9") {
        // ⌘1–9 switch workspaces
        const wid = s.workspaceOrder[Number(k) - 1];
        if (wid) {
          e.preventDefault();
          s.setActiveWorkspace(wid);
        }
      } else if (e.shiftKey && (k === "[" || k === "{" || k === "]" || k === "}")) {
        // ⌘⇧[ / ⌘⇧] cycle workspaces
        e.preventDefault();
        const idx = s.workspaceOrder.indexOf(s.activeWorkspaceId);
        const delta = k === "[" || k === "{" ? -1 : 1;
        const next =
          s.workspaceOrder[
            (idx + delta + s.workspaceOrder.length) % s.workspaceOrder.length
          ];
        if (next) s.setActiveWorkspace(next);
      } else if (k === "+" || k === "=" || k === "-" || k === "0") {
        // per-pane zoom — "=" covers ⌘+ on layouts where + needs shift (US)
        const id = s.activeAgentId();
        if (id) {
          e.preventDefault();
          adjustFontSize(id, k === "0" ? "reset" : k === "-" ? -1 : 1);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setNewAgentOpen, splitActive, requestRemoveAgent, createFloatingTerminal, adjustFontSize]);

  // push-to-talk release: letting go of ⌘ finishes (transcribes) a hold-mode
  // dictation; recordings shorter than ~1s are discarded in lib/dictation.ts.
  // Losing window focus mid-recording also finishes rather than cancels.
  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Meta") finishHoldDictation();
    };
    const onBlur = () => finishHoldDictation();
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
        <TitleBar
          onManageProfiles={() => setProfilesOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <main className="relative min-h-0 min-w-0 flex-1">
          {/* all workspace grids stay mounted in here — see WorkspaceLayer */}
          <WorkspaceLayer />
          {/* floating terminals live above the grids — and survive them (detached) */}
          <FloatingTerminals />
        </main>
      </div>

      <CloseAgentDialog />
      <CloseWorkspaceDialog />
      <QuitConfirmDialog />
      <NewAgentDialog />
      <LoadPresetDialog />
      <SavePresetDialog />
      <CommandPalette
        onOpenProfiles={() => setProfilesOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <InsertCommandPalette />
      <ProfilesDialog open={profilesOpen} onOpenChange={setProfilesOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <UsageDashboard />
      <WebDirectoryPicker />
    </TooltipProvider>
  );
}
