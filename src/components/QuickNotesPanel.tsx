import { useEffect, useRef, useState } from "react";
import {
  Check,
  GripVertical,
  Plus,
  Square,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { useSwarm } from "@/store";
import { ScrollArea } from "./ui/misc";
import { cn, folderName, shortPath } from "@/lib/utils";
import type { NoteItem } from "@/types";

/**
 * Quick-notes drawer (title bar / ⌘N): a slide-in checklist for capturing
 * ideas without leaving the app. One global list plus one list per project
 * folder (repo root) — the drawer opens in the context of the active pane.
 */
export function QuickNotesPanel() {
  const open = useSwarm((s) => s.notesOpen);
  const setOpen = useSwarm((s) => s.setNotesOpen);
  const quickNotes = useSwarm((s) => s.quickNotes);
  const addNote = useSwarm((s) => s.addNote);
  const moveNote = useSwarm((s) => s.moveNote);
  const clearDoneNotes = useSwarm((s) => s.clearDoneNotes);

  // scope (null = global) defaults to the active pane's project at open time
  const [scope, setScope] = useState<string | null>(null);
  // remembered so the active project keeps its chip even while it has no notes
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const root = useSwarm.getState().activeProjectRoot();
    setProjectRoot(root);
    setScope(root);
    // capture should be instant — focus the input once the drawer mounted
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  // Escape closes the drawer; capture + stopPropagation so window-level
  // handlers (fleet exit in WorkspaceLayer) don't react to the same press
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // a real dialog stacked above the drawer (Settings via the title bar)
      // owns Escape — don't steal it and close the drawer underneath
      if (
        document.querySelector('[role="dialog"]:not([aria-label="Quick Notes"])')
      )
        return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen]);

  if (!open) return null;

  const list = scope ? (quickNotes.folders[scope] ?? []) : quickNotes.global;
  const doneCount = list.filter((n) => n.done).length;
  const openCount = list.filter((n) => !n.done && !n.plain).length;

  // chips: Global, the active project, then every other folder that has notes
  const folderScopes = [
    ...(projectRoot ? [projectRoot] : []),
    ...Object.keys(quickNotes.folders)
      .filter((f) => f !== projectRoot)
      .sort((a, b) => folderName(a).localeCompare(folderName(b))),
  ];

  const submitDraft = () => {
    if (!draft.trim()) return;
    addNote(scope, draft);
    setDraft("");
  };

  // vertical sibling-midpoint drag, same pattern as the workspace tab strip
  const startReorder = (e: React.MouseEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const listEl = listRef.current;
    if (!listEl) return;
    const startY = e.clientY;
    let dragged = false;
    const onMove = (ev: MouseEvent) => {
      if (!dragged && Math.abs(ev.clientY - startY) < 5) return;
      dragged = true;
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      const rows = Array.from(
        listEl.querySelectorAll<HTMLElement>("[data-note-row]"),
      );
      let to = rows.length - 1;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          to = i;
          break;
        }
      }
      moveNote(scope, id, to);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <>
      <div
        className="fixed inset-0 z-30 bg-black/40"
        onClick={() => setOpen(false)}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-label="Quick Notes"
        tabIndex={-1}
        className="animate-slide-in-right fixed right-0 top-0 z-40 flex h-full w-[380px] flex-col border-l border-border bg-background shadow-[-24px_0_48px_-24px_rgba(0,0,0,0.6)] outline-none"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight">Quick Notes</h2>
            <p className="truncate text-[11px] text-faint" title={scope ?? undefined}>
              {scope ? shortPath(scope) : "Global · not tied to a project"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {doneCount > 0 && (
              <button
                onClick={() => clearDoneNotes(scope)}
                className="focus-ring flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-faint transition-colors hover:bg-accent hover:text-foreground"
                title={`Remove ${doneCount} completed item${doneCount === 1 ? "" : "s"}`}
              >
                <Trash2 size={11} /> Clear done
              </button>
            )}
            <button
              onClick={() => setOpen(false)}
              className="focus-ring flex h-7 w-7 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* scope chips: Global + per-project lists */}
        <div className="no-scrollbar flex gap-1 overflow-x-auto border-b border-border px-4 py-2">
          <ScopeChip
            label="Global"
            active={scope === null}
            count={quickNotes.global.filter((n) => !n.done && !n.plain).length}
            onClick={() => setScope(null)}
          />
          {folderScopes.map((f) => (
            <ScopeChip
              key={f}
              label={folderName(f)}
              title={f}
              active={scope === f}
              count={
                (quickNotes.folders[f] ?? []).filter((n) => !n.done && !n.plain)
                  .length
              }
              onClick={() => setScope(f)}
            />
          ))}
        </div>

        <ScrollArea className="flex-1">
          <div ref={listRef} className="space-y-0.5 p-2">
            {list.length === 0 && (
              <p className="px-2 py-6 text-center text-xs text-faint">
                Nothing here yet — capture an idea below.
              </p>
            )}
            {list.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                scope={scope}
                onDragStart={(e) => startReorder(e, note.id)}
              />
            ))}
          </div>
        </ScrollArea>

        <form
          className="flex items-center gap-2 border-t border-border px-3 py-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            submitDraft();
          }}
        >
          <Plus size={14} className="shrink-0 text-faint" />
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a note… (Enter)"
            className="h-8 min-w-0 flex-1 rounded-md bg-secondary px-2 text-xs text-foreground outline-none placeholder:text-faint focus:ring-1 focus:ring-ring select-text"
          />
          {openCount > 0 && (
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-faint">
              {openCount} open
            </span>
          )}
        </form>
      </div>
    </>
  );
}

