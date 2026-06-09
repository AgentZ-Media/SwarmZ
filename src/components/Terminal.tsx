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
import { useSwarm } from "@/store";

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

export function TerminalView({
  agentId,
  cwd,
  startup,
  active,
}: {
  agentId: string;
  cwd?: string;
  startup: string;
  active: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  const runningRef = useRef(false);

  const setStatus = useSwarm((s) => s.setStatus);
  const setAttention = useSwarm((s) => s.setAttention);

  useEffect(() => {
    if (!containerRef.current || spawnedRef.current) return;
    spawnedRef.current = true;

    const term = new XTerm({
      fontFamily:
        '"JetBrains Mono Variable","JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      letterSpacing: 0,
      cursorBlink: true,
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

    // stream input → pty
    const inputDisp = term.onData((data) => {
      void ptyWrite(agentId, data);
    });

    // bell → attention
    const bellDisp = term.onBell(() => {
      setAttention(agentId, true);
    });

    // pty → terminal
    const dataPromise = onPtyData((e) => {
      if (e.id !== agentId) return;
      if (!runningRef.current) {
        runningRef.current = true;
        setStatus(agentId, "running");
      }
      term.write(decodeBase64(e.data));
    });
    const exitPromise = onPtyExit((e) => {
      if (e.id !== agentId) return;
      setStatus(agentId, "exited");
      term.write("\r\n\x1b[2m[ process exited ]\x1b[0m\r\n");
    });

    void ptySpawn({ id: agentId, cwd, startup, cols, rows }).then(() => {
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
      void dataPromise.then((u) => u());
      void exitPromise.then((u) => u());
      void ptyKill(agentId);
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

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
