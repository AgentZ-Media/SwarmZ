import { useMemo, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { CheckCircle2, FolderGit2, FolderOpen, Plus, Trash2 } from "lucide-react";
import { useSwarm } from "@/store";
import { useVibe } from "@/lib/vibe/session-store";
import { focusSession, startSession } from "@/lib/vibe/controller";
import { Button } from "./ui/button";
import { Tip } from "./ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { cn, folderName } from "@/lib/utils";
import type { WorktreeEntry } from "@/types";

/**
 * Title-bar entry point for all SwarmZ-managed worktrees. The button only
 * appears once at least one worktree exists (kept ones, orphans after a
 * crash); the panel groups them per repo with their live state and offers
 * open-in-session / reveal-in-Finder / delete.
 */
export function WorktreesButton() {
  const [open, setOpen] = useState(false);
  const refreshWorktrees = useSwarm((s) => s.refreshWorktrees);
  const cleanupSafeWorktrees = useSwarm((s) => s.cleanupSafeWorktrees);
  const worktrees = useSwarm((s) => s.worktrees);
  const sessionOrder = useVibe((s) => s.order);
  const sessions = useVibe((s) => s.sessions);
  const visible = useSwarm((s) => s.worktrees.length > 0);

  // paths a live session works in — those worktrees count as attached
  const openPaths = useMemo(
    () =>
      new Set(
        sessionOrder
          .map((id) => sessions[id]?.session.projectDir)
          .filter((p): p is string => !!p),
      ),
    [sessionOrder, sessions],
  );

  if (!visible) return null;

  // group per repo, keeping the scan order
  const groups: { root: string; repo: string; entries: WorktreeEntry[] }[] = [];
  for (const e of worktrees) {
    const g = groups.find((x) => x.root === e.root);
    if (g) g.entries.push(e);
    else groups.push({ root: e.root, repo: e.repo, entries: [e] });
  }
  const safeCount = worktrees.filter(
    (e) => !openPaths.has(e.path) && !e.dirty && e.ahead === 0,
  ).length;

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) void refreshWorktrees();
      }}
    >
      <Tip label="Git worktrees">
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant={open ? "secondary" : "ghost"}
            className="no-drag"
          >
            <FolderGit2 size={15} />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="w-96">
        {safeCount > 0 && (
          <div className="mb-1 flex items-center justify-between gap-3 rounded-md bg-secondary/35 px-2 py-1.5">
            <div className="min-w-0">
              <div className="text-xs text-foreground">Safe cleanup ready</div>
              <div className="truncate text-[10px] text-faint">
                {safeCount} clean unattached worktree{safeCount === 1 ? "" : "s"}
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              className="h-7 shrink-0 px-2 text-[11px]"
              onClick={() => void cleanupSafeWorktrees()}
            >
              <CheckCircle2 size={13} />
              Clean up safe
            </Button>
          </div>
        )}
        {groups.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] text-faint">
            No worktrees found.
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.root}>
              <DropdownMenuLabel className="truncate" title={g.root}>
                {g.repo}
              </DropdownMenuLabel>
              {g.entries.map((e) => (
                <WorktreeRow key={e.path} entry={e} close={() => setOpen(false)} />
              ))}
            </div>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorktreeRow({
  entry,
  close,
}: {
  entry: WorktreeEntry;
  close: () => void;
}) {
  const deleteWorktree = useSwarm((s) => s.deleteWorktree);
  // the session currently working in this worktree, if any
  const openSessionId = useVibe(
    (s) =>
      s.order.find((id) => s.sessions[id]?.session.projectDir === entry.path) ??
      null,
  );
  // deleting work (dirty/local-only commits) needs a second click on the armed button
  const [armed, setArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const risky = entry.dirty || entry.ahead > 0;

  const onOpen = () => {
    close();
    if (openSessionId) {
      focusSession(openSessionId);
      return;
    }
    void startSession({
      name: folderName(entry.path),
      projectDir: entry.path,
      access: "workspace",
    })
      .then((id) => focusSession(id))
      .catch(() => {});
  };

  const onDelete = () => {
    if (risky && !armed) {
      setArmed(true);
      return;
    }
    setDeleting(true);
    void deleteWorktree(entry).finally(() => setDeleting(false));
  };

  return (
    <div className="group/wt flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{
          backgroundColor: entry.missing
            ? "var(--faint)"
            : openSessionId
              ? "var(--success)"
              : "var(--muted-foreground)",
        }}
        title={
          entry.missing
            ? "Folder is gone"
            : openSessionId
              ? "Open in a session"
              : "No session attached"
        }
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[11px] text-foreground">
          {entry.branch}
        </div>
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-faint">
          {entry.missing ? (
            <span>folder missing</span>
          ) : (
            <>
              {entry.dirty && (
                <span className="rounded bg-warning/15 px-1 text-warning">
                  uncommitted
                </span>
              )}
              {entry.ahead > 0 && (
                <span className="rounded bg-secondary px-1">
                  ↑{entry.ahead} local-only
                </span>
              )}
              {!entry.dirty && entry.ahead === 0 && <span>clean</span>}
            </>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {!entry.missing && (
          <Tip label={openSessionId ? "Jump to session" : "Open in a new session"}>
            <button
              onClick={onOpen}
              className="flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-secondary hover:text-foreground"
            >
              <Plus size={13} />
            </button>
          </Tip>
        )}
        {!entry.missing && (
          <Tip label="Reveal in Finder">
            <button
              onClick={() => void revealItemInDir(entry.path)}
              className="flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-secondary hover:text-foreground"
            >
              <FolderOpen size={13} />
            </button>
          </Tip>
        )}
        <Tip
          label={
            openSessionId
              ? "Close the session first"
              : armed
                ? "Click again — deletes folder AND branch"
                : risky
                  ? "Delete worktree & branch"
                  : entry.missing
                    ? "Clean up (folder is already gone)"
                    : "Finish and remove worktree"
          }
        >
          <button
            onClick={onDelete}
            disabled={!!openSessionId || deleting}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-30",
              armed
                ? "bg-destructive/15 text-destructive"
                : "text-faint hover:bg-destructive/15 hover:text-destructive",
            )}
          >
            {risky ? <Trash2 size={13} /> : <CheckCircle2 size={13} />}
          </button>
        </Tip>
      </div>
    </div>
  );
}
