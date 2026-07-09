// Shared custom-agent picker — the dropdown both New dialogs use to launch a
// pane/session AS an agent. Mirrors ModelEffortPicker: the caller supplies the
// trigger via `children` (PopoverTrigger asChild), the popover lists the agent
// library (emoji + name + role) with a "No agent" default at the top. Picking
// an agent hands the caller its full summary so it can prefill runtime / model
// / access defaults; picking "No agent" hands back null.

import { type ReactNode, useState } from "react";
import { Check } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { useAgents } from "@/lib/agents/store";
import type { AgentSummary } from "@/lib/agents/types";
import { cn } from "@/lib/utils";

export function AgentPicker({
  children,
  value,
  onChange,
  align = "start",
}: {
  children: ReactNode;
  /** selected agent slug, or null for "No agent" */
  value: string | null;
  onChange: (agent: AgentSummary | null) => void;
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = useState(false);
  const agents = useAgents((s) => s.agents);
  const ensureAgents = useAgents((s) => s.ensureAgents);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) void ensureAgents();
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-64 p-1.5">
        <div className="px-2 pb-1 pt-1 font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
          Agent
        </div>
        <div className="flex max-h-72 flex-col overflow-y-auto">
          <AgentRow
            selected={!value}
            emoji=""
            name="No agent"
            hint="plain pane"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          />
          {(agents ?? []).map((a) => (
            <AgentRow
              key={a.slug}
              selected={a.slug === value}
              emoji={a.emoji}
              accent={a.accent}
              name={a.name}
              hint={a.role || a.defaultRuntime}
              onClick={() => {
                onChange(a);
                setOpen(false);
              }}
            />
          ))}
          {agents !== null && agents.length === 0 && (
            <div className="px-2 py-2 text-[11px] leading-snug text-faint">
              No agents yet — create one in the Agents library.
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AgentRow({
  selected,
  emoji,
  accent,
  name,
  hint,
  onClick,
}: {
  selected: boolean;
  emoji: string;
  accent?: string;
  name: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-secondary"
    >
      <Check
        size={12}
        className={cn("shrink-0 text-ring", selected ? "opacity-100" : "opacity-0")}
      />
      {emoji ? (
        <span className="shrink-0 text-[13px] leading-none">{emoji}</span>
      ) : accent ? (
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: accent }}
        />
      ) : (
        <span className="h-2 w-2 shrink-0 rounded-full border border-border" />
      )}
      <span className="min-w-0 flex-1 truncate text-xs text-foreground">{name}</span>
      <span className="shrink-0 truncate font-mono text-[9px] text-faint">{hint}</span>
    </button>
  );
}
