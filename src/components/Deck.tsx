import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { History } from "lucide-react";
import { useLimits } from "@/lib/limits";
import { useFleetEvents, type FleetEvent } from "@/lib/events";
import { useVibe } from "@/lib/vibe/session-store";
import { vibeTriageEntries } from "@/lib/vibe/triage";
import { focusSession } from "@/lib/vibe/controller";
import { useVibeUi } from "@/lib/vibe/ui-store";
import { useOrchestrator } from "@/lib/orchestrator/chat-store";
import {
  autonomyTripped,
  subscribeAutonomy,
} from "@/lib/orchestrator/autonomy";
import { useProjects } from "@/lib/projects/store";
import { useSwarm } from "@/store";
import { useGithub } from "@/lib/github/store";
import { deckPrSignature } from "@/lib/github/core";
import { openUrl } from "@/lib/transport";
import { decayedSignal } from "@/lib/vibe/ui";
import { hasHumanAttention } from "@/lib/vibe/attention";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tip } from "./ui/tooltip";
import { cn } from "@/lib/utils";
import type { RateLimitWindow } from "@/types";

/**
 * The Deck v2 — the permanent 32 px status bar (DESIGN.md "Layout
 * conventions": title bar = place/navigation, deck = system status). Left →
 * right: PROJECT-SPANNING fleet counters (▸ working · ⚑ needs-you triage
 * popover · ✓ finished · idle), the fleet event ticker, the equalizer
 * (alive while anything works), the Conductor dot, the Codex subscription
 * meters and the clock. All `text-11 font-mono` — the deck never grows.
 */
export function Deck() {
  return (
    <div className="flex h-8 shrink-0 items-center gap-4 border-t border-line bg-panel px-4 font-mono text-11 tabular-nums">
      <FleetCounts />
      <EventTicker />
      <Equalizer />
      <OrchestratorDot />
      <PrIndicator />
      <Meters />
      <Clock />
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

// ---- 1. Fleet counters (global, across ALL projects) ----

/** Primitive status signature over every session app-wide (pure store data —
 * the time-decayed "finished" bucket derives in useMemo + a 30 s tick). */
function useGlobalCounts() {
  const sig = useVibe((s) => {
    const parts: string[] = [];
    for (const id of s.order) {
      const e = s.sessions[id];
      if (!e) continue;
      parts.push(
        `${s.busy[id] ? 1 : 0}:${hasHumanAttention(e) ? 1 : 0}:${e.lastBusyEndAt ?? ""}`,
      );
    }
    return parts.join("|");
  });
  // the tick VALUE is a memo dep — a bare force-render would leave the memo
  // cached on `sig` and the "finished" bucket would never decay
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  return useMemo(() => {
    const now = Date.now();
    const c = { working: 0, needs: 0, finished: 0, idle: 0 };
    if (sig)
      for (const part of sig.split("|")) {
        const [busy, needs, endAt] = part.split(":");
        const signal = decayedSignal(
          busy === "1",
          needs === "1",
          endAt ? Number(endAt) : null,
          now,
        );
        if (signal === "needsYou") c.needs++;
        else if (signal === "working") c.working++;
        else if (signal === "finished") c.finished++;
        else c.idle++;
      }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, tick]);
}

function FleetCounts() {
  const c = useGlobalCounts();
  return (
    <span className="flex shrink-0 items-center gap-2.5">
      <Tip label="Workers running (all projects)">
        <span
          tabIndex={0}
          className={cn(
            "focus-ring flex items-center gap-1 rounded-xs",
            c.working > 0 ? "text-acc/80" : "text-fnt",
          )}
        >
          <span aria-hidden>▸</span>
          {c.working}
        </span>
      </Tip>
      <TriageChip needsCount={c.needs} />
      <Tip label="Finished in the last 5 minutes">
        <span
          tabIndex={0}
          className={cn(
            "focus-ring flex items-center gap-1 rounded-xs",
            c.finished > 0 ? "text-ok" : "text-fnt",
          )}
        >
          <span aria-hidden>✓</span>
          {c.finished}
        </span>
      </Tip>
      <Tip label="Idle workers">
        <span
          tabIndex={0}
          className="focus-ring flex items-center gap-1 rounded-xs text-fnt"
        >
          <span aria-hidden>·</span>
          {c.idle}
        </span>
      </Tip>
    </span>
  );
}

// ---- 2. Triage queue (the ⚑ counter opens the needs-you popover) ----

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

function TriageChip({ needsCount }: { needsCount: number }) {
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

  // quiet zero state: the counter stays visible (the counts row reads as a
  // unit) but faint and inert
  if (entries.length === 0) {
    return (
      <Tip label="No worker needs your input">
        <span
          tabIndex={0}
          className="focus-ring flex items-center gap-1 rounded-xs text-fnt"
        >
          <span aria-hidden>⚑</span>
          {needsCount}
        </span>
      </Tip>
    );
  }

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
          className="focus-ring flex h-5 shrink-0 items-center gap-1 rounded-xs font-semibold text-attn hover:bg-attn/10"
          title={`${entries.length} worker${entries.length > 1 ? "s" : ""} need${entries.length > 1 ? "" : "s"} your input`}
        >
          <span aria-hidden className="animate-zattn">
            ⚑
          </span>
          {entries.length}
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
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-line focus-visible:bg-line focus-visible:outline-none"
            >
              <span
                aria-hidden
                className="shrink-0 font-mono text-10 font-semibold text-attn"
              >
                ⚑
              </span>
              <span className="min-w-0 flex-1 truncate text-12 font-medium text-txt">
                {entry.name}
              </span>
              <span className="max-w-24 shrink-0 truncate font-mono text-10 text-fnt">
                {entry.place}
              </span>
              <span className="shrink-0 font-mono text-10 tabular-nums text-mut">
                {entry.since ? formatAge(Date.now() - entry.since) : "—"}
              </span>
            </button>
          ))}
        </div>
        <div className="mt-1 flex items-center justify-between border-t border-line px-2 pb-0.5 pt-1.5 text-10 text-fnt">
          <span>↑↓ navigate · ↵ jump</span>
          <span className="flex items-center gap-1">
            next
            <kbd className="rounded-xs border border-line bg-card px-1 py-px font-mono text-10 text-mut">
              ⌘⇧A
            </kbd>
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---- 3. Event ticker ----

