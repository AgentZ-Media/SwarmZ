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
} from "./transport";
import { registerTerm, unregisterTerm } from "./term-registry";

/**
 * Owns every live terminal (xterm instance + PTY) OUTSIDE of React.
 *
 * Pane components only attach/detach the terminal's DOM element; unmounting a
 * pane no longer kills anything. That is what lets an agent pane move between
 * workspace grids (a React remount) with its scrollback, PTY and processes
 * intact. The terminal dies exactly when the store removes its owner
 * (removeAgent / removeFloatingTerminal → destroyTerm).
 */

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

/** Pane-level signals a terminal reports while it runs. Updated on every attach. */
export interface TermHandlers {
  onStatus?: (status: "running" | "exited") => void;
  onBell?: () => void;
  /** raw OSC 0/2 title — the caller filters shell noise */
  onTitle?: (title: string) => void;
  /** OSC 9;4 progress / OSC 21337 tab status → busy/idle/waiting */
  onActivity?: (activity: "busy" | "idle" | "waiting" | undefined) => void;
  /** best-effort: the line the user typed when they hit Enter */
  onCommand?: (command: string) => void;
}

export interface TermSpawnOpts {
  cwd?: string;
  /** startup command, already path-resolved (applyRuntimePath) */
  startup: string;
  fontSize: number;
  handlers: TermHandlers;
}

interface HostEntry {
  term: XTerm;
  fit: FitAddon;
  /** xterm's render root — reparented between pane containers on attach */
  el: HTMLDivElement;
  handlers: TermHandlers;
  disposers: (() => void)[];
  unlistens: Promise<() => void>[];
  ro: ResizeObserver | null;
  attached: HTMLElement | null;
}

const entries = new Map<string, HostEntry>();

