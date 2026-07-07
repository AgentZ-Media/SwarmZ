import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import {
  BarChart3,
  Bot,
  CheckCircle2,
  Columns2,
  ExternalLink,
  Folder,
  FolderGit2,
  GitBranch,
  Maximize2,
  Minimize2,
  MoreVertical,
  Rows2,
  SquareTerminal,
  X,
} from "lucide-react";
import { useSwarm } from "@/store";
import { TerminalView } from "./Terminal";
import { DictationButton, DictationOverlay } from "./Dictation";
import { FileDropOverlay } from "./FileDropOverlay";
import { Tip } from "./ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Badge } from "./ui/misc";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  cn,
  folderName,
  formatTokens,
  formatUsd,
  prettyModel,
  shortPath,
} from "@/lib/utils";
import { openUrl } from "@/lib/transport";
import type { Agent, GitInfo, SessionUsage, SubagentUsage } from "@/types";

/** Branch + dirty counters (±lines, untracked) for the pane header. */
function GitChip({ git }: { git: GitInfo }) {
  return (
    <Tip
      label={
        <span className="font-mono text-[11px]">
          {git.repo} · {git.branch} · +{git.insertions} −{git.deletions}
          {git.untracked > 0 && ` · ${git.untracked} untracked`}
        </span>
      }
    >
      {/* tabIndex: the tooltip's data needs a keyboard path too */}
      <span
        tabIndex={0}
        className="focus-ring flex shrink-0 items-center gap-1 rounded font-mono text-[10px] tabular-nums @max-md:hidden"
      >
        <span className="flex items-center gap-1 text-faint">
          <GitBranch size={10} className="shrink-0" />
          <span className="max-w-28 truncate">{git.branch}</span>
        </span>
        {git.insertions > 0 && (
          <span className="rounded bg-success/15 px-1 text-success">
            +{git.insertions}
          </span>
        )}
        {git.deletions > 0 && (
          <span className="rounded bg-destructive/15 px-1 text-destructive">
            −{git.deletions}
          </span>
        )}
        {git.untracked > 0 && (
          <span className="rounded bg-secondary px-1 text-faint">
            ?{git.untracked}
          </span>
        )}
      </span>
    </Tip>
  );
}

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
      <span tabIndex={0} className="focus-ring flex shrink-0 items-center gap-1.5 rounded">
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
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground @max-xl:hidden">
          {formatTokens(free)}
          <span className="text-faint">/{formatTokens(limit)} free</span>
        </span>
      </span>
    </Tip>
  );
}

/** One subagent (Task tool) chip: own mini context bar + run state, full
 * breakdown on hover. Subagents run in their own context window, so this is
 * kept separate from the parent's ContextGauge. */
