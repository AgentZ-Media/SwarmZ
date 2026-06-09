import { useState } from "react";
import {
  Bell,
  Columns2,
  Folder,
  MoreVertical,
  Rows2,
  X,
} from "lucide-react";
import { useSwarm } from "@/store";
import { TerminalView } from "./Terminal";
import { Tip } from "./ui/tooltip";
import { Badge } from "./ui/misc";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  cn,
  formatTokens,
  formatUsd,
  prettyModel,
  shortPath,
} from "@/lib/utils";
import type { Agent, SessionUsage } from "@/types";

/** Tiny donut showing how full the agent's context window currently is. */
function ContextDonut({ usage }: { usage: SessionUsage }) {
  const used = usage.context_tokens;
  const limit = usage.context_limit;
  if (!used || !limit) return null;

  const pct = Math.min(used / limit, 1);
  const r = 5;
  const circ = 2 * Math.PI * r;
  const color =
    pct >= 0.85
      ? "var(--destructive)"
      : pct >= 0.65
        ? "var(--warning)"
        : "var(--ring)";

  return (
    <Tip
      label={
        <span className="font-mono text-[11px]">
          Context: {formatTokens(used)} / {formatTokens(limit)} (
          {Math.round(pct * 100)}%)
        </span>
      }
    >
      <svg width={14} height={14} viewBox="0 0 14 14" className="shrink-0 -rotate-90">
        <circle
          cx={7}
          cy={7}
          r={r}
          fill="none"
          stroke="var(--border)"
          strokeWidth={2.5}
        />
        <circle
          cx={7}
          cy={7}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={2.5}
          strokeDasharray={`${pct * circ} ${circ}`}
          strokeLinecap="round"
        />
      </svg>
    </Tip>
  );
}

function StatusDot({ agent }: { agent: Agent }) {
  const map: Record<string, string> = {
    starting: "var(--warning)",
    running: "var(--success)",
    attention: "var(--ring)",
    exited: "var(--faint)",
  };
  const color = map[agent.status] ?? "var(--faint)";
  return (
    <span className="relative flex h-1.5 w-1.5">
      {agent.status === "running" && (
        <span
          className="absolute inline-flex h-full w-full rounded-full opacity-60"
          style={{ backgroundColor: color }}
        />
      )}
      <span
        className="relative inline-flex h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
    </span>
  );
}

export function AgentPane({
  agentId,
  active,
}: {
  agentId: string;
  active: boolean;
}) {
  const agent = useSwarm((s) => s.agents[agentId]);
  const removeAgent = useSwarm((s) => s.removeAgent);
  const splitActive = useSwarm((s) => s.splitActive);
  const focusAgent = useSwarm((s) => s.focusAgent);
  const renameAgent = useSwarm((s) => s.renameAgent);
  const [editing, setEditing] = useState(false);

  if (!agent) return null;

  const usage = agent.usage;
  const totalTokens = usage
    ? usage.input_tokens +
      usage.output_tokens +
      usage.cache_creation_tokens +
      usage.cache_read_tokens
    : 0;
  const model = usage?.primary_model;

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-lg border bg-card transition-colors",
        active ? "border-ring/50" : "border-border",
        agent.attention && !active && "attn-pulse border-ring/50",
      )}
      onMouseDown={() => focusAgent(agentId)}
    >
      {/* header */}
      <div
        className={cn(
          "flex h-9 shrink-0 items-center gap-2 border-b border-border px-2.5",
          active ? "bg-secondary/70" : "bg-transparent",
        )}
      >
        <StatusDot agent={agent} />

        {editing ? (
          <input
            autoFocus
            defaultValue={agent.name}
            onBlur={(e) => {
              renameAgent(agentId, e.target.value);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditing(false);
            }}
            className="h-6 w-28 rounded-md bg-secondary px-1.5 text-xs text-foreground outline-none select-text"
          />
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "shrink-0 truncate text-xs font-medium",
                active ? "text-foreground" : "text-muted-foreground",
              )}
              onDoubleClick={() => setEditing(true)}
            >
              {agent.name}
            </span>
            {agent.cwd && (
              <Tip label={agent.cwd}>
                <span className="flex min-w-0 items-center gap-1 font-mono text-[10px] text-faint">
                  <Folder size={10} className="shrink-0" />
                  <span className="truncate">{shortPath(agent.cwd)}</span>
                </span>
              </Tip>
            )}
          </div>
        )}

        {agent.attention && <Bell size={12} className="text-ring" />}

        <div className="ml-auto flex items-center gap-1.5">
          {model && <Badge className="font-mono">{prettyModel(model)}</Badge>}
          {usage && <ContextDonut usage={usage} />}
          {usage && totalTokens > 0 && (
            <Tip
              label={
                <div className="space-y-0.5 font-mono text-[11px]">
                  <div>Input: {formatTokens(usage.input_tokens)}</div>
                  <div>Output: {formatTokens(usage.output_tokens)}</div>
                  <div>Cache write: {formatTokens(usage.cache_creation_tokens)}</div>
                  <div>Cache read: {formatTokens(usage.cache_read_tokens)}</div>
                  <div>Messages: {usage.message_count}</div>
                </div>
              }
            >
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {formatTokens(totalTokens)}
              </span>
            </Tip>
          )}
          {usage && usage.cost_usd > 0 && (
            <span className="font-mono text-[11px] tabular-nums text-foreground">
              {formatUsd(usage.cost_usd)}
            </span>
          )}

          <Tip label="Split right">
            <button
              className="no-drag flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                focusAgent(agentId);
                splitActive("row");
              }}
            >
              <Columns2 size={13} />
            </button>
          </Tip>
          <Tip label="Split down">
            <button
              className="no-drag flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                focusAgent(agentId);
                splitActive("column");
              }}
            >
              <Rows2 size={13} />
            </button>
          </Tip>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="no-drag flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground">
                <MoreVertical size={13} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <div className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
                {shortPath(agent.cwd)}
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => splitActive("row")}>
                <Columns2 /> Split right
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => splitActive("column")}>
                <Rows2 /> Split down
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem danger onSelect={() => removeAgent(agentId)}>
                <X /> Close agent
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Tip label="Close">
            <button
              className="no-drag flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-destructive/15 hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                removeAgent(agentId);
              }}
            >
              <X size={13} />
            </button>
          </Tip>
        </div>
      </div>

      {/* terminal */}
      <div className="relative min-h-0 flex-1">
        <TerminalView
          agentId={agentId}
          cwd={agent.cwd}
          startup={agent.startup}
          active={active}
        />
      </div>
    </div>
  );
}
