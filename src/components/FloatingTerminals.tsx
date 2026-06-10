import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Pencil,
  Plus,
  RotateCcw,
  X,
  Zap,
} from "lucide-react";
import { useSwarm, presetKey } from "@/store";
import { TerminalView } from "./Terminal";
import { FileDropOverlay } from "./FileDropOverlay";
import { Tip } from "./ui/tooltip";
import { Badge } from "./ui/misc";
import { cn, shortPath } from "@/lib/utils";
import {
  detectProjectCommands,
  onPtyExit,
  ptyHasChildren,
  ptyWrite,
} from "@/lib/transport";
import type { DetectedCommand, FolderCommands } from "@/types";

const HEADER_H = 32; // px — the collapsed (minimized) window height
const MIN_W = 280;
const MIN_H = 160;
const MINIMIZED_W = 240;
const MARGIN = 16; // px gap to the grid edge for the initial bottom-right spot

/**
 * Layer hosting all floating terminal windows, rendered above the tiling
 * grid. Windows stay mounted through minimize/detach — only removing one
 * unmounts it (which kills its PTY).
 */
export function FloatingTerminals() {
  const order = useSwarm((s) => s.floatingOrder);
  const layerRef = useRef<HTMLDivElement>(null);

  // keep windows reachable when the app window shrinks
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const ro = new ResizeObserver(() => {
      const { clientWidth: W, clientHeight: H } = layer;
      if (!W || !H) return;
      const { floatingTerminals, updateFloatingTerminal } =
        useSwarm.getState();
      for (const t of Object.values(floatingTerminals)) {
        if (t.x === null || t.y === null) continue;
        const x = Math.min(t.x, Math.max(0, W - MIN_W));
        const y = Math.min(t.y, Math.max(0, H - HEADER_H));
        if (x !== t.x || y !== t.y) updateFloatingTerminal(t.id, { x, y });
      }
    });
    ro.observe(layer);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={layerRef}
      className="pointer-events-none absolute inset-0 z-40 overflow-hidden"
    >
      {order.map((id, i) => (
        <FloatingTerminalWindow key={id} id={id} index={i} />
      ))}
    </div>
  );
}