const EVENT_STYLE: Record<
  FleetEvent["kind"],
  { glyph: string; cls: string }
> = {
  finished: { glyph: "✓", cls: "text-ok" },
  waiting: { glyph: "⚑", cls: "text-attn" },
  orch_prompt: { glyph: "▸", cls: "text-mut" },
  created: { glyph: "+", cls: "text-fnt" },
  exited: { glyph: "×", cls: "text-fnt" },
  pr: { glyph: "⇅", cls: "text-mut" },
};

function eventLabel(e: FleetEvent): string {
  switch (e.kind) {
    case "finished":
      return `${e.sessionName} finished`;
    case "waiting":
      return `${e.sessionName} needs approval`;
    case "orch_prompt":
      return `conductor → ${e.sessionName}`;
    case "created":
      return `${e.sessionName} created`;
    case "exited":
      return `${e.sessionName} turn failed`;
    case "pr":
      return e.label ?? e.sessionName;
  }
}

function EventChip({ event }: { event: FleetEvent }) {
  const live = useVibe((s) => !!s.sessions[event.sessionId]);
  // PR events carry no session — the chip opens the PR on GitHub instead
  const isPr = event.kind === "pr";
  const clickable = isPr ? !!event.url : live;
  const style = EVENT_STYLE[event.kind];
  return (
    <button
      onClick={() => {
        if (isPr) {
          if (event.url) void openUrl(event.url);
        } else {
          focusSession(event.sessionId);
        }
      }}
      disabled={!clickable}
      title={isPr ? "Open PR on GitHub" : live ? "Open worker" : "Closed"}
      className={cn(
        "focus-ring flex min-w-0 shrink items-center gap-1 rounded-xs px-1 py-0.5",
        clickable ? "hover:bg-card" : "cursor-default",
      )}
    >
      <span className="shrink-0 text-fnt">{hhmm(event.at)}</span>
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
              className="focus-ring flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-fnt hover:bg-card hover:text-txt"
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

// ---- 4. Equalizer (ambient "the fleet is alive" — accent, zeq stagger) ----

const EQ_HEIGHTS = [7, 11, 5, 9, 6];

function Equalizer() {
  const anyWorking = useVibe((s) => {
    for (const id of s.order) if (s.busy[id]) return true;
    return false;
  });
  const orchWorking = useOrchestrator((s) =>
    Object.values(s.busy).some(Boolean),
  );
  if (!anyWorking && !orchWorking) return null;
  return (
    <span aria-hidden className="flex h-3 shrink-0 items-end gap-[2.5px]">
      {EQ_HEIGHTS.map((h, i) => (
        <span
          key={i}
          className="animate-zeq w-[2.5px] origin-bottom rounded-[1px] bg-acc/65"
          style={{ height: h, animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </span>
  );
}

// ---- 5. Meters ----

function limitColor(pct: number) {
  return pct >= 85 ? "var(--err)" : pct >= 65 ? "var(--warn)" : "var(--ok)";
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
        <span className="font-mono text-11">
          {tip} · {Math.round(pct)}% used
          {reset ? ` · resets ${reset}` : ""}
        </span>
      }
    >
      {/* focusable (tabIndex) so the full-word tooltip has a keyboard path —
          Radix tooltips open on focus */}
      <span tabIndex={0} className="focus-ring flex items-center gap-1.5 rounded-xs">
        <span className="text-10 font-medium uppercase tracking-[.08em] text-fnt">
          {label}
        </span>
        <span className="h-1 w-9 overflow-hidden rounded-full bg-line">
          <span
            className="block h-full rounded-full transition-[width] duration-200"
            style={{ width: `${pct}%`, backgroundColor: limitColor(pct) }}
          />
        </span>
        <span className="font-mono text-11 tabular-nums text-mut">
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
          {i > 0 && <span className="h-3.5 w-px bg-line" />}
          <LimitMeter label={m.label} tip={m.tip} win={m.win} />
        </span>
      ))}
      {!cx && (
        <Tip
          label={
            <span className="font-mono text-11">
              Codex · no usage data yet — updates with Codex activity
              {asOf !== null ? ` · last seen ${hhmm(asOf)}` : ""}
            </span>
          }
        >
          <span tabIndex={0} className="focus-ring flex items-center gap-1.5 rounded-xs">
            <span className="text-10 font-medium uppercase tracking-[.08em] text-fnt">
              cx
            </span>
            <span className="text-fnt">—</span>
          </span>
        </Tip>
      )}
    </div>
  );
}

// ---- 6. Conductor status dot ----

/**
 * `conductor` + dot: `--err` when the ACTIVE project's autonomy circuit
 * breaker is latched (autonomous turns paused until the human writes),
 * `--attn` when a chat has undelivered pings (a chat needs attention),
 * accent while ANY project's Conductor runs a turn, faint otherwise. Click
 * shows the Conductor (same routing as ⌘⇧O).
 */
function OrchestratorDot() {
  const running = useOrchestrator((s) => Object.values(s.busy).some(Boolean));
  const needsAttention = useOrchestrator((s) =>
    s.chats.some((c) => c.pendingPings.some((p) => !p.delivered)),
  );
  const activeProjectId = useProjects((s) => s.activeProjectId);
  // the breaker state lives outside any zustand store (autonomy.ts) — a
  // primitive-boolean snapshot keeps the selector contract intact
  const tripped = useSyncExternalStore(subscribeAutonomy, () =>
    activeProjectId ? autonomyTripped(activeProjectId) : false,
  );
  const conductorOpen = useVibeUi((s) => s.conductorOpen);

  const dotCls = tripped
    ? "bg-err"
    : needsAttention
      ? "bg-attn animate-zattn"
      : running
        ? "bg-acc animate-zpulse"
        : "bg-fnt";
  const label = tripped
    ? "Orchestrator — autonomy paused (budget exhausted; send a message to resume)"
    : needsAttention
      ? "Orchestrator — a chat needs attention"
      : running
        ? "Orchestrator — running"
        : "Orchestrator — idle";

  return (
    <Tip label={`${label} (⌘⇧O)`}>
      <button
        onClick={() => useVibeUi.getState().showConductor()}
        className={cn(
          "focus-ring flex h-5 shrink-0 items-center gap-1.5 rounded-xs px-1 hover:bg-card",
          conductorOpen ? "text-mut" : "text-fnt",
        )}
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", dotCls)} />
        conductor
      </button>
    </Tip>
  );
}

// ---- 7. PR indicator (Phase 7 — only with the GitHub integration ON) ----

/**
 * Quiet per-ACTIVE-project PR chip: `⇅ N` open PRs, err-tinted with a
 * failing-check count while any PR's checks are red. Hidden when the
 * integration is off or the project has no open PRs. Click opens the GitHub
 * panel. Selector contract: only PRIMITIVES leave the selectors (the PR list
 * collapses into `deckPrSignature`'s string).
 */
function PrIndicator() {
  const enabled = useSwarm((s) => !!s.settings.githubIntegration);
  const activeProjectId = useProjects((s) => s.activeProjectId);
  const sig = useGithub((s) =>
    activeProjectId ? deckPrSignature(s.byProject[activeProjectId]?.prs) : "",
  );
  const setGithubOpen = useSwarm((s) => s.setGithubOpen);
  if (!enabled || !sig) return null;
  const [open, failing] = sig.split(":").map(Number);
  const red = failing > 0;
  return (
    <Tip
      label={
        red
          ? `${open} open PR${open === 1 ? "" : "s"} — ${failing} with failing checks`
          : `${open} open PR${open === 1 ? "" : "s"}`
      }
    >
      <button
        onClick={() => setGithubOpen(true)}
        className={cn(
          "focus-ring flex h-5 shrink-0 items-center gap-1 rounded-xs px-1 tabular-nums hover:bg-card",
          red ? "text-err" : "text-fnt",
        )}
      >
        <span aria-hidden>⇅</span>
        {open}
        {red && <span className="font-semibold">×{failing}</span>}
      </button>
    </Tip>
  );
}

// ---- 8. Clock ----

function Clock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="shrink-0 tabular-nums text-fnt" title="Local time">
      {hhmm(now)}
    </span>
  );
}
