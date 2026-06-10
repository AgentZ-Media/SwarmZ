import { useState, type ReactNode } from "react";
import {
  ExternalLink,
  FolderCog,
  Info,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_STARTUP,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  useSwarm,
} from "@/store";
import { useUpdates } from "@/lib/updates";
import { IS_TAURI, openUrl } from "@/lib/transport";
import { cn } from "@/lib/utils";

const REPO_URL = "https://github.com/AgentZ-Media/SwarmZ";
const AGENTZ_URL = "https://linktr.ee/deragentz";

type SectionId = "terminal" | "updates" | "paths" | "about";

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "updates", label: "Updates", icon: RefreshCw },
  { id: "paths", label: "Paths", icon: FolderCog },
  { id: "about", label: "About", icon: Info },
];

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [section, setSection] = useState<SectionId>("terminal");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl overflow-hidden p-0"
        aria-describedby={undefined}
      >
        <div className="grid h-[480px] max-h-[80vh] grid-cols-[176px_1fr]">
          <nav className="flex flex-col gap-1 border-r border-border bg-card p-3">
            <DialogTitle className="px-2.5 pb-2 pt-0.5 text-sm">
              Settings
            </DialogTitle>
            {SECTIONS.map(({ id, label, icon: Ic }) => (
              <button
                key={id}
                onClick={() => setSection(id)}
                className={cn(
                  "flex h-8 items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors",
                  section === id
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <Ic size={14} className={section === id ? "" : "text-faint"} />
                {label}
              </button>
            ))}
          </nav>

          <div className="min-h-0 overflow-y-auto p-5">
            {section === "terminal" && <TerminalSection />}
            {section === "updates" && <UpdatesSection />}
            {section === "paths" && <PathsSection />}
            {section === "about" && <AboutSection />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- shared section building blocks ----

function SectionHeader({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="mb-2">
      <h3 className="text-sm font-semibold tracking-tight text-foreground">
        {title}
      </h3>
      <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

/** Label + help on the left, a compact control on the right. */
function Row({
  label,
  help,
  children,
}: {
  label: string;
  help?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-foreground">{label}</div>
        {help && (
          <div className="mt-0.5 text-[11px] leading-relaxed text-faint">
            {help}
          </div>
        )}
      </div>
      {children && (
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      )}
    </div>
  );
}

/** Label + help above a full-width control (for text inputs). */
function StackedRow({
  label,
  help,
  children,
}: {
  label: string;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="border-t border-border py-3">
      <div className="text-[13px] font-medium text-foreground">{label}</div>
      <div className="mt-2">{children}</div>
      {help && (
        <div className="mt-1.5 text-[11px] leading-relaxed text-faint">
          {help}
        </div>
      )}
    </div>
  );
}

// ---- Terminal ----

function TerminalSection() {
  const settings = useSwarm((s) => s.settings);
  const updateSettings = useSwarm((s) => s.updateSettings);

  const size = settings.defaultFontSize ?? DEFAULT_FONT_SIZE;
  const stepSize = (delta: number) =>
    updateSettings({
      defaultFontSize: Math.min(
        MAX_FONT_SIZE,
        Math.max(MIN_FONT_SIZE, size + delta),
      ),
    });

  const startup = settings.defaultStartup ?? DEFAULT_STARTUP;

  return (
    <>
      <SectionHeader
        title="Terminal"
        sub="Defaults for every agent pane — individual panes can still deviate."
      />

      <Row
        label="Default font size"
        help="Applies to all panes without their own zoom. ⌘+ / ⌘− zooms a single pane, ⌘0 resets it."
      >
        <Button
          size="icon"
          variant="outline"
          className="h-7 w-7"
          onClick={() => stepSize(-0.5)}
          disabled={size <= MIN_FONT_SIZE}
        >
          <Minus size={13} />
        </Button>
        <span className="w-12 text-center font-mono text-xs tabular-nums text-foreground">
          {size}px
        </span>
        <Button
          size="icon"
          variant="outline"
          className="h-7 w-7"
          onClick={() => stepSize(0.5)}
          disabled={size >= MAX_FONT_SIZE}
        >
          <Plus size={13} />
        </Button>
        {settings.defaultFontSize !== undefined &&
          settings.defaultFontSize !== DEFAULT_FONT_SIZE && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              title="Reset to default"
              onClick={() => updateSettings({ defaultFontSize: undefined })}
            >
              <RotateCcw size={13} />
            </Button>
          )}
      </Row>

      <StackedRow
        label="Default startup command"
        help={
          <>
            Prefilled in the New Agent dialog; picking a profile there still
            overrides it. Leave empty for a plain shell.
            {settings.defaultStartup !== undefined && (
              <>
                {" "}
                <button
                  className="text-ring hover:underline"
                  onClick={() => updateSettings({ defaultStartup: undefined })}
                >
                  Reset to default
                </button>
              </>
            )}
          </>
        }
      >
        <Input
          value={startup}
          onChange={(e) =>
            updateSettings({
              // typing the built-in default back restores the "unset" state
              defaultStartup:
                e.target.value === DEFAULT_STARTUP ? undefined : e.target.value,
            })
          }
          className="font-mono text-xs"
          placeholder="(leave empty for a plain shell)"
        />
      </StackedRow>
    </>
  );
}

// ---- Updates ----

function UpdatesSection() {
  const settings = useSwarm((s) => s.settings);
  const updateSettings = useSwarm((s) => s.updateSettings);
  const stage = useUpdates((s) => s.stage);
  const version = useUpdates((s) => s.version);
  const progress = useUpdates((s) => s.progress);
  const manualCheck = useUpdates((s) => s.manualCheck);
  const checkNow = useUpdates((s) => s.checkNow);
  const downloadAndInstall = useUpdates((s) => s.downloadAndInstall);
  const restart = useUpdates((s) => s.restart);

  if (!IS_TAURI) {
    return (
      <>
        <SectionHeader
          title="Updates"
          sub="Keep SwarmZ up to date from GitHub Releases."
        />
        <p className="border-t border-border py-3 text-xs leading-relaxed text-muted-foreground">
          In-app updates ship with the native macOS app. The web build simply
          follows your local checkout — pull and restart the engine to update.
        </p>
      </>
    );
  }

  const status =
    stage === "available"
      ? `Update ${version ?? ""} available`
      : stage === "downloading"
        ? `Downloading… ${progress}%`
        : stage === "ready"
          ? "Update downloaded — restart to apply"
          : stage === "error"
            ? "Update failed"
            : manualCheck === "uptodate"
              ? "You're up to date"
              : `SwarmZ v${__APP_VERSION__}`;

  return (
    <>
      <SectionHeader
        title="Updates"
        sub="Keep SwarmZ up to date from GitHub Releases."
      />

      <Row
        label="Automatic updates"
        help="Download new versions in the background as soon as they're found. Installing still happens on the next restart."
      >
        <Switch
          checked={!!settings.autoUpdate}
          onCheckedChange={(v) => updateSettings({ autoUpdate: v })}
          label="Automatic updates"
        />
      </Row>

      <Row label="Check for updates" help={status}>
        {stage === "available" && (
          <Button size="sm" onClick={() => void downloadAndInstall()}>
            Download
          </Button>
        )}
        {stage === "ready" && (
          <Button size="sm" onClick={() => void restart()}>
            Restart now
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={manualCheck === "checking" || stage === "downloading"}
          onClick={() => void checkNow()}
        >
          <RefreshCw
            size={13}
            className={manualCheck === "checking" ? "animate-spin" : ""}
          />
          {manualCheck === "checking" ? "Checking…" : "Check now"}
        </Button>
      </Row>
    </>
  );
}

// ---- Paths ----

function PathsSection() {
  const settings = useSwarm((s) => s.settings);
  const updateSettings = useSwarm((s) => s.updateSettings);

  return (
    <>
      <SectionHeader
        title="Paths"
        sub="Override binaries when they aren't on the PATH the app sees. Leave empty for the defaults."
      />

      <StackedRow
        label="Claude binary"
        help={
          <>
            Absolute path to the{" "}
            <code className="font-mono text-muted-foreground">claude</code>{" "}
            binary. When set, it replaces a leading{" "}
            <code className="font-mono text-muted-foreground">claude</code> in
            startup commands — other commands are untouched.
          </>
        }
      >
        <Input
          value={settings.claudePath ?? ""}
          onChange={(e) =>
            updateSettings({ claudePath: e.target.value || undefined })
          }
          className="font-mono text-xs"
          placeholder="claude — resolved by your login shell"
          spellCheck={false}
        />
      </StackedRow>

      <StackedRow
        label="Git binary"
        help="Used for the read-only git status in pane headers (branch, ±lines, untracked)."
      >
        <Input
          value={settings.gitPath ?? ""}
          onChange={(e) =>
            updateSettings({ gitPath: e.target.value || undefined })
          }
          className="font-mono text-xs"
          placeholder="/usr/bin/git"
          spellCheck={false}
        />
      </StackedRow>
    </>
  );
}

// ---- About ----

function LinkRow({
  label,
  help,
  text,
  url,
}: {
  label: string;
  help?: string;
  text: string;
  url: string;
}) {
  return (
    <Row label={label} help={help}>
      <button
        className="flex items-center gap-1.5 font-mono text-xs text-ring hover:underline"
        onClick={() => void openUrl(url)}
      >
        {text}
        <ExternalLink size={11} />
      </button>
    </Row>
  );
}

function AboutSection() {
  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <img src="/favicon.png" alt="" className="h-12 w-12" draggable={false} />
        <div>
          <div className="text-sm font-semibold tracking-tight text-foreground">
            SwarmZ{" "}
            <span className="ml-1 font-mono text-xs font-normal text-muted-foreground">
              v{__APP_VERSION__}
            </span>
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Run, tile and monitor a swarm of Claude Code agents — real
            terminals, live tokens &amp; cost. 100% local.
          </p>
        </div>
      </div>

      <LinkRow
        label="Source code"
        help="Issues, releases and the README live on GitHub."
        text="AgentZ-Media/SwarmZ"
        url={REPO_URL}
      />
      <LinkRow
        label="Made by AgentZ"
        text="linktr.ee/deragentz"
        url={AGENTZ_URL}
      />
    </>
  );
}