const FloatingTerminalWindow = memo(function FloatingTerminalWindow({
  id,
  index,
}: {
  id: string;
  index: number;
}) {
  const term = useSwarm((s) => s.floatingTerminals[id]);
  const ownerName = useSwarm((s) =>
    s.floatingTerminals[id]?.agentId
      ? s.agents[s.floatingTerminals[id].agentId!]?.name
      : undefined,
  );
  const update = useSwarm((s) => s.updateFloatingTerminal);
  const remove = useSwarm((s) => s.removeFloatingTerminal);
  const raise = useSwarm((s) => s.raiseFloatingTerminal);
  const windowRef = useRef<HTMLDivElement>(null);
  const [commandsOpen, setCommandsOpen] = useState(true);
  // closing while a process runs needs a second click (the X turns red)
  const [confirmClose, setConfirmClose] = useState(false);

  // first layout: place the window bottom-right of the grid, cascaded a bit
  useEffect(() => {
    if (!term || term.x !== null) return;
    const layer = windowRef.current?.parentElement;
    if (!layer) return;
    const cascade = (index % 4) * 32;
    update(id, {
      x: Math.max(0, layer.clientWidth - term.w - MARGIN - cascade),
      y: Math.max(0, layer.clientHeight - term.h - MARGIN - cascade),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term?.x === null]);

  // own exit listener — TerminalView's status updates target agents, not floats
  useEffect(() => {
    const p = onPtyExit(id, () => {
      useSwarm.getState().updateFloatingTerminal(id, { status: "exited" });
    });
    return () => void p.then((u) => u());
  }, [id]);

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("button, input")) return;
      const layer = windowRef.current?.parentElement;
      const t = useSwarm.getState().floatingTerminals[id];
      if (!layer || !t || t.x === null || t.y === null) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const origin = { x: t.x, y: t.y };
      const maxX = layer.clientWidth - 60; // keep a grabbable sliver visible
      const maxY = layer.clientHeight - HEADER_H;
      const onMove = (ev: MouseEvent) => {
        useSwarm.getState().updateFloatingTerminal(id, {
          x: Math.min(maxX, Math.max(0, origin.x + ev.clientX - startX)),
          y: Math.min(maxY, Math.max(0, origin.y + ev.clientY - startY)),
        });
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [id],
  );

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const layer = windowRef.current?.parentElement;
      const t = useSwarm.getState().floatingTerminals[id];
      if (!layer || !t || t.x === null || t.y === null) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const origin = { w: t.w, h: t.h, x: t.x, y: t.y };
      const onMove = (ev: MouseEvent) => {
        useSwarm.getState().updateFloatingTerminal(id, {
          w: Math.min(
            layer.clientWidth - origin.x,
            Math.max(MIN_W, origin.w + ev.clientX - startX),
          ),
          h: Math.min(
            layer.clientHeight - origin.y,
            Math.max(MIN_H, origin.h + ev.clientY - startY),
          ),
        });
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "nwse-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [id],
  );

  const requestClose = useCallback(() => {
    void (async () => {
      const t = useSwarm.getState().floatingTerminals[id];
      const busy = t?.status !== "exited" && (await ptyHasChildren(id));
      if (busy && !confirmClose) {
        setConfirmClose(true);
        setTimeout(() => setConfirmClose(false), 3000);
        return;
      }
      remove(id);
    })();
  }, [id, confirmClose, remove]);

  if (!term) return null;
  const minimized = term.minimized;

  return (
    <div
      ref={windowRef}
      className={cn(
        "pointer-events-auto absolute flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-[0_16px_48px_-12px_rgba(0,0,0,0.7)]",
        term.x === null && "invisible", // not laid out yet
      )}
      style={{
        left: term.x ?? 0,
        top: term.y ?? 0,
        width: minimized ? MINIMIZED_W : term.w,
        height: minimized ? HEADER_H : term.h,
        zIndex: term.z,
      }}
      onMouseDown={() => raise(id)}
    >
      {/* header — drag handle */}
      <div
        className="flex h-8 shrink-0 cursor-grab items-center gap-1.5 border-b border-border bg-secondary/70 px-2"
        onMouseDown={startDrag}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button, input")) return;
          update(id, { minimized: !minimized });
        }}
      >
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{
            backgroundColor:
              term.status === "exited" ? "var(--faint)" : "var(--success)",
          }}
        />
        <Tip
          label={
            <span className="font-mono text-[11px]">{shortPath(term.cwd)}</span>
          }
        >
          <span className="min-w-0 truncate font-mono text-[11px] text-foreground">
            {term.name}
          </span>
        </Tip>
        {ownerName ? (
          <Badge className="max-w-24 shrink-0 truncate">{ownerName}</Badge>
        ) : (
          term.agentId === null && (
            <Badge className="shrink-0 text-faint">detached</Badge>
          )
        )}

        <div className="ml-auto flex items-center gap-0.5">
          {!minimized && (
            <Tip label="Quick commands">
              <button
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-md hover:bg-accent hover:text-foreground",
                  commandsOpen ? "text-foreground" : "text-faint",
                )}
                onClick={() => setCommandsOpen((v) => !v)}
              >
                <Zap size={12} />
              </button>
            </Tip>
          )}
          <Tip label={minimized ? "Restore" : "Minimize"}>
            <button
              className="flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground"
              onClick={() => update(id, { minimized: !minimized })}
            >
              {minimized ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
          </Tip>
          <Tip
            label={
              confirmClose ? "Process still running — click again to kill" : "Close"
            }
          >
            <button
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-md",
                confirmClose
                  ? "bg-destructive/15 text-destructive"
                  : "text-faint hover:bg-destructive/15 hover:text-destructive",
              )}
              onClick={requestClose}
            >
              <X size={13} />
            </button>
          </Tip>
        </div>
      </div>

      {/* commands + terminal stay mounted while minimized — only hidden */}
      <div className={cn("flex min-h-0 flex-1 flex-col", minimized && "hidden")}>
        {commandsOpen && (
          <CommandsBar
            termId={id}
            cwd={term.cwd}
            onRun={(label) => update(id, { name: label })}
          />
        )}
        {/* terminal — also an OS-file drop zone (see lib/dnd.ts) */}
        <div className="relative min-h-0 flex-1" data-file-drop={id}>
          <TerminalView
            agentId={id}
            cwd={term.cwd}
            startup=""
            active={!minimized}
            // the window names itself after the last command, typed or clicked
            onCommand={(cmd) =>
              update(id, {
                name: cmd.length > 48 ? cmd.slice(0, 48) + "…" : cmd,
              })
            }
          />
          <FileDropOverlay targetId={id} />
        </div>
      </div>

      {!minimized && (
        <div
          className="absolute bottom-0 right-0 h-3.5 w-3.5 cursor-nwse-resize"
          onMouseDown={startResize}
        />
      )}
    </div>
  );
});

const NO_FOLDER: FolderCommands = { presets: [], hidden: [] };

/** What the preset editor row is working on; `id` set = editing an existing preset. */
interface EditorState {
  id?: string;
  label: string;
  command: string;
}

/**
 * One-click commands for the floating terminal: presets saved for this
 * project folder plus commands auto-detected from its project files. Both
 * are editable — editing a detected command saves it as a preset that
 * overrides the original (matched by label or command); deleting a detected
 * command hides it for this folder.
 */
