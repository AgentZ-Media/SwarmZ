import { useEffect, useRef, useState } from "react";
import { History } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useSwarm } from "@/store";
import { useLimits } from "@/lib/limits";
import { useFleetEvents, type FleetEvent } from "@/lib/events";
import { triageEntries, type TriageEntry } from "@/lib/triage";
import { useOrchestrator } from "@/lib/orchestrator/chat-store";
import { focusTerm } from "@/lib/term-host";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tip } from "./ui/tooltip";
import { cn } from "@/lib/utils";
import type { RateLimitWindow } from "@/types";

/**
 * The Deck — the permanent, slim status bar under the workspace grid (see
 * DESIGN.md "Layout conventions": title bar = place/navigation, deck =
 * system status). Left → right: triage queue (⚑ N need you), fleet event
 * ticker, subscription meters (Claude OAuth + account-level Codex), and the
 * orchestrator status dot. Sits below the grid only — the orchestrator
 * panel stays a full-height sibling to the right (App.tsx).
 */
export function Deck() {
  return (
    <div className="flex h-[30px] shrink-0 items-center gap-3 border-t border-border bg-background px-3 font-mono text-[10px] tabular-nums">
      <TriageChip />
      <EventTicker />
      <Meters />
      <OrchestratorDot />
    </div>
  );
}

/** Jump to a pane like the palette does (workspace switch + terminal focus). */
function jumpToPane(id: string) {
  const s = useSwarm.getState();
  if (!s.agents[id]) return;
  s.setFleetOpen(false);
  s.focusAgent(id);
  focusTerm(id);
}

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins <= 0) return "just now";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// ---- 1. Triage queue ----

/** Every needs-you pane app-wide, oldest waiting first (unknown ages last).
 * Ordering lives in lib/triage.ts — shared with the fleet overview's
 * needs-you-first initial selection and Tab cycle. */
function useTriageEntries(): TriageEntry[] {
  return useSwarm(useShallow((s) => triageEntries(s)));
}

function TriageChip() {
  const entries = useTriageEntries();
  const workspaces = useSwarm((s) => s.workspaces);
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // ages tick while the popover is open (30s granularity is plenty)
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [open]);

  // N = 0 → nothing at all, not a zero (the quiet state is silence)
  if (entries.length === 0) return null;

  const rove = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = Array.from(
      contentRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-triage-row]",
      ) ?? [],
    );
    if (rows.length === 0) return;
    const idx = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "ArrowDown"
        ? Math.min(rows.length - 1, idx + 1)
        : Math.max(0, idx - 1);
    rows[idx === -1 ? 0 : next]?.focus();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 font-semibold text-attn hover:bg-attn/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          title={`${entries.length} pane${entries.length > 1 ? "s" : ""} need${entries.length > 1 ? "" : "s"} your input`}
        >
          <span aria-hidden>⚑</span>
          {entries.length} need{entries.length > 1 ? "" : "s"} you
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        side="top"
        className="w-72"
        onKeyDown={rove}
        onOpenAutoFocus={(e) => {
          // land on the first (oldest-waiting) row, not the container
          e.preventDefault();
          contentRef.current
            ?.querySelector<HTMLButtonElement>("[data-triage-row]")
            ?.focus();
        }}
      >
        <div className="flex flex-col">
          {entries.map((entry) => (
            <button
              key={entry.id}
              data-triage-row
              onClick={() => {
                setOpen(false);
                jumpToPane(entry.id);
              }}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            >
              <span aria-hidden className="shrink-0 font-mono text-[10px] font-semibold text-attn">
                ⚑
              </span>
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                {entry.name}
              </span>
              <span className="max-w-24 shrink-0 truncate font-mono text-[10px] text-faint">
                {workspaces[entry.workspaceId]?.name ?? ""}
              </span>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                {entry.since ? formatAge(Date.now() - entry.since) : "—"}
              </span>
            </button>
          ))}
        </div>
        <div className="mt-1 flex items-center justify-between border-t border-border px-2 pb-0.5 pt-1.5 text-[10px] text-faint">
          <span>↑↓ navigate · ↵ jump</span>
          <span className="flex items-center gap-1">
            next
            <kbd className="rounded border border-border bg-secondary px-1 py-px font-mono text-[9px] text-muted-foreground">
              ⌘⇧A
            </kbd>
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---- 2. Event ticker ----

