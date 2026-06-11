import { Command } from "cmdk";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  BarChart3,
  Bell,
  LayoutGrid,
  LayoutTemplate,
  Plus,
  ScrollText,
  Search,
  Settings,
  SlidersHorizontal,
  SquarePlus,
} from "lucide-react";
import { useSwarm } from "@/store";
import { focusTerm } from "@/lib/term-host";
import { cn, shortPath } from "@/lib/utils";
import type { Agent } from "@/types";

/**
 * ⌘K — fuzzy-jump to any agent or workspace and reach every global action
 * without the mouse. Built on cmdk; opens above everything, closes on Escape
 * or after running a command.
 */
export function CommandPalette({
  onOpenProfiles,
  onOpenSettings,
}: {
  onOpenProfiles: () => void;
  onOpenSettings: () => void;
}) {
  const open = useSwarm((s) => s.paletteOpen);
  const setOpen = useSwarm((s) => s.setPaletteOpen);
  const agents = useSwarm((s) => s.agents);
  const order = useSwarm((s) => s.order);
  const workspaces = useSwarm((s) => s.workspaces);
  const workspaceOrder = useSwarm((s) => s.workspaceOrder);

  /** close first, then act — actions may move focus into a terminal */
  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  const jumpToAgent = (id: string) => {
    const s = useSwarm.getState();
    s.setFleetOpen(false);
    s.focusAgent(id);
    focusTerm(id);
  };

  const waiting = order.filter((id) => {
    const a = agents[id];
    return a && (a.attention || a.activity === "waiting");
  }).length;

  const activeHasGrid = useSwarm((s) => !!s.layouts[s.activeWorkspaceId]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-overlay-in" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-[18%] z-50 w-full max-w-lg -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-[0_16px_48px_-12px_rgba(0,0,0,0.7)] data-[state=open]:animate-in"
          // palette actions focus a terminal themselves — don't restore focus
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <DialogPrimitive.Title className="sr-only">
            Command palette
          </DialogPrimitive.Title>
          <Command label="Command palette" loop>
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search size={14} className="shrink-0 text-faint" />
              <Command.Input
                placeholder="Jump to an agent, workspace or action…"
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

              <PaletteGroup heading="Agents">
                {order.map((id) => {
                  const a = agents[id];
                  if (!a) return null;
                  const ws = workspaces[a.workspaceId];
                  return (
                    <PaletteItem
                      key={id}
                      value={`agent ${a.name} ${ws?.name ?? ""} ${a.cwd ?? ""} ${id}`}
                      onSelect={() => run(() => jumpToAgent(id))}
                    >
                      <AgentDot agent={a} />
                      <span className="truncate text-foreground">{a.name}</span>
                      <span className="ml-auto flex min-w-0 items-center gap-2 pl-3 font-mono text-[10px] text-faint">
                        {ws && <span className="truncate">{ws.name}</span>}
                        {a.cwd && (
                          <span className="hidden truncate sm:inline">
                            {shortPath(a.cwd)}
                          </span>
                        )}
                      </span>
                    </PaletteItem>
                  );
                })}
              </PaletteGroup>

              <PaletteGroup heading="Workspaces">
                {workspaceOrder.map((id, i) => (
                  <PaletteItem
                    key={id}
                    value={`workspace ${workspaces[id]?.name ?? ""} ${id}`}
                    onSelect={() =>
                      run(() => useSwarm.getState().setActiveWorkspace(id))
                    }
                  >
                    <LayoutGrid size={13} className="shrink-0 text-faint" />
                    <span className="truncate">{workspaces[id]?.name}</span>
                    <Shortcut>⌘{i + 1}</Shortcut>
                  </PaletteItem>
                ))}
                <PaletteItem
                  value="workspace new create"
                  onSelect={() =>
                    run(() => useSwarm.getState().createWorkspace())
                  }
                >
                  <SquarePlus size={13} className="shrink-0 text-faint" />
                  New workspace
                  <Shortcut>⌘⇧N</Shortcut>
                </PaletteItem>
              </PaletteGroup>

              <PaletteGroup heading="Actions">
                <PaletteItem
                  value="new agent launch terminal"
                  onSelect={() =>
                    run(() => useSwarm.getState().setNewAgentOpen(true))
                  }
                >
                  <Plus size={13} className="shrink-0 text-faint" />
                  New agent
                  <Shortcut>⌘T</Shortcut>
                </PaletteItem>
                <PaletteItem
                  value="fleet overview all workspaces"
                  onSelect={() => run(() => useSwarm.getState().setFleetOpen(true))}
                >
                  <LayoutGrid size={13} className="shrink-0 text-faint" />
                  Fleet overview
                  <Shortcut>⌘E</Shortcut>
                </PaletteItem>
                <PaletteItem
                  value="next attention waiting agent jump"
                  onSelect={() => run(() => useSwarm.getState().attentionJump())}
                >
                  <Bell size={13} className="shrink-0 text-faint" />
                  Jump to agent waiting for input
                  {waiting > 0 && (
                    <span className="ml-1.5 rounded bg-ring/15 px-1 font-mono text-[10px] tabular-nums text-ring">
                      {waiting}
                    </span>
                  )}
                  <Shortcut>⌘⇧A</Shortcut>
                </PaletteItem>
                <PaletteItem
                  value="insert custom command snippet prompt"
                  onSelect={() =>
                    run(() => useSwarm.getState().setCommandPickerOpen(true))
                  }
                >
                  <ScrollText size={13} className="shrink-0 text-faint" />
                  Insert command
                  <Shortcut>⌘⇧K</Shortcut>
                </PaletteItem>
                {activeHasGrid && (
                  <PaletteItem
                    value="save workspace as preset layout"
                    onSelect={() =>
                      run(() => useSwarm.getState().setSavePresetOpen(true))
                    }
                  >
                    <LayoutTemplate size={13} className="shrink-0 text-faint" />
                    Save workspace as preset
                  </PaletteItem>
                )}
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
                  value="profiles manage"
                  onSelect={() => run(onOpenProfiles)}
                >
                  <SlidersHorizontal size={13} className="shrink-0 text-faint" />
                  Profiles
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

/** Status dot matching the pane header's logic, condensed. */
function AgentDot({ agent }: { agent: Agent }) {
  const state =
    agent.status === "running" && agent.activity
      ? agent.activity === "waiting"
        ? "attention"
        : agent.activity
      : agent.status;
  const color =
    agent.attention || state === "attention"
      ? "var(--ring)"
      : state === "busy" || state === "starting"
        ? "var(--warning)"
        : state === "exited"
          ? "var(--faint)"
          : "var(--success)";
  return (
    <span
      className="h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}
