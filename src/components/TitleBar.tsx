import {
  BarChart3,
  Check,
  Download,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Zap,
} from "lucide-react";
import { useSwarm } from "@/store";
import { useUpdates } from "@/lib/updates";
import { Button } from "./ui/button";
import { Tip } from "./ui/tooltip";
import { formatTokens, formatUsd } from "@/lib/utils";
import { IS_TAURI } from "@/lib/transport";

export function TitleBar({ onManageProfiles }: { onManageProfiles: () => void }) {
  const setNewAgentOpen = useSwarm((s) => s.setNewAgentOpen);
  const setDashboardOpen = useSwarm((s) => s.setDashboardOpen);
  const dashboardOpen = useSwarm((s) => s.dashboardOpen);
  const agents = useSwarm((s) => s.agents);
  const order = useSwarm((s) => s.order);

  const live = order.reduce(
    (acc, id) => {
      const u = agents[id]?.usage;
      if (u) {
        acc.cost += u.cost_usd;
        acc.tokens +=
          u.input_tokens +
          u.output_tokens +
          u.cache_creation_tokens +
          u.cache_read_tokens;
      }
      return acc;
    },
    { cost: 0, tokens: 0 },
  );
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

        <div className="flex h-7 items-center gap-3 rounded-md border border-border bg-card px-3">
          <Tip label="Tokens across open agents (current sessions)">
            <span className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
              <span className="text-[10px] font-medium uppercase tracking-wider text-faint">
                tok
              </span>
              {formatTokens(live.tokens)}
            </span>
          </Tip>
          <div className="h-3.5 w-px bg-border" />
          <Tip label="Cost across open agents (current sessions)">
            <span className="font-mono text-[11px] tabular-nums text-foreground">
              {formatUsd(live.cost)}
            </span>
          </Tip>
        </div>

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