const EVENT_STYLE: Record<
  FleetEvent["kind"],
  { glyph: string; cls: string }
> = {
  finished: { glyph: "✓", cls: "text-success" },
  waiting: { glyph: "⚑", cls: "text-attn" },
  orch_prompt: { glyph: "▸", cls: "text-muted-foreground" },
  created: { glyph: "+", cls: "text-faint" },
  exited: { glyph: "×", cls: "text-faint" },
};

function eventLabel(e: FleetEvent): string {
  switch (e.kind) {
    case "finished":
      return `${e.paneName} finished`;
    case "waiting":
      return `${e.paneName} waiting`;
    case "orch_prompt":
      return `orch → ${e.paneName}`;
    case "created":
      return `${e.paneName} created`;
    case "exited":
      return `${e.paneName} exited`;
  }
}

function EventChip({ event }: { event: FleetEvent }) {
  const live = useSwarm((s) => !!s.agents[event.paneId]);
  const style = EVENT_STYLE[event.kind];
  return (
    <button
      onClick={() => jumpToPane(event.paneId)}
      disabled={!live}
      title={live ? "Jump to pane" : "Pane closed"}
      className={cn(
        "focus-ring flex min-w-0 shrink items-center gap-1 rounded px-1 py-0.5",
        live ? "hover:bg-accent" : "cursor-default",
      )}
    >
      <span className="shrink-0 text-faint">{hhmm(event.at)}</span>
      <span aria-hidden className={cn("shrink-0", style.cls)}>
        {style.glyph}
      </span>
      <span className={cn("min-w-0 truncate", style.cls)}>
        {eventLabel(event)}
      </span>
    </button>
  );
}