function ScopeChip({
  label,
  title,
  active,
  count,
  onClick,
}: {
  label: string;
  title?: string;
  active: boolean;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "focus-ring flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        active ? "bg-accent text-foreground" : "text-faint hover:text-foreground",
      )}
    >
      <span className="max-w-32 truncate">{label}</span>
      {count > 0 && (
        <span className="font-mono text-[10px] tabular-nums text-faint">
          {count}
        </span>
      )}
    </button>
  );
}

function NoteRow({
  note,
  scope,
  onDragStart,
}: {
  note: NoteItem;
  scope: string | null;
  onDragStart: (e: React.MouseEvent) => void;
}) {
  const updateNote = useSwarm((s) => s.updateNote);
  const deleteNote = useSwarm((s) => s.deleteNote);
  const [editing, setEditing] = useState(false);

  const commitEdit = (value: string) => {
    setEditing(false);
    const trimmed = value.trim();
    if (!trimmed) deleteNote(scope, note.id);
    else if (trimmed !== note.text) updateNote(scope, note.id, { text: trimmed });
  };

  return (
    <div
      data-note-row={note.id}
      className="group/note flex items-start gap-1.5 rounded-md px-1.5 py-1.5 hover:bg-accent/50"
    >
      <span
        onMouseDown={onDragStart}
        className="mt-px hidden h-4 w-3 shrink-0 cursor-grab items-center justify-center text-faint group-hover/note:flex"
      >
        <GripVertical size={11} />
      </span>
      <span className="mt-px block h-4 w-3 shrink-0 group-hover/note:hidden" />

      {note.plain ? (
        <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-faint" />
      ) : (
        <button
          onClick={() => updateNote(scope, note.id, { done: !note.done })}
          className={cn(
            "focus-ring mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
            note.done
              ? "border-transparent bg-success/80 text-background"
              : "border-border bg-secondary hover:border-ring/60",
          )}
        >
          {note.done && <Check size={11} strokeWidth={3} />}
        </button>
      )}

      {editing ? (
        <input
          autoFocus
          defaultValue={note.text}
          onFocus={(e) =>
            e.target.setSelectionRange(e.target.value.length, e.target.value.length)
          }
          onBlur={(e) => commitEdit(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setEditing(false);
          }}
          className="min-w-0 flex-1 rounded bg-secondary px-1 text-xs leading-4 text-foreground outline-none select-text"
        />
      ) : (
        <span
          onClick={() => setEditing(true)}
          className={cn(
            "min-w-0 flex-1 cursor-text whitespace-pre-wrap break-words text-xs leading-4",
            note.done ? "text-faint line-through" : "text-foreground",
            note.plain && "text-muted-foreground",
          )}
        >
          {note.text}
        </span>
      )}

      {/* opacity (not display:none) so the actions stay real tab stops —
          they reveal on row hover AND on keyboard focus */}
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover/note:opacity-100">
        <button
          onClick={() =>
            updateNote(scope, note.id, { plain: !note.plain, done: false })
          }
          className="focus-ring flex h-4 w-4 items-center justify-center rounded text-faint hover:bg-accent hover:text-foreground"
          title={note.plain ? "Turn into checkbox item" : "Turn into plain text"}
        >
          {note.plain ? <Square size={10} /> : <Type size={10} />}
        </button>
        <button
          onClick={() => deleteNote(scope, note.id)}
          className="focus-ring flex h-4 w-4 items-center justify-center rounded text-faint hover:bg-destructive/15 hover:text-destructive"
          title="Delete note"
        >
          <X size={11} />
        </button>
      </span>
    </div>
  );
}
