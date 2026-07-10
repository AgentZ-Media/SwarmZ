import { useEffect, useMemo, useRef, useState } from "react";
import { History } from "lucide-react";
import { useLimits } from "@/lib/limits";
import { useFleetEvents, type FleetEvent } from "@/lib/events";
import { useVibe } from "@/lib/vibe/session-store";
import { vibeTriageEntries } from "@/lib/vibe/triage";
import { focusSession } from "@/lib/vibe/controller";
import { useVibeUi } from "@/lib/vibe/ui-store";
import { useOrchestrator } from "@/lib/orchestrator/chat-store";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tip } from "./ui/tooltip";
import { cn } from "@/lib/utils";
import type { RateLimitWindow } from "@/types";

/**
 * The Deck — the permanent, slim status bar under the session stage (see
 * DESIGN.md "Layout conventions": title bar = place/navigation, deck =
 * system status). Left → right: triage queue (⚑ N need you), fleet event
 * ticker, the Codex subscription meters, and the orchestrator status dot.
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

/** One row in the needs-you queue — a Vibe session with a pending approval. */
interface TriageRow {
  id: string;
  name: string;
  /** project folder — the faint sub-label */
  place: string;
  since: number | null;
  jump: () => void;
}

/** A stable primitive signature of a needs-you list — a store selector must
 * NOT return a fresh array of fresh objects (it never stabilizes across
 * getSnapshot calls → infinite loop). Selecting this string is stable. */
function triageSig(rows: { id: string; since: number | null }[]): string {
  return rows.map((r) => `${r.id}:${r.since ?? ""}`).join("|");
}

/**
 * Every needs-you session app-wide, oldest waiting first. The rows (fresh
 * objects + jump closures) are rebuilt in useMemo, gated on the primitive
 * signature so the store subscription stays stable.
 */
function useTriageRows(): TriageRow[] {
  const vibeSig = useVibe((s) => triageSig(vibeTriageEntries(s)));
  return useMemo(() => {
    const rows: TriageRow[] = vibeTriageEntries(useVibe.getState()).map((e) => ({
      id: e.id,
      name: e.name,
      place: e.project,
      since: e.since,
      jump: () => focusSession(e.id),
    }));
    rows.sort(
      (a, b) =>
        (a.since ?? Number.MAX_SAFE_INTEGER) -
        (b.since ?? Number.MAX_SAFE_INTEGER),
    );
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vibeSig]);
}

function TriageChip() {
  const entries = useTriageRows();
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
          title={`${entries.length} session${entries.length > 1 ? "s" : ""} need${entries.length > 1 ? "" : "s"} your input`}
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
                entry.jump();
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
                {entry.place}
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
      return `${e.sessionName} finished`;
    case "waiting":
      return `${e.sessionName} needs approval`;
    case "orch_prompt":
      return `orch → ${e.sessionName}`;
    case "created":
      return `${e.sessionName} created`;
    case "exited":
      return `${e.sessionName} turn failed`;
  }
}

function EventChip({ event }: { event: FleetEvent }) {
  const live = useVibe((s) => !!s.sessions[event.sessionId]);
  const style = EVENT_STYLE[event.kind];
  return (
    <button
      onClick={() => focusSession(event.sessionId)}
      disabled={!live}
      title={live ? "Open session" : "Closed"}
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

// ---- 3. Meters ----

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
 * The account-level Codex meters. Never silently absent: with no data on
 * disk yet a quiet `CX —` placeholder shows instead.
 */
function Meters() {
  const codex = useLimits((s) => s.codex);

  const cx = codex?.limits ?? null;
  const asOf = codex?.as_of_ms ?? null;
  // stale account data is still shown, but dated — never presented as live
  const stale =
    asOf !== null && Date.now() - asOf > CODEX_STALE_MS
      ? ` · as of ${hhmm(asOf)}`
      : "";
  const meters: { label: string; tip: string; win: RateLimitWindow }[] = [];
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
 * attention), `--ring` while a turn runs, faint otherwise. Click activates
 * the Conductor stage (same routing as ⌘⇧O).
 */
function OrchestratorDot() {
  const running = useOrchestrator((s) =>
    Object.values(s.busy).some(Boolean),
  );
  const needsAttention = useOrchestrator((s) =>
    s.chats.some((c) => c.pendingPings.some((p) => !p.delivered)),
  );
  const stageMode = useVibeUi((s) => s.stageMode);
  const active = stageMode === "conductor";

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
        onClick={() => useVibeUi.getState().setStageMode("conductor")}
        className={cn(
          "flex h-5 shrink-0 items-center gap-1.5 rounded-md px-1.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          active ? "text-foreground" : "text-faint",
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