/** Last ~3 events inline (newest last) + a history popover (last ~30). */
function EventTicker() {
  const events = useFleetEvents((s) => s.events);
  const inline = events.slice(-3);
  const history = events.slice(-30).reverse();

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
      {inline.map((e) => (
        <EventChip key={e.id} event={e} />
      ))}
      {events.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <button
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              title="Event history"
            >
              <History size={11} />
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" className="max-h-80 w-80 overflow-y-auto">
            <div className="flex flex-col">
              {history.map((e) => (
                <EventChip key={e.id} event={e} />
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

// ---- 3. Meters (moved out of the title bar) ----

function limitColor(pct: number) {
  return pct >= 85
    ? "var(--destructive)"
    : pct >= 65
      ? "var(--warning)"
      : "var(--success)";
}

function formatReset(iso: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const withinDay = d.getTime() - Date.now() < 24 * 60 * 60 * 1000;
  if (withinDay) return time;
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  return `${day} ${time}`;
}

function LimitMeter({
  label,
  tip,
  win,
}: {
  label: string;
  tip: string;
  win: RateLimitWindow;
}) {
  const pct = Math.min(Math.max(win.utilization ?? 0, 0), 100);
  const reset = formatReset(win.resets_at);
  return (
    <Tip
      label={
        <span className="font-mono text-[11px]">
          {tip} · {Math.round(pct)}% used
          {reset ? ` · resets ${reset}` : ""}
        </span>
      }
    >
      {/* focusable (tabIndex) so the full-word tooltip has a keyboard path —
          Radix tooltips open on focus */}
      <span tabIndex={0} className="focus-ring flex items-center gap-1.5 rounded">
        <span className="text-[10px] font-medium uppercase tracking-wider text-faint">
          {label}
        </span>
        <span className="h-1 w-10 overflow-hidden rounded-full bg-secondary">
          <span
            className="block h-full rounded-full transition-[width] duration-200"
            style={{ width: `${pct}%`, backgroundColor: limitColor(pct) }}
          />
        </span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {Math.round(pct)}%
        </span>
      </span>
    </Tip>
  );
}

/** Data older than this gets an "as of HH:MM" annotation in the tooltip. */
const CODEX_STALE_MS = 60 * 60_000;

/**
 * Claude subscription meters (OAuth usage endpoint; null = no login → hidden)
 * plus the account-level Codex meters. Codex is never silently absent: with
 * no data on disk yet it shows a quiet `CX —` placeholder instead.
 */
function Meters() {
  const limits = useLimits((s) => s.limits);
  const codex = useLimits((s) => s.codex);

  // tooltips spell the terse labels out in full words ("cl 5h" → "Claude ·
  // 5-hour window …") — the label stays compact, the meaning has a hover +
  // keyboard path
  const meters: { label: string; tip: string; win: RateLimitWindow }[] = [];
  if (limits?.five_hour)
    meters.push({ label: "cl 5h", tip: "Claude · 5-hour window", win: limits.five_hour });
  if (limits?.seven_day)
    meters.push({ label: "cl wk", tip: "Claude · weekly window", win: limits.seven_day });
  if (limits?.seven_day_sonnet?.utilization)
    meters.push({
      label: "son",
      tip: "Claude · weekly Sonnet window",
      win: limits.seven_day_sonnet,
    });
  if (limits?.seven_day_opus?.utilization)
    meters.push({
      label: "opus",
      tip: "Claude · weekly Opus window",
      win: limits.seven_day_opus,
    });

  const cx = codex?.limits ?? null;
  const asOf = codex?.as_of_ms ?? null;
  // stale account data is still shown, but dated — never presented as live
  const stale =
    asOf !== null && Date.now() - asOf > CODEX_STALE_MS
      ? ` · as of ${hhmm(asOf)}`
      : "";
  if (cx?.primary)
    meters.push({
      label: "cx 5h",
      tip: `Codex${cx.plan_type ? ` ${cx.plan_type}` : ""} · 5-hour window${stale}`,
      win: cx.primary,
    });
  if (cx?.secondary)
    meters.push({
      label: "cx wk",
      tip: `Codex${cx.plan_type ? ` ${cx.plan_type}` : ""} · weekly window${stale}`,
      win: cx.secondary,
    });

  return (
    <div className="flex shrink-0 items-center gap-3">
      {meters.map((m, i) => (
        <span key={m.label} className="flex items-center gap-3">
          {i > 0 && <span className="h-3.5 w-px bg-border" />}
          <LimitMeter label={m.label} tip={m.tip} win={m.win} />
        </span>
      ))}
      {!cx && (
        <Tip
          label={
            <span className="font-mono text-[11px]">
              Codex · no usage data yet — updates with Codex activity
              {asOf !== null ? ` · last seen ${hhmm(asOf)}` : ""}
            </span>
          }
        >
          <span tabIndex={0} className="focus-ring flex items-center gap-1.5 rounded">
            {meters.length > 0 && <span className="h-3.5 w-px bg-border" />}
            <span className="text-[10px] font-medium uppercase tracking-wider text-faint">
              cx
            </span>
            <span className="text-faint">—</span>
          </span>
        </Tip>
      )}
    </div>
  );
}

// ---- 4. Orchestrator status dot ----

/**
 * `orch` + dot: `--attn` when a chat has undelivered pings (a chat needs
 * attention), `--ring` while a turn runs, faint otherwise. Click toggles the
 * orchestrator panel (⌘⇧O).
 */
function OrchestratorDot() {
  const running = useOrchestrator((s) =>
    Object.values(s.busy).some(Boolean),
  );
  const needsAttention = useOrchestrator((s) =>
    s.chats.some((c) => c.pendingPings.some((p) => !p.delivered)),
  );
  const panelOpen = useOrchestrator((s) => s.panelOpen);
  const togglePanel = useOrchestrator((s) => s.togglePanel);

  const color = needsAttention
    ? "var(--attn)"
    : running
      ? "var(--ring)"
      : "var(--faint)";
  const label = needsAttention
    ? "Orchestrator — a chat needs attention"
    : running
      ? "Orchestrator — running"
      : "Orchestrator — idle";

  return (
    <Tip label={`${label} (⌘⇧O)`}>
      <button
        onClick={togglePanel}
        className={cn(
          "flex h-5 shrink-0 items-center gap-1.5 rounded-md px-1.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          panelOpen ? "text-foreground" : "text-faint",
        )}
      >
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: color }}
        />
        orch
      </button>
    </Tip>
  );
}
