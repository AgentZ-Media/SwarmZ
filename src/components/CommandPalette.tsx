import { useEffect, useState } from "react";
import { Command } from "cmdk";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  BarChart3,
  Bell,
  Bot,
  FolderOpen,
  Plus,
  Search,
  Settings,
  StickyNote,
} from "lucide-react";
import { useSwarm } from "@/store";
import { useVibe, type VibeSessionEntry } from "@/lib/vibe/session-store";
import { activateProject, focusSession } from "@/lib/vibe/controller";
import { useProjects, openProjectIds } from "@/lib/projects/store";
import { vibeTriageEntries } from "@/lib/vibe/triage";
import { hasPendingApproval } from "@/lib/vibe/ui";
import { useVibeUi } from "@/lib/vibe/ui-store";
import { pickDirectory } from "@/lib/transport";
import { cn, shortPath } from "@/lib/utils";

/**
 * ⌘K — fuzzy-jump to any session and reach every global action without the
 * mouse. Built on cmdk; opens above everything, closes on Escape or after
 * running a command.
 */
export function CommandPalette({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}) {
  const open = useSwarm((s) => s.paletteOpen);
  const setOpen = useSwarm((s) => s.setPaletteOpen);
  const order = useVibe((s) => s.order);
  const sessions = useVibe((s) => s.sessions);
  // primitive signature — never a fresh array from the selector
  const projectIdsSig = useProjects((s) => openProjectIds(s).join("|"));
  const projectIds = projectIdsSig ? projectIdsSig.split("|") : [];
  const projects = useProjects((s) => s.projects);
  const activeProjectId = useProjects((s) => s.activeProjectId);

  const [search, setSearch] = useState("");

  useEffect(() => {
    if (open) setSearch("");
  }, [open]);

  /** close first, then act — actions may move focus elsewhere */
  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  const waiting = vibeTriageEntries(useVibe.getState()).length;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-overlay-in" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-[18%] z-50 w-full max-w-lg -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-[0_16px_48px_-12px_rgba(0,0,0,0.7)] data-[state=open]:animate-in"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <DialogPrimitive.Title className="sr-only">
            Command palette
          </DialogPrimitive.Title>
          <Command label="Command palette" loop>
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search size={14} className="shrink-0 text-faint" />
              <Command.Input
                value={search}
                onValueChange={setSearch}
                placeholder="Jump to a session or action…"
                className="h-11 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-faint"
              />
              <kbd className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-faint">
                esc
              </kbd>
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-sm text-faint">
                Nothing found.
              </Command.Empty>

              <PaletteGroup heading="Projects">
                {projectIds.map((id, i) => {
                  const p = projects[id];
                  if (!p) return null;
                  return (
                    <PaletteItem
                      key={id}
                      value={`project ${p.name} ${p.dir} ${id}`}
                      onSelect={() => run(() => activateProject(id))}
                    >
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{
                          backgroundColor:
                            activeProjectId === id
                              ? "var(--ring)"
                              : "var(--faint)",
                        }}
                      />
                      <span className="truncate text-foreground">{p.name}</span>
                      <span className="ml-auto min-w-0 truncate pl-3 font-mono text-[10px] text-faint">
                        {shortPath(p.dir)}
                      </span>
                      {i <= 8 && <Shortcut>⌘{i + 1}</Shortcut>}
                    </PaletteItem>
                  );
                })}
                <PaletteItem
                  value="open project folder tab"
                  onSelect={() =>
                    run(() => {
                      void pickDirectory().then(async (dir) => {
                        if (!dir) return;
                        const id = await useProjects
                          .getState()
                          .openProject(dir);
                        activateProject(id);
                      });
                    })
                  }
                >
                  <FolderOpen size={13} className="shrink-0 text-faint" />
                  Open project…
                </PaletteItem>
              </PaletteGroup>

              <PaletteGroup heading="Sessions">
                {order.map((id) => {
                  const entry = sessions[id];
                  if (!entry) return null;
                  const s = entry.session;
                  return (
                    <PaletteItem
                      key={id}
                      value={`session ${s.name} ${s.projectDir} ${id}`}
                      onSelect={() => run(() => focusSession(id))}
                    >
                      <SessionDot entry={entry} />
                      <span className="truncate text-foreground">{s.name}</span>
                      <span className="ml-auto min-w-0 truncate pl-3 font-mono text-[10px] text-faint">
                        {shortPath(s.projectDir)}
                      </span>
                    </PaletteItem>
                  );
                })}
              </PaletteGroup>

              <PaletteGroup heading="Actions">
                <PaletteItem
                  value="new codex session native agent"
                  onSelect={() =>
                    run(() => useVibeUi.getState().setNewSessionOpen(true))
                  }
                >
                  <Plus size={13} className="shrink-0 text-faint" />
                  New session
                  <Shortcut>⌘T</Shortcut>
                </PaletteItem>
                <PaletteItem
                  value="focus conductor orchestrator chat"
                  onSelect={() =>
                    run(() => useVibeUi.getState().setStageMode("conductor"))
                  }
                >
                  <Bot size={13} className="shrink-0 text-faint" />
                  Focus Conductor
                  <Shortcut>⌘⇧O</Shortcut>
                </PaletteItem>
                <PaletteItem
                  value="next attention waiting session jump approval"
                  onSelect={() =>
                    run(() => {
                      const entries = vibeTriageEntries(useVibe.getState());
                      if (entries.length) focusSession(entries[0].id);
                    })
                  }
                >
                  <Bell size={13} className="shrink-0 text-faint" />
                  Jump to session waiting for input
                  {waiting > 0 && (
                    <span className="ml-1.5 rounded bg-ring/15 px-1 font-mono text-[10px] tabular-nums text-ring">
                      {waiting}
                    </span>
                  )}
                  <Shortcut>⌘⇧A</Shortcut>
                </PaletteItem>
                <PaletteItem
                  value="quick notes checklist"
                  onSelect={() => run(() => useSwarm.getState().setNotesOpen(true))}
                >
                  <StickyNote size={13} className="shrink-0 text-faint" />
                  Quick notes
                  <Shortcut>⌘N</Shortcut>
                </PaletteItem>
                <PaletteItem
                  value="usage dashboard tokens cost"
                  onSelect={() =>
                    run(() => useSwarm.getState().setDashboardOpen(true))
                  }
                >
                  <BarChart3 size={13} className="shrink-0 text-faint" />
                  Usage dashboard
                </PaletteItem>
                <PaletteItem
                  value="settings preferences"
                  onSelect={() => run(onOpenSettings)}
                >
                  <Settings size={13} className="shrink-0 text-faint" />
                  Settings
                  <Shortcut>⌘,</Shortcut>
                </PaletteItem>
              </PaletteGroup>
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function PaletteGroup({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <Command.Group
      heading={heading}
      className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-faint"
    >
      {children}
    </Command.Group>
  );
}

export function PaletteItem({
  value,
  onSelect,
  children,
  className,
}: {
  value: string;
  onSelect: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className={cn(
        "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground",
        "data-[selected=true]:bg-accent data-[selected=true]:text-foreground",
        className,
      )}
    >
      {children}
    </Command.Item>
  );
}

export function Shortcut({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="ml-auto pl-3 font-mono text-[10px] tabular-nums text-faint">
      {children}
    </kbd>
  );
}

/** Status dot matching the signal triad, condensed: amber dot + ⚑ for
 * needs-you (pending approval), quiet muted dot for working, faint for idle. */
function SessionDot({ entry }: { entry: VibeSessionEntry }) {
  const busy = useVibe((s) => !!s.busy[entry.session.id]);
  const needsYou = hasPendingApproval(entry);
  const color = needsYou
    ? "var(--attn)"
    : busy
      ? "var(--muted-foreground)"
      : "var(--faint)";
  return (
    <>
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      {needsYou && (
        <span className="shrink-0 font-mono text-[10px] font-semibold leading-none text-attn">
          ⚑
        </span>
      )}
    </>
  );
}
