import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import {
  onPtyData,
  onPtyExit,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
} from "@/lib/transport";
import { DEFAULT_FONT_SIZE, useSwarm } from "@/store";
import { applyClaudePath } from "@/lib/utils";

// harmonized with the design tokens in styles.css — muted, low-noise ANSI set
const THEME = {
  background: "#111114",
  foreground: "#dededf",
  cursor: "#5b8def",
  cursorAccent: "#111114",
  selectionBackground: "#5b8def3d",
  black: "#1a1a1e",
  red: "#e0655f",
  green: "#57ab5a",
  yellow: "#c9a04e",
  blue: "#6d9af0",
  magenta: "#b083d6",
  cyan: "#5fb8c9",
  white: "#c4c4ca",
  brightBlack: "#62626a",
  brightRed: "#ee7f7a",
  brightGreen: "#6bc46d",
  brightYellow: "#ddb368",
  brightBlue: "#8ab4f8",
  brightMagenta: "#c49ae2",
  brightCyan: "#76cbdc",
  brightWhite: "#f0f0f2",
};

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

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
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  const runningRef = useRef(false);
  // keep the latest callback without re-running the spawn effect
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;

  const setStatus = useSwarm((s) => s.setStatus);
  const setAttention = useSwarm((s) => s.setAttention);
  const setActivity = useSwarm((s) => s.setActivity);
  const setAgentTitle = useSwarm((s) => s.setAgentTitle);
  const fontSize = useSwarm(
    (s) =>
      s.agents[agentId]?.fontSize ??
      s.settings.defaultFontSize ??
      DEFAULT_FONT_SIZE,
  );

  useEffect(() => {
    if (!containerRef.current || spawnedRef.current) return;
    spawnedRef.current = true;

    const term = new XTerm({
      fontFamily:
        '"JetBrains Mono Variable","JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace',
      fontSize,
      lineHeight: 1.25,
      letterSpacing: 0,
      cursorBlink: false, // enabled per-pane below — only the active pane blinks
      cursorStyle: "bar",
      scrollback: 12000,
      allowProposedApi: true,
      theme: THEME,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      /* webgl unavailable — canvas renderer is fine */
    }
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    const cols = term.cols;
    const rows = term.rows;

    // stream input → pty; optionally track the typed line for onCommand
    let lineBuf = "";
    let lineDirty = false; // an escape sequence touched the line — don't trust it
    const inputDisp = term.onData((data) => {
      void ptyWrite(agentId, data);
      if (!onCommandRef.current) return;
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          const cmd = lineBuf.trim();
          if (cmd && !lineDirty) onCommandRef.current(cmd);
          lineBuf = "";
          lineDirty = false;
        } else if (ch === "\x7f" || ch === "\b") {
          lineBuf = lineBuf.slice(0, -1);
        } else if (ch === "\x1b" || ch < " ") {
          // arrows, history recall, ^C, pastes … — buffer no longer mirrors
          // the shell's line (^C starts a fresh, trustworthy one)
          if (ch === "\x03") {
            lineBuf = "";
            lineDirty = false;
          } else {
            lineDirty = true;
          }
        } else {
          lineBuf += ch;
        }
      }
    });

    // bell → attention
    const bellDisp = term.onBell(() => {
      setAttention(agentId, true);
    });

    // OSC 0/2 title → agent name (claude auto-generates a topic title after
    // the first prompt and updates it via /rename)
    const titleDisp = term.onTitleChange((t) => {
      const title = cleanTitle(t, startup);
      if (title) setAgentTitle(agentId, title);
    });

    // OSC 9;4 progress reporting → busy/idle. Claude Code emits this because
    // the PTY env advertises support (ConEmuANSI=ON, see backend spawn code):
    // indeterminate/set while working, clear once it's done.
    const progressDisp = term.parser.registerOscHandler(9, (data) => {
      if (!data.startsWith("4;")) return false;
      const state = data.split(";")[1];
      if (state === "1" || state === "3") setActivity(agentId, "busy");
      else if (state === "0" || state === "2") setActivity(agentId, "idle");
      return true;
    });

    // OSC 21337 tab status — claude's native status pill protocol
    // (`indicator=…;status=…;status-color=…`, statuses Idle/Working…/Waiting).
    // Emission is disabled in current Claude Code builds; pre-wired so panes
    // pick it up the moment it ships.
    const tabStatusDisp = term.parser.registerOscHandler(21337, (data) => {
      const status = /(?:^|(?<!\\);)status=((?:\\.|[^;])*)/.exec(data)?.[1];
      if (status === undefined) return true;
      const text = status.replace(/\\(.)/g, "$1");
      if (!text) setActivity(agentId, undefined);
      else if (/^working/i.test(text)) setActivity(agentId, "busy");
      else if (/^waiting/i.test(text)) setActivity(agentId, "waiting");
      else setActivity(agentId, "idle");
      return true;
    });

    // pty → terminal (events are addressed per agent)
    const dataPromise = onPtyData(agentId, (e) => {
      if (!runningRef.current) {
        runningRef.current = true;
        setStatus(agentId, "running");
      }
      term.write(decodeBase64(e.data));
    });
    const exitPromise = onPtyExit(agentId, () => {
      setStatus(agentId, "exited");
      setActivity(agentId, undefined);
      term.write("\r\n\x1b[2m[ process exited ]\x1b[0m\r\n");
    });

    void ptySpawn({
      id: agentId,
      cwd,
      startup: applyClaudePath(startup, useSwarm.getState().settings.claudePath),
      cols,
      rows,
    }).then(() => {
      setStatus(agentId, "running");
    });

    // resize handling
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        void ptyResize(agentId, term.cols, term.rows);
      } catch {
        /* element detached */
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      inputDisp.dispose();
      bellDisp.dispose();
      titleDisp.dispose();
      progressDisp.dispose();
      tabStatusDisp.dispose();
      void dataPromise.then((u) => u());
      void exitPromise.then((u) => u());
      void ptyKill(agentId);
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // per-pane zoom (⌘+/⌘−) — changing the cell size doesn't resize the
  // container, so the ResizeObserver won't fire; refit + pty resize manually
  useEffect(() => {
    const term = termRef.current;
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    try {
      fitRef.current?.fit();
      void ptyResize(agentId, term.cols, term.rows);
    } catch {
      /* element detached */
    }
  }, [fontSize, agentId]);

  // only the active pane's cursor blinks — a blinking cursor wakes the
  // renderer every ~600ms, which adds up across many idle panes
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.cursorBlink = active;
  }, [active]);

  // focus terminal when its pane becomes active
  useEffect(() => {
    if (active) {
      const t = setTimeout(() => {
        try {
          fitRef.current?.fit();
          termRef.current?.focus();
        } catch {
          /* noop */
        }
      }, 30);
      return () => clearTimeout(t);
    }
  }, [active]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden bg-card"
      onMouseDown={() => termRef.current?.focus()}
    />
  );
}
