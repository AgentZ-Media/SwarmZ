import { useState, type ReactNode } from "react";
import {
  BarChart3,
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

/** Donut + "free / total" readout for the agent's current context window. */
function ContextGauge({ usage }: { usage: SessionUsage }) {
  const used = usage.context_tokens;
  const limit = usage.context_limit;
  if (!used || !limit) return null;

  const free = Math.max(limit - used, 0);
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
          Context: {formatTokens(used)} used · {formatTokens(free)} free of{" "}
          {formatTokens(limit)} ({Math.round(pct * 100)}%)
        </span>
      }
    >
      <span className="flex shrink-0 items-center gap-1.5">
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
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {formatTokens(free)}
          <span className="text-faint">/{formatTokens(limit)} free</span>
        </span>
      </span>
    </Tip>
  );
}

/** One key/value line inside the per-agent stats popover. */
function StatRow({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[11px]">
      <span className="shrink-0 text-faint">{k}</span>
      <span className="truncate text-right font-mono tabular-nums text-foreground">
        {v}
      </span>
    </div>
  );
}

/** Per-pane stats: everything tracked for this agent, on demand. */
function AgentStatsButton({ agent }: { agent: Agent }) {
  const u = agent.usage;
  const totalTokens = u
    ? u.input_tokens +
      u.output_tokens +
      u.cache_creation_tokens +
      u.cache_read_tokens
    : 0;
  return (
    <DropdownMenu>
      <Tip label="Agent stats">
        <DropdownMenuTrigger asChild>
          <button className="no-drag flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground">
            <BarChart3 size={13} />
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="w-72">
        <div className="space-y-2.5 px-2 py-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs font-medium text-foreground">
              {agent.name}
            </span>
            {u?.primary_model && (
              <Badge className="font-mono">{prettyModel(u.primary_model)}</Badge>
            )}
          </div>

          {!u || u.message_count === 0 ? (
            <p className="pb-1 text-[11px] text-faint">No Claude activity yet.</p>
          ) : (
            <>
              {u.context_tokens > 0 && u.context_limit > 0 && (
                <div className="space-y-1">
                  <StatRow
                    k="Context"
                    v={`${formatTokens(u.context_tokens)} used · ${formatTokens(
                      Math.max(u.context_limit - u.context_tokens, 0),
                    )} free of ${formatTokens(u.context_limit)}`}
                  />
                  <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-ring"
                      style={{
                        width: `${Math.min(
                          (u.context_tokens / u.context_limit) * 100,
                          100,
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              )}
              <div className="space-y-1 border-t border-border pt-2">
                <StatRow k="Messages" v={u.message_count} />
                <StatRow k="Input tokens" v={formatTokens(u.input_tokens)} />
                <StatRow k="Output tokens" v={formatTokens(u.output_tokens)} />
                <StatRow
                  k="Cache write"
                  v={formatTokens(u.cache_creation_tokens)}
                />
                <StatRow k="Cache read" v={formatTokens(u.cache_read_tokens)} />
                <StatRow k="Total tokens" v={formatTokens(totalTokens)} />
                <StatRow k="Est. API cost" v={formatUsd(u.cost_usd)} />
              </div>
              <div className="space-y-1 border-t border-border pt-2">
                {u.git_branch && <StatRow k="Branch" v={u.git_branch} />}
                {(u.cwd || agent.cwd) && (
                  <StatRow k="Folder" v={shortPath(u.cwd ?? agent.cwd)} />
                )}
                <StatRow
                  k="Started"
                  v={new Date(agent.createdAt).toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                />
              </div>
            </>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusDot({ agent }: { agent: Agent }) {
  // claude's reported activity refines the coarse pty status while running
  const state =
    agent.status === "running" && agent.activity
      ? agent.activity === "waiting"
        ? "attention"
        : agent.activity
      : agent.status;
  const map: Record<string, { color: string; label: string }> = {
    starting: { color: "var(--warning)", label: "Starting" },
    running: { color: "var(--success)", label: "Running" },
    busy: { color: "var(--warning)", label: "Working…" },
    idle: { color: "var(--success)", label: "Idle" },
    attention: { color: "var(--ring)", label: "Waiting for input" },
    exited: { color: "var(--faint)", label: "Exited" },
  };
  const { color, label } = map[state] ?? { color: "var(--faint)", label: state };
  return (
    <Tip label={label}>
      <span className="relative flex h-1.5 w-1.5">
        {(state === "running" || state === "busy") && (
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
    </Tip>
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
          {usage && <ContextGauge usage={usage} />}

          <AgentStatsButton agent={agent} />

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
