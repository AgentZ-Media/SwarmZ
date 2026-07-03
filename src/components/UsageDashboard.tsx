import { useEffect, useMemo, useRef, useState } from "react";
import { History, Trash2, X } from "lucide-react";
import { useSwarm } from "@/store";
import { ScrollArea, Stat } from "./ui/misc";
import {
  cn,
  formatTokens,
  formatUsd,
  modelAccent,
  prettyModel,
} from "@/lib/utils";
import type { AgentRuntime, ModelUsage, UsageHistoryEntry } from "@/types";

type Scope = "session" | "alltime";

interface UsageSource {
  runtime?: AgentRuntime;
  message_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  reasoning_output_tokens?: number;
  cost_usd: number;
  by_model: ModelUsage[];
}

function aggregate(sources: UsageSource[]) {
  const models = new Map<string, ModelUsage>();
  const runtimes = new Map<AgentRuntime, number>();
  let cost = 0,
    input = 0,
    output = 0,
    cacheWrite = 0,
    cacheRead = 0,
    reasoning = 0,
    messages = 0,
    sessions = 0;
  for (const u of sources) {
    if (u.message_count === 0) continue;
    sessions += 1;
    cost += u.cost_usd;
    input += u.input_tokens;
    output += u.output_tokens;
    cacheWrite += u.cache_creation_tokens;
    cacheRead += u.cache_read_tokens;
    reasoning += u.reasoning_output_tokens ?? 0;
    messages += u.message_count;
    const runtime = u.runtime ?? "claude";
    runtimes.set(runtime, (runtimes.get(runtime) ?? 0) + 1);
    for (const bm of u.by_model) {
      const e =
        models.get(bm.model) ??
        ({
          model: bm.model,
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
          reasoning_output_tokens: 0,
          message_count: 0,
          cost_usd: 0,
        } as ModelUsage);
      e.input_tokens += bm.input_tokens;
      e.output_tokens += bm.output_tokens;
      e.cache_creation_tokens += bm.cache_creation_tokens;
      e.cache_read_tokens += bm.cache_read_tokens;
      e.reasoning_output_tokens =
        (e.reasoning_output_tokens ?? 0) + (bm.reasoning_output_tokens ?? 0);
      e.message_count += bm.message_count;
      e.cost_usd += bm.cost_usd;
      models.set(bm.model, e);
    }
  }
  const byModel = [...models.values()]
    .filter(
      (m) =>
        m.input_tokens +
          m.output_tokens +
          m.cache_creation_tokens +
          m.cache_read_tokens >
        0,
    )
    .sort((a, b) => b.cost_usd - a.cost_usd);
  return {
    cost,
    tokens: input + output + cacheWrite + cacheRead,
    output,
    cacheRead,
    reasoning,
    messages,
    sessions,
    byModel,
    byRuntime: [...runtimes.entries()].sort((a, b) => b[1] - a[1]),
  };
}

function runtimeLabel(runtime: AgentRuntime): string {
  if (runtime === "codex") return "Codex";
  if (runtime === "claude") return "Claude";
  return "Shell";
}