function CommandsBar({
  termId,
  cwd,
  onRun,
}: {
  termId: string;
  cwd?: string;
  onRun: (label: string) => void;
}) {
  const folder =
    useSwarm((s) => s.commandPresets[presetKey(cwd)]) ?? NO_FOLDER;
  const savePreset = useSwarm((s) => s.saveCommandPreset);
  const deletePreset = useSwarm((s) => s.deleteCommandPreset);
  const hideDetected = useSwarm((s) => s.hideDetectedCommand);
  const restoreHidden = useSwarm((s) => s.restoreHiddenCommands);
  const [detected, setDetected] = useState<DetectedCommand[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);

  useEffect(() => {
    let alive = true;
    if (!cwd) return;
    void detectProjectCommands(cwd).then((cmds) => {
      if (alive) setDetected(cmds);
    });
    return () => {
      alive = false;
    };
  }, [cwd]);

  const run = (label: string, command: string) => {
    void ptyWrite(termId, command + "\r");
    onRun(label);
  };

  const commitEditor = () => {
    if (editor?.command.trim())
      savePreset(cwd, editor.label, editor.command, editor.id);
    setEditor(null);
  };

  // a preset with the same command or label overrides the detected entry;
  // hidden ones are gone until restored
  const hidden = new Set(folder.hidden);
  const overridden = new Set([
    ...folder.presets.map((p) => p.command),
    ...folder.presets.map((p) => p.label),
  ]);
  const fresh = detected.filter(
    (d) =>
      !hidden.has(d.command) &&
      !overridden.has(d.command) &&
      !overridden.has(d.label),
  );

  return (
    <div className="flex max-h-24 shrink-0 flex-wrap items-center gap-1 overflow-y-auto border-b border-border bg-secondary/30 px-2 py-1.5">
      {folder.presets.map((p) => (
        <span key={p.id} className="group/chip relative inline-flex">
          <Tip
            label={<span className="font-mono text-[11px]">{p.command}</span>}
          >
            <button
              className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary/60 py-0.5 pl-1.5 pr-1.5 font-mono text-[11px] leading-4 text-foreground hover:bg-accent group-hover/chip:pr-9"
              onClick={() => run(p.label, p.command)}
            >
              {p.label}
            </button>
          </Tip>
          <button
            className="absolute right-4 top-1/2 hidden h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-faint hover:text-foreground group-hover/chip:flex"
            onClick={() =>
              setEditor({ id: p.id, label: p.label, command: p.command })
            }
          >
            <Pencil size={9} />
          </button>
          <button
            className="absolute right-0.5 top-1/2 hidden h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-faint hover:text-destructive group-hover/chip:flex"
            onClick={() => deletePreset(cwd, p.id)}
          >
            <X size={10} />
          </button>
        </span>
      ))}

      {fresh.map((d) => (
        <span key={`${d.source}:${d.command}`} className="group/chip relative inline-flex">
          <Tip
            label={
              <span className="font-mono text-[11px]">
                {d.command} · {d.source}
              </span>
            }
          >
            <button
              className="inline-flex items-center gap-1 rounded-md border border-dashed border-border py-0.5 pl-1.5 pr-1.5 font-mono text-[11px] leading-4 text-muted-foreground hover:bg-accent hover:text-foreground group-hover/chip:pr-9"
              onClick={() => run(d.label, d.command)}
            >
              {d.label}
            </button>
          </Tip>
          <Tip label="Edit — saves as a preset overriding this one">
            <button
              className="absolute right-4 top-1/2 hidden h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-faint hover:text-foreground group-hover/chip:flex"
              onClick={() =>
                setEditor({ label: d.label, command: d.command })
              }
            >
              <Pencil size={9} />
            </button>
          </Tip>
          <Tip label="Hide this detected command">
            <button
              className="absolute right-0.5 top-1/2 hidden h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-faint hover:text-destructive group-hover/chip:flex"
              onClick={() => hideDetected(cwd, d.command)}
            >
              <X size={10} />
            </button>
          </Tip>
        </span>
      ))}

      {!editor && (
        <Tip label="Add a command preset">
          <button
            className="inline-flex h-5 w-5 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground"
            onClick={() => setEditor({ label: "", command: "" })}
          >
            <Plus size={12} />
          </button>
        </Tip>
      )}

      {folder.hidden.length > 0 && (
        <Tip label="Restore hidden detected commands">
          <button
            className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[10px] text-faint hover:bg-accent hover:text-foreground"
            onClick={() => restoreHidden(cwd)}
          >
            <RotateCcw size={9} /> {folder.hidden.length} hidden
          </button>
        </Tip>
      )}

      {editor && (
        <span
          className="flex basis-full items-center gap-1"
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditor(null);
            if (e.key === "Enter") commitEditor();
          }}
        >
          <input
            value={editor.label}
            placeholder="label"
            className="h-5 w-24 rounded-md bg-secondary px-1.5 font-mono text-[11px] text-foreground outline-none select-text placeholder:text-faint"
            onChange={(e) => setEditor({ ...editor, label: e.target.value })}
          />
          <input
            autoFocus
            value={editor.command}
            placeholder="command"
            className="h-5 min-w-32 flex-1 rounded-md bg-secondary px-1.5 font-mono text-[11px] text-foreground outline-none select-text placeholder:text-faint"
            onChange={(e) => setEditor({ ...editor, command: e.target.value })}
          />
          <button
            className="flex h-5 w-5 items-center justify-center rounded-md text-success hover:bg-accent"
            onClick={commitEditor}
          >
            <Check size={11} />
          </button>
          <button
            className="flex h-5 w-5 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground"
            onClick={() => setEditor(null)}
          >
            <X size={11} />
          </button>
        </span>
      )}
    </div>
  );
}
