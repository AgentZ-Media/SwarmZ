import { useEffect, useRef } from "react";
import { DEFAULT_FONT_SIZE, useSwarm } from "@/store";
import { applyClaudePath, resumeStartup } from "@/lib/utils";
import {
  attachTerm,
  focusTerm,
  setTermCursorBlink,
  setTermFontSize,
  type TermHandlers,
} from "@/lib/term-host";

/**
 * Terminal titles (OSC 0/2) the pane should adopt as agent name — claude's
 * auto-generated topic, /rename titles, … Shell noise is filtered out: cwd
 * titles, the echoed startup command, bare shell names.
 */
function cleanTitle(raw: string, startup: string): string | null {
  const t = raw.replace(/^[✳✶✻✽✢·]\s*/, "").trim();
  if (!t) return null;
  if (t.startsWith("/") || t.startsWith("~")) return null;
  const cmd = startup.trim();
  if (cmd && (t === cmd || t === cmd.split(/\s+/)[0])) return null;
  if (/^-?(zsh|bash|fish|sh)$/.test(t)) return null;
  return t;
}

/**
 * Mounts the persistent terminal for `agentId` (see lib/term-host.ts: xterm +
 * PTY live outside React). Unmounting only detaches the DOM — the terminal
 * keeps running and re-attaches on the next mount, which is what lets agent
 * panes move between workspaces. The PTY dies when the store removes its
 * owner (removeAgent / removeFloatingTerminal → destroyTerm).
 */
export function TerminalView({
  agentId,
  cwd,
  startup,
  active,
  onCommand,
}: {
  agentId: string;
  cwd?: string;
  startup: string;
  active: boolean;
  /**
   * Fires with the line the user typed when they hit Enter (floating
   * terminals name themselves after it). Best-effort: history recall, line
   * editing via escape sequences and pastes make the buffer unreliable —
   * those lines are skipped rather than guessed.
   */
  onCommand?: (command: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // keep the latest callback without re-attaching
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;

  const fontSize = useSwarm(
    (s) =>
      s.agents[agentId]?.fontSize ??
      s.settings.defaultFontSize ??
      DEFAULT_FONT_SIZE,
  );

  useEffect(() => {
    if (!containerRef.current) return;
    const store = useSwarm.getState();
    const handlers: TermHandlers = {
      // for floating terminals these store calls no-op (no agent with this id);
      // FloatingTerminals wires its own exit listener for the status pill
      onStatus: (status) => useSwarm.getState().setStatus(agentId, status),
      onBell: () => useSwarm.getState().setAttention(agentId, true),
      onTitle: (raw) => {
        const title = cleanTitle(raw, startup);
        if (title) useSwarm.getState().setAgentTitle(agentId, title);
      },
      onActivity: (activity) =>
        useSwarm.getState().setActivity(agentId, activity),
      // only floats pass onCommand — skipping it spares the per-key line buffer
      onCommand: onCommand ? (cmd) => onCommandRef.current?.(cmd) : undefined,
    };
    return attachTerm(agentId, containerRef.current, {
      cwd,
      // restored panes reopen their previous claude conversation (--resume);
      // agent.startup stays clean for split-prefill and the grid snapshot
      startup: applyClaudePath(
        resumeStartup(startup, store.agents[agentId]?.resume),
        store.settings.claudePath,
      ),
      fontSize:
        store.agents[agentId]?.fontSize ??
        store.settings.defaultFontSize ??
        DEFAULT_FONT_SIZE,
      handlers,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // per-pane zoom (⌘+/⌘−)
  useEffect(() => {
    setTermFontSize(agentId, fontSize);
  }, [fontSize, agentId]);

  // only the active pane's cursor blinks — a blinking cursor wakes the
  // renderer every ~600ms, which adds up across many idle panes
  useEffect(() => {
    setTermCursorBlink(agentId, active);
  }, [active, agentId]);

  // focus terminal when its pane becomes active
  useEffect(() => {
    if (active) {
      const t = setTimeout(() => focusTerm(agentId), 30);
      return () => clearTimeout(t);
    }
  }, [active, agentId]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden bg-card"
      onMouseDown={() => focusTerm(agentId)}
    />
  );
}