function formatDay(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, today)) {
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function UsageDashboard() {
  const open = useSwarm((s) => s.dashboardOpen);
  const setOpen = useSwarm((s) => s.setDashboardOpen);
  const agents = useSwarm((s) => s.agents);
  const order = useSwarm((s) => s.order);
  const usageHistory = useSwarm((s) => s.usageHistory);
  const clearUsageHistory = useSwarm((s) => s.clearUsageHistory);
  const [scope, setScope] = useState<Scope>("session");
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes the drawer; capture + stopPropagation so window-level
  // handlers (fleet exit in WorkspaceLayer) don't react to the same press
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // a real dialog stacked above the drawer (Settings via the title bar)
      // owns Escape — don't steal it and close the drawer underneath
      if (document.querySelector('[role="dialog"]:not([aria-label="Usage"])'))
        return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen]);

  // "session": ONLY what was produced inside SwarmZ since this app start —
  // the sum of each open agent's own session usage.
  const sessionAgg = useMemo(
    () =>
      aggregate(
        order
          .map((id) => agents[id]?.usage)
          .filter((u): u is NonNullable<typeof u> => !!u),
      ),
    [agents, order],
  );

  // "alltime": everything ever launched inside SwarmZ, persisted across app
  // restarts. Live sessions are mirrored into the history as they run, so the
  // current session is already included.
  const historyEntries = useMemo(
    () =>
      Object.values(usageHistory).sort(
        (a, b) => b.last_updated - a.last_updated,
      ),
    [usageHistory],
  );
  const alltimeAgg = useMemo(
    () => aggregate(historyEntries),
    [historyEntries],
  );

  if (!open) return null;

  const agg = scope === "session" ? sessionAgg : alltimeAgg;
  const maxModelCost = Math.max(1, ...agg.byModel.map((m) => m.cost_usd), 1);

  return (
    <>
      <div
        className="fixed inset-0 z-30 bg-black/40"
        onClick={() => setOpen(false)}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-label="Usage"
        tabIndex={-1}
        className="animate-slide-in-right fixed right-0 top-0 z-40 flex h-full w-[420px] flex-col border-l border-border bg-background shadow-[-24px_0_48px_-24px_rgba(0,0,0,0.6)] outline-none"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">Usage</h2>
            <p className="text-[11px] text-faint">
              {scope === "session"
                ? "This SwarmZ session · agents launched here"
                : "All time · everything launched in SwarmZ"}
            </p>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        {/* scope toggle */}
        <div className="flex gap-1 border-b border-border px-4 py-2">
          {(
            [
              ["session", "Session"],
              ["alltime", "All time"],
            ] as [Scope, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setScope(key)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                scope === key
                  ? "bg-accent text-foreground"
                  : "text-faint hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <ScrollArea className="flex-1">
          <div className="space-y-6 p-4">
            <div className="grid grid-cols-2 gap-2.5">
              <Stat
                label="Tracked cost"
                value={formatUsd(agg.cost)}
                sub={`${agg.sessions} session${agg.sessions === 1 ? "" : "s"}`}
              />
              <Stat
                label="Tokens"
                value={formatTokens(agg.tokens)}
                sub={`${formatTokens(agg.messages)} messages`}
              />
              <Stat
                label="Output"
                value={formatTokens(agg.output)}
                accent="var(--chart-2)"
              />
              <Stat
                label={agg.reasoning > 0 ? "Reasoning" : "Cache read"}
                value={formatTokens(agg.reasoning > 0 ? agg.reasoning : agg.cacheRead)}
                sub={agg.reasoning > 0 ? "Codex output" : "Claude cache"}
              />
            </div>

            {agg.byRuntime.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {agg.byRuntime.map(([runtime, count]) => (
                  <span
                    key={runtime}
                    className="rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground"
                  >
                    {runtimeLabel(runtime)} · {count}
                  </span>
                ))}
              </div>
            )}

            {/* per-model breakdown */}
            <div>
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-faint">
                By model
              </div>
              <div className="space-y-2">
                {agg.byModel.length === 0 && (
                  <p className="text-xs text-faint">No activity yet.</p>
                )}
                {agg.byModel.map((m) => {
                  const accent = modelAccent(m.model);
                  const tokens =
                    m.input_tokens +
                    m.output_tokens +
                    m.cache_creation_tokens +
                    m.cache_read_tokens;
                  return (
                    <div
                      key={m.model}
                      className="rounded-lg border border-border bg-card p-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: accent }}
                          />
                          <span className="truncate" title={m.model}>
                            {prettyModel(m.model)}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-xs tabular-nums text-foreground">
                          {formatUsd(m.cost_usd)}
                        </span>
                      </div>
                      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-secondary">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${(m.cost_usd / maxModelCost) * 100}%`,
                            backgroundColor: accent,
                          }}
                        />
                      </div>
                      <div className="mt-1.5 flex justify-between font-mono text-[10px] text-faint">
                        <span>{formatTokens(tokens)} tokens</span>
                        <span>{formatTokens(m.message_count)} msgs</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {scope === "session" ? (
              <SessionAgentList />
            ) : (
              <HistoryList
                entries={historyEntries}
                onClear={clearUsageHistory}
              />
            )}
          </div>
        </ScrollArea>
      </div>
    </>
  );
}

function SessionAgentList() {
  const agents = useSwarm((s) => s.agents);
  const order = useSwarm((s) => s.order);
  return (
    <div>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-faint">
        Open agents
      </div>
      <div className="space-y-1.5">
        {order.length === 0 && (
          <p className="text-xs text-faint">No agents running.</p>
        )}
        {order.map((id) => {
          const a = agents[id];
          if (!a) return null;
          const u = a.usage;
          const tok = u
            ? u.input_tokens +
              u.output_tokens +
              u.cache_creation_tokens +
              u.cache_read_tokens
            : 0;
          return (
            <div
              key={id}
              className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5"
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: a.color }}
              />
              <span className="flex-1 truncate text-xs">{a.name}</span>
              <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-faint">
                {runtimeLabel(a.runtime ?? "claude")}
              </span>
              <span className="shrink-0 whitespace-nowrap font-mono text-[10px] tabular-nums text-muted-foreground">
                {formatTokens(tok)}
              </span>
              <span className="min-w-12 shrink-0 whitespace-nowrap text-right font-mono text-[10px] tabular-nums text-foreground">
                {u && u.cost_usd > 0 ? formatUsd(u.cost_usd) : "—"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HistoryList({
  entries,
  onClear,
}: {
  entries: UsageHistoryEntry[];
  onClear: () => void;
}) {
  const recent = entries.slice(0, 30);
  // resetting needs a second click on the armed button (window.confirm is a
  // no-op in WKWebView); auto-disarms after a moment or on pointer-leave
  const [armed, setArmed] = useState(false);
  const disarmTimer = useRef<number | undefined>(undefined);
  const disarm = () => {
    window.clearTimeout(disarmTimer.current);
    setArmed(false);
  };
  useEffect(() => () => window.clearTimeout(disarmTimer.current), []);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-faint">
          Recent sessions
        </span>
        {entries.length > 0 && (
          <button
            onClick={() => {
              if (!armed) {
                setArmed(true);
                window.clearTimeout(disarmTimer.current);
                disarmTimer.current = window.setTimeout(
                  () => setArmed(false),
                  4000,
                );
                return;
              }
              disarm();
              onClear();
            }}
            onPointerLeave={disarm}
            className={cn(
              "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] transition-colors",
              armed
                ? "bg-destructive/15 text-destructive"
                : "text-faint hover:bg-accent hover:text-foreground",
            )}
            title={
              armed
                ? "Click again to reset"
                : "Reset all-time usage statistics"
            }
          >
            <Trash2 size={11} /> {armed ? "Reset all-time stats?" : "Reset"}
          </button>
        )}
      </div>
      <div className="space-y-1.5">
        {entries.length === 0 && (
          <p className="text-xs text-faint">No recorded sessions yet.</p>
        )}
        {recent.map((e) => {
          const tok =
            e.input_tokens +
            e.output_tokens +
            e.cache_creation_tokens +
            e.cache_read_tokens;
          return (
            <div
              key={`${e.runtime ?? "claude"}:${e.session_id}`}
              className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5"
            >
              <History size={11} className="shrink-0 text-faint" />
              <span className="flex-1 truncate text-xs" title={e.cwd ?? undefined}>
                {e.agent_name}
              </span>
              <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-faint">
                {runtimeLabel(e.runtime ?? "claude")}
              </span>
              <span className="shrink-0 whitespace-nowrap font-mono text-[10px] tabular-nums text-faint">
                {formatDay(e.last_updated)}
              </span>
              <span className="shrink-0 whitespace-nowrap font-mono text-[10px] tabular-nums text-muted-foreground">
                {formatTokens(tok)}
              </span>
              <span className="min-w-12 shrink-0 whitespace-nowrap text-right font-mono text-[10px] tabular-nums text-foreground">
                {e.cost_usd > 0 ? formatUsd(e.cost_usd) : "—"}
              </span>
            </div>
          );
        })}
        {entries.length > recent.length && (
          <p className="pt-1 text-center text-[10px] text-faint">
            + {entries.length - recent.length} older session
            {entries.length - recent.length === 1 ? "" : "s"}
          </p>
        )}
      </div>
    </div>
  );
}
