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
import { useVibe } from "@/lib/vibe/session-store";
import { ScrollArea } from "./ui/misc";
import {
  Dialog,
  DialogDescription,
  DialogTitle,
  DrawerContent,
} from "./ui/dialog";
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

  // scope (null = global) defaults to the active session's project at open time
  const [scope, setScope] = useState<string | null>(null);
  // remembered so the active project keeps its chip even while it has no notes
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    // the active vibe session's project scopes the notes
    const v = useVibe.getState();
    const root = v.activeId
      ? (v.sessions[v.activeId]?.session.projectDir ?? null)
      : null;
    setProjectRoot(root);
    setScope(root);
    // capture should be instant — focus the input once the drawer mounted
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

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
    <Dialog open={open} onOpenChange={setOpen}>
      <DrawerContent
        className="w-[380px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="min-w-0">
            <DialogTitle className="text-14">Quick Notes</DialogTitle>
            <DialogDescription className="truncate font-mono text-11" title={scope ?? undefined}>
              {scope ? shortPath(scope) : "Global · not tied to a project"}
            </DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {doneCount > 0 && (
              <button
                onClick={() => clearDoneNotes(scope)}
                className="focus-ring flex items-center gap-1 rounded-md px-1.5 py-0.5 text-10 text-fnt transition-colors hover:bg-card hover:text-txt"
                title={`Remove ${doneCount} completed item${doneCount === 1 ? "" : "s"}`}
              >
                <Trash2 size={11} /> Clear done
              </button>
            )}
            <button
              onClick={() => setOpen(false)}
              aria-label="Close Quick Notes"
              className="focus-ring flex h-7 w-7 items-center justify-center rounded-md text-fnt hover:bg-card hover:text-txt"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* scope chips: Global + per-project lists */}
        <div className="no-scrollbar flex gap-1 overflow-x-auto border-b border-line px-4 py-2">
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
              <p className="px-2 py-6 text-center text-12 text-fnt">
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
          className="flex items-center gap-2 border-t border-line px-3 py-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            submitDraft();
          }}
        >
          <Plus size={14} className="shrink-0 text-fnt" />
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a note… (Enter)"
            className="h-8 min-w-0 flex-1 rounded-md bg-pop px-2 text-12 text-txt outline-none placeholder:text-fnt focus:ring-1 focus:ring-acc select-text"
          />
          {openCount > 0 && (
            <span className="shrink-0 font-mono text-10 tabular-nums text-fnt">
              {openCount} open
            </span>
          )}
        </form>
      </DrawerContent>
    </Dialog>
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
      aria-pressed={active}
      className={cn(
        "focus-ring flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-12 font-medium transition-colors",
        active ? "bg-acc/10 text-txt" : "text-fnt hover:text-txt",
      )}
    >
      <span className="max-w-32 truncate">{label}</span>
      {count > 0 && (
        <span className="font-mono text-10 tabular-nums text-fnt">
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
      className="group/note flex items-start gap-1.5 rounded-md px-1.5 py-1.5 hover:bg-card"
    >
      <span
        onMouseDown={onDragStart}
        className="mt-px hidden h-4 w-3 shrink-0 cursor-grab items-center justify-center text-fnt group-hover/note:flex"
      >
        <GripVertical size={11} />
      </span>
      <span className="mt-px block h-4 w-3 shrink-0 group-hover/note:hidden" />

      {note.plain ? (
        <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-fnt" />
      ) : (
        <button
          onClick={() => updateNote(scope, note.id, { done: !note.done })}
          aria-label={`${note.done ? "Mark incomplete" : "Mark complete"}: ${note.text}`}
          aria-pressed={note.done}
          className={cn(
            "focus-ring mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
            note.done
              ? "border-transparent bg-ok/80 text-bg"
              : "border-line bg-pop hover:border-acc/60",
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
          className="min-w-0 flex-1 rounded bg-pop px-1 text-12 leading-4 text-txt outline-none select-text"
        />
      ) : (
        <span
          onClick={() => setEditing(true)}
          className={cn(
            "min-w-0 flex-1 cursor-text whitespace-pre-wrap break-words text-12 leading-4",
            note.done ? "text-fnt line-through" : "text-txt",
            note.plain && "text-mut",
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
          className="focus-ring flex h-4 w-4 items-center justify-center rounded text-fnt hover:bg-card hover:text-txt"
          title={note.plain ? "Turn into checkbox item" : "Turn into plain text"}
          aria-label={note.plain ? "Turn into checkbox item" : "Turn into plain text"}
        >
          {note.plain ? <Square size={10} /> : <Type size={10} />}
        </button>
        <button
          onClick={() => deleteNote(scope, note.id)}
          className="focus-ring flex h-4 w-4 items-center justify-center rounded text-fnt hover:bg-err/15 hover:text-err"
          title="Delete note"
          aria-label={`Delete note: ${note.text}`}
        >
          <X size={11} />
        </button>
      </span>
    </div>
  );
}
