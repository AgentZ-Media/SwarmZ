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
import type { ModelUsage, UsageHistoryEntry } from "@/types";

function aggregate(sources: UsageHistoryEntry[]) {
  const models = new Map<string, ModelUsage>();
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
    reasoning,
    messages,
    sessions,
    byModel,
  };
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

/**
 * All-time Codex usage of sessions launched inside SwarmZ (persisted history;
 * entries from the pre-rebuild Claude/shell era are filtered out of view).
 */
export function UsageDashboard() {
  const open = useSwarm((s) => s.dashboardOpen);
  const setOpen = useSwarm((s) => s.setDashboardOpen);
  const usageHistory = useSwarm((s) => s.usageHistory);
  const clearUsageHistory = useSwarm((s) => s.clearUsageHistory);
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes the drawer; capture + stopPropagation so window-level
  // handlers don't react to the same press
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

  const historyEntries = useMemo(
    () =>
      Object.values(usageHistory)
        // entries without a runtime predate the rebuild (Claude parser) — hide them
        .filter((e) => (e.runtime ?? "claude") === "codex")
        .sort((a, b) => b.last_updated - a.last_updated),
    [usageHistory],
  );
  const agg = useMemo(() => aggregate(historyEntries), [historyEntries]);

  if (!open) return null;

  const maxModelCost = Math.max(1, ...agg.byModel.map((m) => m.cost_usd), 1);

  return (
    <>
      <div
        className="animate-zoverlay fixed inset-0 z-30 bg-[rgba(5,5,8,0.55)] backdrop-blur-[2px]"
        onClick={() => setOpen(false)}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-label="Usage"
        tabIndex={-1}
        className="animate-ztoast fixed right-0 top-0 z-40 flex h-full w-[420px] flex-col border-l border-line2 bg-panel shadow-modal outline-none"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <h2 className="text-14 font-semibold tracking-[-0.01em]">Usage</h2>
            <p className="text-11 text-fnt">
              All time · recorded Codex history (new entries return with the
              Phase-2 session accounting)
            </p>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="focus-ring flex h-7 w-7 items-center justify-center rounded-md text-fnt hover:bg-card hover:text-txt"
          >
            <X size={16} />
          </button>
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
                label="Reasoning"
                value={formatTokens(agg.reasoning)}
                sub="Codex output"
              />
            </div>

            {/* per-model breakdown */}
            <div>
              <div className="mb-2 font-mono text-10 font-medium uppercase tracking-[.08em] text-fnt">
                By model
              </div>
              <div className="space-y-2">
                {agg.byModel.length === 0 && (
                  <p className="text-12 text-fnt">No activity yet.</p>
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
                      className="rounded-lg border border-line bg-card p-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5 text-12 font-medium text-txt">
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: accent }}
                          />
                          <span className="truncate" title={m.model}>
                            {prettyModel(m.model)}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-12 tabular-nums text-txt">
                          {formatUsd(m.cost_usd)}
                        </span>
                      </div>
                      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-pop">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${(m.cost_usd / maxModelCost) * 100}%`,
                            backgroundColor: accent,
                          }}
                        />
                      </div>
                      <div className="mt-1.5 flex justify-between font-mono text-10 tabular-nums text-fnt">
                        <span>{formatTokens(tokens)} tokens</span>
                        <span>{formatTokens(m.message_count)} msgs</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <HistoryList entries={historyEntries} onClear={clearUsageHistory} />
          </div>
        </ScrollArea>
      </div>
    </>
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
        <span className="font-mono text-10 font-medium uppercase tracking-[.08em] text-fnt">
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
              "focus-ring flex items-center gap-1 rounded-md px-1.5 py-0.5 text-10 transition-colors",
              armed
                ? "bg-err/15 text-err"
                : "text-fnt hover:bg-card hover:text-txt",
            )}
            title={
              armed ? "Click again to reset" : "Reset all-time usage statistics"
            }
          >
            <Trash2 size={11} /> {armed ? "Reset all-time stats?" : "Reset"}
          </button>
        )}
      </div>
      <div className="space-y-1.5">
        {entries.length === 0 && (
          <p className="text-12 text-fnt">No recorded sessions yet.</p>
        )}
        {recent.map((e) => {
          const tok =
            e.input_tokens +
            e.output_tokens +
            e.cache_creation_tokens +
            e.cache_read_tokens;
          return (
            <div
              key={`${e.runtime ?? "codex"}:${e.session_id}`}
              className="flex items-center gap-2 rounded-md border border-line bg-card px-2.5 py-1.5"
            >
              <History size={11} className="shrink-0 text-fnt" />
              <span className="flex-1 truncate text-12" title={e.cwd ?? undefined}>
                {e.agent_name}
              </span>
              <span className="shrink-0 whitespace-nowrap font-mono text-10 tabular-nums text-fnt">
                {formatDay(e.last_updated)}
              </span>
              <span className="shrink-0 whitespace-nowrap font-mono text-10 tabular-nums text-mut">
                {formatTokens(tok)}
              </span>
              <span className="min-w-12 shrink-0 whitespace-nowrap text-right font-mono text-10 tabular-nums text-txt">
                {e.cost_usd > 0 ? formatUsd(e.cost_usd) : "—"}
              </span>
            </div>
          );
        })}
        {entries.length > recent.length && (
          <p className="pt-1 text-center text-10 text-fnt">
            + {entries.length - recent.length} older session
            {entries.length - recent.length === 1 ? "" : "s"}
          </p>
        )}
      </div>
    </div>
  );
}
