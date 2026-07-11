import { useEffect, useState } from "react";
import { Command } from "cmdk";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Search } from "lucide-react";
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
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[rgba(5,5,8,0.55)] backdrop-blur-[2px] data-[state=open]:animate-zoverlay" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-[16%] z-50 w-full max-w-[560px] -translate-x-1/2 overflow-hidden rounded-2xl border border-line2 bg-pop shadow-modal data-[state=open]:animate-zfadeup"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <DialogPrimitive.Title className="sr-only">
            Command palette
          </DialogPrimitive.Title>
          <Command label="Command palette" loop>
            <div className="flex items-center gap-2 border-b border-line px-3">
              <Search size={14} className="shrink-0 text-fnt" />
              <Command.Input
                value={search}
                onValueChange={setSearch}
                placeholder="Jump to an agent or action…"
                className="h-11 w-full bg-transparent text-14 text-txt outline-none placeholder:text-fnt"
              />
              <kbd className="rounded-xs border border-line2 px-1 font-mono text-10 text-fnt">
                esc
              </kbd>
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-13 text-fnt">
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
                        className={cn(
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          activeProjectId === id ? "bg-acc" : "bg-fnt",
                        )}
                      />
                      <span className="truncate text-txt">{p.name}</span>
                      <span className="ml-auto min-w-0 truncate pl-3 font-mono text-10 text-fnt">
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
                  <ActionDot />
                  <span className="truncate text-txt">Open project…</span>
                </PaletteItem>
              </PaletteGroup>

              <PaletteGroup heading="Agents">
                {order.map((id) => {
                  const entry = sessions[id];
                  if (!entry) return null;
                  const s = entry.session;
                  return (
                    <PaletteItem
                      key={id}
                      value={`agent session ${s.name} ${s.projectDir} ${id}`}
                      onSelect={() => run(() => focusSession(id))}
                    >
                      <SessionDot entry={entry} />
                      <span className="truncate text-txt">{s.name}</span>
                      <span className="ml-auto min-w-0 truncate pl-3 font-mono text-10 text-fnt">
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
                  <ActionDot />
                  <span className="truncate text-txt">New agent</span>
                  <Shortcut>⌘T</Shortcut>
                </PaletteItem>
                <PaletteItem
                  value="focus conductor orchestrator chat"
                  onSelect={() =>
                    run(() => useVibeUi.getState().showConductor())
                  }
                >
                  <ActionDot />
                  <span className="truncate text-txt">Focus Conductor</span>
                  <Shortcut>⌘⇧O</Shortcut>
                </PaletteItem>
                <PaletteItem
                  value="toggle conductor sidebar show hide"
                  onSelect={() =>
                    run(() => useVibeUi.getState().toggleConductor())
                  }
                >
                  <ActionDot />
                  <span className="truncate text-txt">
                    Toggle Conductor sidebar
                  </span>
                  <Shortcut>⌘B</Shortcut>
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
                  <ActionDot />
                  <span className="truncate text-txt">
                    Jump to agent waiting for input
                  </span>
                  {waiting > 0 && (
                    <span className="ml-1.5 rounded-xs bg-acc/15 px-1 font-mono text-10 tabular-nums text-acc">
                      {waiting}
                    </span>
                  )}
                  <Shortcut>⌘⇧A</Shortcut>
                </PaletteItem>
                <PaletteItem
                  value="quick notes checklist"
                  onSelect={() => run(() => useSwarm.getState().setNotesOpen(true))}
                >
                  <ActionDot />
                  <span className="truncate text-txt">Quick notes</span>
                  <Shortcut>⌘N</Shortcut>
                </PaletteItem>
                <PaletteItem
                  value="usage dashboard tokens cost"
                  onSelect={() =>
                    run(() => useSwarm.getState().setDashboardOpen(true))
                  }
                >
                  <ActionDot />
                  <span className="truncate text-txt">Usage dashboard</span>
                </PaletteItem>
                <PaletteItem
                  value="settings preferences"
                  onSelect={() => run(onOpenSettings)}
                >
                  <ActionDot />
                  <span className="truncate text-txt">Settings</span>
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
      className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-10 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[.08em] [&_[cmdk-group-heading]]:text-fnt"
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
        "flex cursor-default select-none items-center gap-2 rounded-md px-3 py-1.5 text-13 text-mut",
        "data-[selected=true]:bg-line data-[selected=true]:text-txt",
        className,
      )}
    >
      {children}
    </Command.Item>
  );
}

export function Shortcut({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="ml-auto pl-3 font-mono text-10 tabular-nums text-fnt">
      {children}
    </kbd>
  );
}

/** Action rows carry the accent dot — "this takes you somewhere". */
function ActionDot() {
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-acc" />;
}

/** Status dot matching the signal triad, condensed: amber dot + ⚑ for
 * needs-you (pending approval), accent dot for working (DESIGN.md: working =
 * accent), faint for idle. */
function SessionDot({ entry }: { entry: VibeSessionEntry }) {
  const busy = useVibe((s) => !!s.busy[entry.session.id]);
  const needsYou = hasPendingApproval(entry);
  return (
    <>
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          needsYou ? "bg-attn" : busy ? "bg-acc" : "bg-fnt",
        )}
      />
      {needsYou && (
        <span className="shrink-0 font-mono text-10 font-semibold leading-none text-attn">
          ⚑
        </span>
      )}
    </>
  );
}
