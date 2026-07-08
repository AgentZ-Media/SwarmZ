import { useEffect, useRef, useState } from "react";
import { Command } from "cmdk";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  BarChart3,
  Bell,
  Bot,
  Boxes,
  LayoutGrid,
  LayoutTemplate,
  Plus,
  ScrollText,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  SquarePlus,
  Wand2,
} from "lucide-react";
import { presetKey, useSwarm } from "@/store";
import { useAgents } from "@/lib/agents/store";
import { useVibeUi } from "@/lib/vibe/ui-store";
import { focusTerm } from "@/lib/term-host";
import { extractInputLabels } from "@/lib/command-vars";
import { insertCommandText } from "@/lib/insert-command";
import { cn, shortPath } from "@/lib/utils";
import type { Agent, CustomCommand } from "@/types";

/**
 * ⌘K — fuzzy-jump to any agent or workspace and reach every global action
 * without the mouse. Built on cmdk; opens above everything, closes on Escape
 * or after running a command. Custom commands (⌘⇧K snippets) surface here too
 * once a search is typed — same semantics as the insert picker (↵ pastes,
 * ⌘↵ pastes & runs, {{input}} commands detour through the picker's form).
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
  const customCommands = useSwarm((s) => s.customCommands);
  const targetId = useSwarm((s) => s.focusedAgentId ?? s.activeAgentId());

  const [search, setSearch] = useState("");
  // ⌘ state of the Enter keydown that triggered cmdk's onSelect (fired
  // synchronously inside the same event) — mouse clicks leave it false
  const submitRef = useRef(false);

  useEffect(() => {
    if (open) setSearch("");
  }, [open]);

  /** close first, then act — actions may move focus into a terminal */
  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  const targetAgent = targetId ? agents[targetId] : undefined;
  const folderKey = targetAgent ? presetKey(targetAgent.cwd) : null;
  const folderCmds = folderKey
    ? (customCommands.folders[folderKey] ?? [])
    : [];
  const globalCmds = customCommands.global;
  // only while searching — the default palette view stays uncluttered
  const showCommands =
    search.trim().length > 0 &&
    !!targetId &&
    folderCmds.length + globalCmds.length > 0;

  const runCommand = (cmd: CustomCommand) => {
    const submit = submitRef.current;
    submitRef.current = false;
    if (!targetId) return;
    setOpen(false);
    if (extractInputLabels(cmd.text).length) {
      // needs {{input}} values — detour through the insert picker's form
      const s = useSwarm.getState();
      s.setCommandPickerPreselect({ cmd, submit });
      s.setCommandPickerOpen(true);
    } else {
      insertCommandText(targetId, cmd.text, submit);
    }
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
  const uiMode = useSwarm((s) => s.settings.uiMode ?? "grid");

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
          <Command
            label="Command palette"
            loop
            onKeyDownCapture={(e) => {
              if (e.key === "Enter") submitRef.current = e.metaKey;
            }}
          >
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search size={14} className="shrink-0 text-faint" />
              <Command.Input
                value={search}
                onValueChange={setSearch}
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

              {showCommands && (
                <PaletteGroup heading="Commands · ↵ paste · ⌘↵ run">
                  {[...folderCmds, ...globalCmds].map((c) => (
                    <PaletteItem
                      key={c.id}
                      value={`command ${c.label} ${c.text} ${c.id}`}
                      onSelect={() => runCommand(c)}
                    >
                      <ScrollText size={13} className="shrink-0 text-faint" />
                      <span className="truncate text-foreground">{c.label}</span>
                      <span className="ml-auto max-w-[45%] truncate pl-3 font-mono text-[10px] text-faint">
                        {c.text.replace(/\s+/g, " ")}
                      </span>
                    </PaletteItem>
                  ))}
                </PaletteGroup>
              )}

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
                  value={
                    uiMode === "vibe"
                      ? "switch to grid mode view terminals"
                      : "switch to vibe mode view sessions conductor"
                  }
                  onSelect={() =>
                    run(() =>
                      useSwarm.getState().setUiMode(uiMode === "vibe" ? "grid" : "vibe"),
                    )
                  }
                >
                  {uiMode === "vibe" ? (
                    <LayoutGrid size={13} className="shrink-0 text-faint" />
                  ) : (
                    <Sparkles size={13} className="shrink-0 text-faint" />
                  )}
                  {uiMode === "vibe" ? "Switch to Grid mode" : "Switch to Vibe mode"}
                  <Shortcut>⌘⇧V</Shortcut>
                </PaletteItem>
                <PaletteItem
                  value="focus conductor orchestrator vibe chat"
                  onSelect={() =>
                    run(() => {
                      useSwarm.getState().setUiMode("vibe");
                      useVibeUi.getState().setStageMode("conductor");
                    })
                  }
                >
                  <Bot size={13} className="shrink-0 text-faint" />
                  Focus Conductor
                </PaletteItem>
                <PaletteItem
                  value="new codex session native vibe agent"
                  onSelect={() =>
                    run(() => {
                      useSwarm.getState().setUiMode("vibe");
                      useVibeUi.getState().setNewSessionOpen(true);
                    })
                  }
                >
                  <Plus size={13} className="shrink-0 text-faint" />
                  New Codex session
                </PaletteItem>
                <PaletteItem
                  value="next pane cycle focus"
                  onSelect={() =>
                    run(() => useSwarm.getState().cycleActivePane(1))
                  }
                >
                  <LayoutGrid size={13} className="shrink-0 text-faint" />
                  Next pane
                  <Shortcut>⌘]</Shortcut>
                </PaletteItem>
                <PaletteItem
                  value="previous pane cycle focus"
                  onSelect={() =>
                    run(() => useSwarm.getState().cycleActivePane(-1))
                  }
                >
                  <LayoutGrid size={13} className="shrink-0 text-faint" />
                  Previous pane
                  <Shortcut>⌘[</Shortcut>
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
                  value="agents library custom personas specialists"
                  onSelect={() =>
                    run(() => useAgents.getState().setLibraryOpen(true))
                  }
                >
                  <Boxes size={13} className="shrink-0 text-faint" />
                  Agents
                </PaletteItem>
                <PaletteItem
                  value="new agent build custom specialist persona builder"
                  onSelect={() =>
                    run(() => useAgents.getState().setNewBuilderOpen(true))
                  }
                >
                  <Wand2 size={13} className="shrink-0 text-faint" />
                  New agent
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

/** Status dot matching the pane header's signal triad, condensed: amber
 * dot + ⚑ for needs-you, quiet muted dot for busy, green for idle/alive. */
function AgentDot({ agent }: { agent: Agent }) {
  const state =
    agent.status === "running" && agent.activity
      ? agent.activity
      : agent.status;
  const needsYou =
    agent.status !== "exited" &&
    (agent.attention || agent.activity === "waiting");
  const color = needsYou
    ? "var(--attn)"
    : state === "busy" || state === "starting"
      ? "var(--muted-foreground)"
      : state === "exited"
        ? "var(--faint)"
        : "var(--success)";
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