function SubagentChip({ sub }: { sub: SubagentUsage }) {
  const pct =
    sub.context_limit > 0
      ? Math.min(sub.context_tokens / sub.context_limit, 1)
      : 0;
  const color =
    pct >= 0.85
      ? "var(--destructive)"
      : pct >= 0.65
        ? "var(--warning)"
        : "var(--ring)";
  const label = sub.agent_type || "subagent";
  return (
    <Tip
      label={
        <span className="block font-mono text-[11px] leading-relaxed">
          <span className="font-medium">{label}</span>
          {sub.model && (
            <span className="text-faint"> · {prettyModel(sub.model)}</span>
          )}
          {sub.running && <span className="text-success"> · running</span>}
          <br />
          Context: {formatTokens(sub.context_tokens)} used ·{" "}
          {formatTokens(Math.max(sub.context_limit - sub.context_tokens, 0))} free
          of {formatTokens(sub.context_limit)} ({Math.round(pct * 100)}%)
          <br />
          In {formatTokens(sub.input_tokens)} · Out{" "}
          {formatTokens(sub.output_tokens)} · Cache{" "}
          {formatTokens(sub.cache_creation_tokens + sub.cache_read_tokens)}
          <br />
          {sub.message_count} msg · {formatUsd(sub.cost_usd)}
        </span>
      }
    >
      <span
        tabIndex={0}
        className="focus-ring flex shrink-0 items-center gap-1.5 rounded bg-secondary/60 px-1.5 py-0.5 font-mono text-[10px] tabular-nums"
      >
        {/* states are static (DESIGN.md motion doctrine) — green dot = running */}
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            sub.running ? "bg-success" : "bg-faint/60",
          )}
        />
        <span className="max-w-24 truncate text-muted-foreground">{label}</span>
        <span className="relative h-1 w-8 overflow-hidden rounded-full bg-border">
          <span
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${pct * 100}%`, background: color }}
          />
        </span>
        <span className="text-faint">{Math.round(pct * 100)}%</span>
      </span>
    </Tip>
  );
}

/** Thin strip under the pane header listing this agent's subagents. */
function SubagentStrip({ subagents }: { subagents: SubagentUsage[] }) {
  if (subagents.length === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border bg-card/60 px-2.5 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <Tip label="Subagents spawned by this session (own context windows)">
        <span className="flex shrink-0 items-center gap-1 text-faint">
          <Bot size={11} className="shrink-0" />
          <span className="font-mono text-[10px] @max-md:hidden">
            {subagents.length}
          </span>
        </span>
      </Tip>
      {subagents.map((s) => (
        <SubagentChip key={s.agent_id} sub={s} />
      ))}
    </div>
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

/** Per-pane stats: everything tracked for this agent, on demand. A Popover,
 * not a DropdownMenu — it shows a data sheet, not menu items (and the old
 * Tip-wrapping-DropdownMenuTrigger double-asChild conflicted in Radix; the
 * plain `title` attr replaces the tooltip). */
function AgentStatsButton({ agent }: { agent: Agent }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          title="Agent stats"
          className="no-drag focus-ring flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground @max-md:hidden"
        >
          <BarChart3 size={13} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <AgentStatsBody agent={agent} />
      </PopoverContent>
    </Popover>
  );
}

/** Shared body of the stats popover — also lives in the ⋯ menu's "Stats"
 * submenu so the numbers stay reachable when narrow panes hide the button. */
function AgentStatsBody({ agent }: { agent: Agent }) {
  const u = agent.usage;
  const git = agent.git;
  const totalTokens = u
    ? u.input_tokens +
      u.output_tokens +
      u.cache_creation_tokens +
      u.cache_read_tokens
    : 0;
  return (
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
            <p className="pb-1 text-[11px] text-faint">No tracked activity yet.</p>
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
                {!!u.reasoning_output_tokens && (
                  <StatRow
                    k="Reasoning tokens"
                    v={formatTokens(u.reasoning_output_tokens)}
                  />
                )}
                <StatRow
                  k="Cache write"
                  v={formatTokens(u.cache_creation_tokens)}
                />
                <StatRow k="Cache read" v={formatTokens(u.cache_read_tokens)} />
                <StatRow k="Total tokens" v={formatTokens(totalTokens)} />
                <StatRow k="Est. API cost" v={formatUsd(u.cost_usd)} />
              </div>
              {u.subagents && u.subagents.length > 0 && (
                <div className="space-y-1 border-t border-border pt-2">
                  <div className="flex items-center gap-1.5 text-[11px] text-faint">
                    <Bot size={11} /> Subagents ({u.subagents.length})
                  </div>
                  {u.subagents.map((s) => (
                    <StatRow
                      key={s.agent_id}
                      k={s.agent_type || "subagent"}
                      v={`${formatTokens(s.context_tokens)}/${formatTokens(
                        s.context_limit,
                      )} · ${formatUsd(s.cost_usd)}${s.running ? " · ●" : ""}`}
                    />
                  ))}
                </div>
              )}
              <div className="space-y-1 border-t border-border pt-2">
                {agent.worktree ? (
                  <StatRow
                    k="Worktree of"
                    v={folderName(agent.worktree.root)}
                  />
                ) : (
                  git && <StatRow k="Repo" v={git.repo} />
                )}
                {(git?.branch || u.git_branch) && (
                  <StatRow k="Branch" v={git?.branch ?? u.git_branch} />
                )}
                {git && (git.insertions > 0 || git.deletions > 0) && (
                  <StatRow
                    k="Changes"
                    v={
                      <>
                        <span className="text-success">+{git.insertions}</span>{" "}
                        <span className="text-destructive">−{git.deletions}</span>
                      </>
                    }
                  />
                )}
                {git && git.untracked > 0 && (
                  <StatRow k="Untracked files" v={git.untracked} />
                )}
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
  );
}

// ---- Signal triad (see DESIGN.md): every state couples color + shape + word.

/** How long a busy→idle transition shows as "✓ finished" before decaying. */
const FINISHED_MS = 5 * 60_000;

export type PaneSignal =
  | "starting"
  | "working"
  | "needsYou"
  | "finished"
  | "idle"
  | "running"
  | "exited";

/** Derive the pane's display signal from PTY status + reported activity.
 * Exported for the fleet overview's card chrome — one signal rule app-wide. */
export function paneSignal(agent: Agent, now: number): PaneSignal {
  if (agent.status === "exited") return "exited";
  if (agent.status === "starting") return "starting";
  if (agent.attention || agent.activity === "waiting") return "needsYou";
  if (agent.activity === "busy") return "working";
  if (agent.activity === "idle") {
    if (agent.lastBusyEndAt && now - agent.lastBusyEndAt < FINISHED_MS)
      return "finished";
    return "idle";
  }
  return "running"; // plain shells etc. — no activity reports
}

/** Whether the pane needs the human — drives the --attn tint/outline/flash. */
function needsHuman(agent: Agent): boolean {
  return (
    agent.status !== "exited" &&
    (agent.attention || agent.activity === "waiting")
  );
}

function formatAgo(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  return mins <= 0 ? "just now" : `${mins}m ago`;
}

/**
 * The pane's primary status element: glyph + word in 10px mono. The word
 * collapses below @md (the glyph/dot stays — a status is visible at every
 * container tier); the full label always lives in the tooltip. The "finished"
 * age re-renders on a 30s ticker scoped to THIS component only, and only
 * while the finished window is live.
 */
function PaneStatus({ agent }: { agent: Agent }) {
  const signal = paneSignal(agent, Date.now());
  // cheap decay driver: ticks every 30s only while "finished" shows, and the
  // re-render is confined to this small component
  const [, setTick] = useState(0);
  const ticking = signal === "finished";
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [ticking]);

  const word = "font-mono text-[10px] leading-none";
  switch (signal) {
    case "working":
      return (
        <Tip label="Working…">
          <span className={cn(word, "flex shrink-0 items-center gap-1 text-muted-foreground")}>
            <span aria-hidden>▸</span>
            <span className="@max-md:hidden">working</span>
          </span>
        </Tip>
      );
    case "needsYou":
      return (
        <Tip label="Needs your input">
          <span className={cn(word, "flex shrink-0 items-center gap-1 font-semibold text-attn")}>
            <span aria-hidden>⚑</span>
            <span className="@max-md:hidden">needs you</span>
          </span>
        </Tip>
      );
    case "finished": {
      const ago = formatAgo(Date.now() - (agent.lastBusyEndAt ?? 0));
      return (
        <Tip label={`Finished ${ago}`}>
          <span className={cn(word, "flex shrink-0 items-center gap-1 text-success")}>
            <span aria-hidden>✓</span>
            <span className="@max-md:hidden">
              finished <span className="text-success/60">· {ago}</span>
            </span>
          </span>
        </Tip>
      );
    }
    case "starting":
      // quiet muted, like the fleet chrome's "· starting" — a spawning pane
      // is normal, not a warning
      return (
        <Tip label="Starting">
          <span className={cn(word, "flex shrink-0 items-center gap-1 text-muted-foreground")}>
            <span aria-hidden>·</span>
            <span className="@max-md:hidden">starting</span>
          </span>
        </Tip>
      );
    case "idle":
      return (
        <Tip label="Idle">
          <span className={cn(word, "flex shrink-0 items-center gap-1 text-faint")}>
            <span className="h-1.5 w-1.5 rounded-full bg-faint/70" />
            <span className="@max-md:hidden">idle</span>
          </span>
        </Tip>
      );
    case "exited":
      return (
        <Tip label="Exited">
          <span className={cn(word, "flex shrink-0 items-center gap-1 text-faint")}>
            <span className="h-1.5 w-1.5 rounded-full bg-faint" />
            <span className="@max-md:hidden">exited</span>
          </span>
        </Tip>
      );
    case "running":
      return (
        <Tip label="Running">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
        </Tip>
      );
  }
}

export const AgentPane = memo(function AgentPane({
  agentId,
  active,
  onHeaderDragStart,
}: {
  agentId: string;
  active: boolean;
  /** mousedown on the header (outside buttons/inputs) — used by the grid to drag-rearrange panes */
  onHeaderDragStart?: (agentId: string, e: React.MouseEvent) => void;
}) {
  const agent = useSwarm((s) => s.agents[agentId]);
  const requestRemoveAgent = useSwarm((s) => s.requestRemoveAgent);
  const createFloatingTerminal = useSwarm((s) => s.createFloatingTerminal);
  const splitActive = useSwarm((s) => s.splitActive);
  const focusAgent = useSwarm((s) => s.focusAgent);
  const renameAgent = useSwarm((s) => s.renameAgent);
  const focused = useSwarm((s) => s.focusedAgentId === agentId);
  const setFocusedAgent = useSwarm((s) => s.setFocusedAgent);
  const [editing, setEditing] = useState(false);

  const needsYou = !!agent && needsHuman(agent);
  const working = !!agent && agent.status !== "exited" && agent.activity === "busy";

  // One-shot arrive-flash on ENTERING "needs you": a transition counter keys
  // the overlay, so the 300ms animation replays exactly once per entry (a
  // render-phase self-setState, same pattern as WorkspaceLayer's fleetClosing).
  const [flashKey, setFlashKey] = useState(0);
  const prevNeedsYouRef = useRef(needsYou);
  if (prevNeedsYouRef.current !== needsYou) {
    prevNeedsYouRef.current = needsYou;
    if (needsYou) setFlashKey((k) => k + 1);
  }

  if (!agent) return null;

  const usage = agent.usage;
  const model = usage?.primary_model;

  return (
    <div
      className={cn(
        "relative flex h-full w-full flex-col overflow-hidden rounded-lg border bg-card transition-colors",
        // blue = where I am (exclusive); amber = where I'm needed
        active
          ? "border-ring ring-1 ring-ring/40"
          : needsYou
            ? "border-attn/60"
            : "border-border",
      )}
      onMouseDown={() => focusAgent(agentId)}
    >
      {needsYou && flashKey > 0 && (
        <div
          key={flashKey}
          className="arrive-flash pointer-events-none absolute inset-0 z-20 rounded-lg"
        />
      )}
      {/* header — a container query root: as the pane narrows, secondary
          info collapses away (@max-xl: path/readout/split buttons, @max-lg:
          model badge, @max-md: git chip/stats/mic/focus + the status WORD —
          its glyph/dot stays) until only status glyph, truncated title,
          context donut, ⋯ menu and close remain (everything stays reachable
          via tooltips and the ⋯ menu) */}
      <div
        className={cn(
          "@container relative flex h-9 shrink-0 cursor-grab items-center gap-2 border-b px-2.5",
          needsYou
            ? "border-attn/30 bg-attn/10"
            : active
              ? "border-ring/30 bg-ring/10"
              : "border-border bg-transparent",
        )}
        onMouseDown={(e) => {
          if (editing) return;
          if ((e.target as HTMLElement).closest("button, input")) return;
          onHeaderDragStart?.(agentId, e);
        }}
        onDoubleClick={(e) => {
          if (editing) return;
          if ((e.target as HTMLElement).closest("button, input")) return;
          setFocusedAgent(focused ? null : agentId);
        }}
      >
        <PaneStatus agent={agent} />
        {working && <span className="activity-line" aria-hidden />}

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
                "min-w-0 truncate text-xs font-medium",
                active ? "text-foreground" : "text-muted-foreground",
              )}
              onDoubleClick={(e) => {
                // double-click on the title renames; don't toggle focus mode
                e.stopPropagation();
                setEditing(true);
              }}
            >
              {agent.name}
            </span>
            {agent.cwd && (
              <Tip label={agent.cwd}>
                <span className="flex min-w-0 items-center gap-1 font-mono text-[10px] text-faint @max-xl:hidden">
                  <Folder size={10} className="shrink-0" />
                  <span className="truncate">{shortPath(agent.cwd)}</span>
                </span>
              </Tip>
            )}
            {agent.worktree && (
              <Tip
                label={
                  <span className="font-mono text-[11px]">
                    Worktree of {folderName(agent.worktree.root)} ·{" "}
                    {agent.worktree.branch}
                  </span>
                }
              >
                <span className="flex shrink-0 items-center gap-1 rounded bg-secondary px-1 font-mono text-[10px] text-faint @max-md:hidden">
                  <FolderGit2 size={10} className="shrink-0" />
                  worktree
                </span>
              </Tip>
            )}
            {agent.git && <GitChip git={agent.git} />}
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {model && (
            <Badge className="font-mono @max-lg:hidden">
              {prettyModel(model)}
            </Badge>
          )}
          {usage && <ContextGauge usage={usage} />}

          <AgentStatsButton agent={agent} />

          <DictationButton targetId={agentId} className="@max-md:hidden" />

          <Tip label="Floating terminal">
            <button
              className="no-drag focus-ring flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground @max-xl:hidden"
              onClick={(e) => {
                e.stopPropagation();
                createFloatingTerminal(agentId);
              }}
            >
              <SquareTerminal size={13} />
            </button>
          </Tip>

          <Tip label="Split right">
            <button
              className="no-drag focus-ring flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground @max-xl:hidden"
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
              className="no-drag focus-ring flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground @max-xl:hidden"
              onClick={(e) => {
                e.stopPropagation();
                focusAgent(agentId);
                splitActive("column");
              }}
            >
              <Rows2 size={13} />
            </button>
          </Tip>

          <Tip label={focused ? "Exit focus" : "Focus"}>
            <button
              className="no-drag focus-ring flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground @max-md:hidden"
              onClick={(e) => {
                e.stopPropagation();
                setFocusedAgent(focused ? null : agentId);
              }}
            >
              {focused ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
          </Tip>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="no-drag focus-ring flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground">
                <MoreVertical size={13} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <div className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
                {shortPath(agent.cwd)}
                {agent.git && (
                  <div className="mt-1 flex items-center gap-1 text-faint">
                    <GitBranch size={10} className="shrink-0" />
                    <span className="truncate">
                      {agent.git.repo} · {agent.git.branch}
                    </span>
                  </div>
                )}
                {agent.worktree && (
                  <div className="mt-1 flex items-center gap-1 text-faint">
                    <FolderGit2 size={10} className="shrink-0" />
                    <span className="truncate">
                      worktree of {folderName(agent.worktree.root)}
                    </span>
                  </div>
                )}
              </div>
              <DropdownMenuSeparator />
              {agent.git?.remote_url && (
                <DropdownMenuItem
                  onSelect={() => void openUrl(agent.git!.remote_url!)}
                >
                  <ExternalLink /> Open repo in browser
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setFocusedAgent(focused ? null : agentId)}
              >
                {focused ? <Minimize2 /> : <Maximize2 />}{" "}
                {focused ? "Exit focus" : "Focus"}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => splitActive("row")}>
                <Columns2 /> Split right
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => splitActive("column")}>
                <Rows2 /> Split down
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => createFloatingTerminal(agentId)}>
                <SquareTerminal /> Floating terminal
              </DropdownMenuItem>
              {agent.worktree && (
                <DropdownMenuItem onSelect={() => requestRemoveAgent(agentId)}>
                  <CheckCircle2 /> Finish worktree
                </DropdownMenuItem>
              )}
              {/* narrow panes hide the header stats button — keep the
                  numbers reachable from here, as documented */}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <BarChart3 /> Stats
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-72">
                  <AgentStatsBody agent={agent} />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem danger onSelect={() => requestRemoveAgent(agentId)}>
                <X /> Close agent
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Tip label="Close">
            <button
              className="no-drag focus-ring flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-destructive/15 hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                requestRemoveAgent(agentId);
              }}
            >
              <X size={13} />
            </button>
          </Tip>
        </div>
      </div>

      {usage?.subagents && usage.subagents.length > 0 && (
        <SubagentStrip subagents={usage.subagents} />
      )}

      {/* terminal — also an OS-file drop zone (see lib/dnd.ts) */}
      <div className="relative min-h-0 flex-1" data-file-drop={agentId}>
        <TerminalView
          agentId={agentId}
          cwd={agent.cwd}
          startup={agent.startup}
          active={active}
        />
        <FileDropOverlay targetId={agentId} />
        <DictationOverlay targetId={agentId} />
      </div>
    </div>
  );
});