function create(id: string, container: HTMLElement, opts: TermSpawnOpts): HostEntry {
  const term = new XTerm({
    fontFamily:
      '"JetBrains Mono Variable","JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace',
    fontSize: opts.fontSize,
    lineHeight: 1.25,
    letterSpacing: 0,
    cursorBlink: false, // enabled per-pane — only the active pane blinks
    cursorStyle: "bar",
    scrollback: 12000,
    allowProposedApi: true,
    theme: THEME,
    macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());

  // xterm renders into a host element WE own — reparenting it later moves the
  // whole terminal (canvas, scrollback, selection) without touching xterm
  const el = document.createElement("div");
  el.style.width = "100%";
  el.style.height = "100%";
  container.appendChild(el);
  term.open(el);
  try {
    // with every workspace mounted, many terminals hold WebGL contexts at
    // once — past the browser's cap the oldest context is lost. Dispose the
    // addon on loss so xterm falls back to the DOM renderer instead of
    // leaving a blank canvas.
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    /* webgl unavailable — canvas renderer is fine */
  }
  fit.fit();

  const entry: HostEntry = {
    term,
    fit,
    el,
    handlers: opts.handlers,
    disposers: [],
    unlistens: [],
    ro: null,
    attached: container,
  };
  entries.set(id, entry);
  registerTerm(id, term);

  // stream input → pty; optionally track the typed line for onCommand
  let lineBuf = "";
  let lineDirty = false; // an escape sequence touched the line — don't trust it
  {
    const d = term.onData((data) => {
      void ptyWrite(id, data);
      if (!entry.handlers.onCommand) return;
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          const cmd = lineBuf.trim();
          if (cmd && !lineDirty) entry.handlers.onCommand?.(cmd);
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
    entry.disposers.push(() => d.dispose());
  }

  {
    const d = term.onBell(() => entry.handlers.onBell?.());
    entry.disposers.push(() => d.dispose());
  }
  {
    const d = term.onTitleChange((t) => entry.handlers.onTitle?.(t));
    entry.disposers.push(() => d.dispose());
  }

  // OSC 9;4 progress reporting → busy/idle. Claude Code emits this because
  // the PTY env advertises support (ConEmuANSI=ON, see backend spawn code):
  // indeterminate/set while working, clear once it's done.
  {
    const d = term.parser.registerOscHandler(9, (data) => {
      if (!data.startsWith("4;")) return false;
      const state = data.split(";")[1];
      if (state === "1" || state === "3") entry.handlers.onActivity?.("busy");
      else if (state === "0" || state === "2")
        entry.handlers.onActivity?.("idle");
      return true;
    });
    entry.disposers.push(() => d.dispose());
  }

  // OSC 21337 tab status — claude's native status pill protocol
  // (`indicator=…;status=…;status-color=…`, statuses Idle/Working…/Waiting).
  // Emission is disabled in current Claude Code builds; pre-wired so panes
  // pick it up the moment it ships.
  {
    const d = term.parser.registerOscHandler(21337, (data) => {
      const status = /(?:^|(?<!\\);)status=((?:\\.|[^;])*)/.exec(data)?.[1];
      if (status === undefined) return true;
      const text = status.replace(/\\(.)/g, "$1");
      if (!text) entry.handlers.onActivity?.(undefined);
      else if (/^working/i.test(text)) entry.handlers.onActivity?.("busy");
      else if (/^waiting/i.test(text)) entry.handlers.onActivity?.("waiting");
      else entry.handlers.onActivity?.("idle");
      return true;
    });
    entry.disposers.push(() => d.dispose());
  }

  // pty → terminal (events are addressed per terminal id)
  let running = false;
  entry.unlistens.push(
    onPtyData(id, (e) => {
      if (!running) {
        running = true;
        entry.handlers.onStatus?.("running");
      }
      term.write(decodeBase64(e.data));
    }),
  );
  entry.unlistens.push(
    onPtyExit(id, () => {
      entry.handlers.onStatus?.("exited");
      entry.handlers.onActivity?.(undefined);
      term.write("\r\n\x1b[2m[ process exited ]\x1b[0m\r\n");
    }),
  );

  void ptySpawn({
    id,
    cwd: opts.cwd,
    startup: opts.startup,
    cols: term.cols,
    rows: term.rows,
  })
    .then(() => entry.handlers.onStatus?.("running"))
    .catch((e) => {
      // spawn can fail for real (cwd deleted — e.g. a restored pane whose
      // folder is gone, or a removed worktree). Without this the pane would
      // sit on "starting" forever with a black terminal.
      term.write(
        `\r\n\x1b[31m[ failed to start: ${String(e)} ]\x1b[0m\r\n` +
          `\x1b[2mClose this pane and open a new one.\x1b[0m\r\n`,
      );
      entry.handlers.onStatus?.("exited");
    });

  return entry;
}

/**
 * Mount the terminal `id` into `container`, creating terminal + PTY on first
 * use. Returns a detach function that ONLY unplugs the DOM — terminal and PTY
 * keep running for the next attach (or until destroyTerm).
 */
export function attachTerm(
  id: string,
  container: HTMLElement,
  opts: TermSpawnOpts,
): () => void {
  let entry = entries.get(id);
  if (!entry) {
    entry = create(id, container, opts);
  } else {
    entry.handlers = opts.handlers;
    entry.ro?.disconnect();
    container.appendChild(entry.el);
    entry.attached = container;
    try {
      entry.fit.fit();
      void ptyResize(id, entry.term.cols, entry.term.rows);
      // canvas content can be dropped while the element was detached
      entry.term.refresh(0, entry.term.rows - 1);
    } catch {
      /* container not laid out yet — the ResizeObserver below catches up */
    }
  }

  const e = entry;
  const ro = new ResizeObserver(() => {
    try {
      e.fit.fit();
      void ptyResize(id, e.term.cols, e.term.rows);
    } catch {
      /* element detached */
    }
  });
  ro.observe(container);
  e.ro = ro;

  return () => {
    ro.disconnect();
    if (e.ro === ro) e.ro = null;
    if (e.attached === container) {
      e.attached = null;
      e.el.remove();
    }
  };
}

/** Kill the PTY and dispose the terminal — the owner was removed from the store. */
export function destroyTerm(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  entries.delete(id);
  entry.ro?.disconnect();
  for (const d of entry.disposers) d();
  for (const u of entry.unlistens) void u.then((un) => un());
  void ptyKill(id);
  unregisterTerm(id);
  entry.term.dispose();
  entry.el.remove();
}

export function termExists(id: string): boolean {
  return entries.has(id);
}

/** Per-pane zoom — the container doesn't resize, so refit + pty resize manually. */
export function setTermFontSize(id: string, fontSize: number): void {
  const entry = entries.get(id);
  if (!entry || entry.term.options.fontSize === fontSize) return;
  entry.term.options.fontSize = fontSize;
  try {
    entry.fit.fit();
    void ptyResize(id, entry.term.cols, entry.term.rows);
  } catch {
    /* element detached */
  }
}

/** Only the active pane's cursor blinks — blinking wakes the renderer ~600ms. */
export function setTermCursorBlink(id: string, blink: boolean): void {
  const entry = entries.get(id);
  if (entry) entry.term.options.cursorBlink = blink;
}

export function focusTerm(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  try {
    entry.fit.fit();
    entry.term.focus();
  } catch {
    /* noop */
  }
}

/** Drop keyboard focus from whichever terminal has it (fleet view, dialogs). */
export function blurActiveTerm(): void {
  const el = document.activeElement as HTMLElement | null;
  if (el && el.closest(".xterm")) el.blur();
}
