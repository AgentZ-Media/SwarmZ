import {
  BarChart3,
  Check,
  Download,
  Gauge,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Zap,
} from "lucide-react";
import { useSwarm } from "@/store";
import { useUpdates } from "@/lib/updates";
import { useLimits } from "@/lib/limits";
import { Button } from "./ui/button";
import { Tip } from "./ui/tooltip";
import { IS_TAURI } from "@/lib/transport";
import type { RateLimitWindow } from "@/types";

export function TitleBar({ onManageProfiles }: { onManageProfiles: () => void }) {
  const setNewAgentOpen = useSwarm((s) => s.setNewAgentOpen);
  const setDashboardOpen = useSwarm((s) => s.setDashboardOpen);
  const dashboardOpen = useSwarm((s) => s.dashboardOpen);
  const agents = useSwarm((s) => s.agents);
  const order = useSwarm((s) => s.order);

  const running = order.filter(
    (id) => agents[id]?.status === "running" || agents[id]?.status === "attention",
  ).length;

  return (
    <header
      data-tauri-drag-region
      className="drag-region flex h-11 shrink-0 items-center gap-3 border-b border-border bg-background pr-3"
      style={{ paddingLeft: IS_TAURI ? 80 : 16 }}
    >
      {/* decorative — pointer-events-none lets the drag fall through to the header */}
      <div className="pointer-events-none flex items-center gap-2.5">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary">
          <Zap size={13} className="text-primary-foreground" fill="currentColor" />
        </div>
        <span className="text-sm font-semibold tracking-tight text-foreground">
          SwarmZ
        </span>
      </div>

      {order.length > 0 && (
        <div className="pointer-events-none flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span
            className={`h-1.5 w-1.5 rounded-full ${running > 0 ? "bg-success" : "bg-faint"}`}
          />
          <span className="font-mono tabular-nums">{running}</span>
          <span className="text-faint">active</span>
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        {IS_TAURI && <UpdatePill />}

        <LimitsPill />

        <Tip label="Usage dashboard">
          <Button
            size="icon"
            variant={dashboardOpen ? "secondary" : "ghost"}
            className="no-drag"
            onClick={() => setDashboardOpen(!dashboardOpen)}
          >
            <BarChart3 size={15} />
          </Button>
        </Tip>

        <Tip label="Profiles">
          <Button
            size="icon"
            variant="ghost"
            className="no-drag"
            onClick={onManageProfiles}
          >
            <SlidersHorizontal size={15} />
          </Button>
        </Tip>

        {IS_TAURI && <UpdateCheckButton />}

        <Button
          size="sm"
          className="no-drag"
          onClick={() => setNewAgentOpen(true)}
        >
          <Plus size={14} /> New Agent
        </Button>
      </div>
    </header>
  );
}

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
          {tip}: {Math.round(pct)}% used
          {reset ? ` · resets ${reset}` : ""}
        </span>
      }
    >
      <span className="flex items-center gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-faint">
          {label}
        </span>
        <span className="h-1 w-10 overflow-hidden rounded-full bg-secondary">
          <span
            className="block h-full rounded-full"
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

/**
 * Usage limits of the Claude subscription logged in on this machine
 * (5-hour session window + weekly windows). Hidden when no login is found.
 */
function LimitsPill() {
  const limits = useLimits((s) => s.limits);
  if (!limits) return null;

  const meters: { label: string; tip: string; win: RateLimitWindow }[] = [];
  if (limits.five_hour)
    meters.push({ label: "5h", tip: "5-hour session limit", win: limits.five_hour });
  if (limits.seven_day)
    meters.push({ label: "wk", tip: "Weekly limit (all models)", win: limits.seven_day });
  if (limits.seven_day_sonnet?.utilization)
    meters.push({
      label: "son",
      tip: "Weekly Sonnet limit",
      win: limits.seven_day_sonnet,
    });
  if (limits.seven_day_opus?.utilization)
    meters.push({
      label: "opus",
      tip: "Weekly Opus limit",
      win: limits.seven_day_opus,
    });
  if (meters.length === 0) return null;

  return (
    <div className="flex h-7 items-center gap-3 rounded-md border border-border bg-card px-3">
      <Gauge size={12} className="shrink-0 text-faint" />
      {meters.map((m, i) => (
        <span key={m.label} className="flex items-center gap-3">
          {i > 0 && <span className="h-3.5 w-px bg-border" />}
          <LimitMeter label={m.label} tip={m.tip} win={m.win} />
        </span>
      ))}
    </div>
  );
}

/** Shows only when an update is live: available → downloading → ready. */
function UpdatePill() {
  const stage = useUpdates((s) => s.stage);
  const version = useUpdates((s) => s.version);
  const progress = useUpdates((s) => s.progress);
  const downloadAndInstall = useUpdates((s) => s.downloadAndInstall);
  const restart = useUpdates((s) => s.restart);

  if (stage === "idle") return null;

  const label =
    stage === "downloading"
      ? `Downloading… ${progress}%`
      : stage === "ready"
        ? "Restart to update"
        : stage === "error"
          ? "Update failed — retry"
          : version
            ? `Update ${version}`
            : "Update available";

  return (
    <button
      className="no-drag flex h-7 items-center gap-1.5 rounded-md border border-ring/50 bg-ring/10 px-2.5 text-[11px] font-medium text-foreground hover:bg-ring/20 disabled:opacity-70"
      disabled={stage === "downloading"}
      onClick={() => (stage === "ready" ? restart() : downloadAndInstall())}
      title={
        stage === "ready"
          ? "Restart SwarmZ to apply the update"
          : "Download and install the update"
      }
    >
      <Download size={12} className="text-ring" />
      <span className="font-mono tabular-nums">{label}</span>
    </button>
  );
}

/** Manual "check for updates" — quiet icon button with transient feedback. */
function UpdateCheckButton() {
  const manualCheck = useUpdates((s) => s.manualCheck);
  const stage = useUpdates((s) => s.stage);
  const checkNow = useUpdates((s) => s.checkNow);

  const label =
    manualCheck === "checking"
      ? "Checking for updates…"
      : manualCheck === "uptodate"
        ? "You're up to date"
        : manualCheck === "error"
          ? "Update check failed"
          : "Check for updates";

  return (
    <Tip label={label}>
      <Button
        size="icon"
        variant="ghost"
        className="no-drag"
        disabled={manualCheck === "checking" || stage === "downloading"}
        onClick={() => void checkNow()}
      >
        {manualCheck === "uptodate" ? (
          <Check size={15} className="text-success" />
        ) : (
          <RefreshCw
            size={15}
            className={manualCheck === "checking" ? "animate-spin" : ""}
          />
        )}
      </Button>
    </Tip>
  );
}
