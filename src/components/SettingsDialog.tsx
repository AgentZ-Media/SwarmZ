import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  ChevronDown,
  ExternalLink,
  FolderCog,
  FolderOpen,
  Info,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { useSwarm } from "@/store";
import { useUpdates } from "@/lib/updates";
import { IS_TAURI, openUrl, pickDirectory } from "@/lib/transport";
import { prettyModel } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { recentCodexModels } from "@/lib/orchestrator/models";
import { ModelEffortPicker } from "./orchestrator/ModelEffortPicker";
import {
  DEFAULT_PERSONA,
  effectivePersona,
  PERSONA_PRESETS,
  type PersonaPreset,
} from "@/lib/orchestrator/persona";
import { readMemory, removeMemory } from "@/lib/orchestrator/memory";
import { useProjects } from "@/lib/projects/store";
import type { OrchestratorMemoryEntry } from "@/lib/orchestrator/types";
import type { OrchestratorPersona } from "@/types";
import { appDataDir, join } from "@tauri-apps/api/path";
import { cn, shortPath } from "@/lib/utils";

// native-only direct invoke — validates the binary path overrides below
const pathIsFile = (path: string) => invoke<boolean>("path_is_file", { path });

const REPO_URL = "https://github.com/AgentZ-Media/SwarmZ";
const AGENTZ_URL = "https://linktr.ee/deragentz";

type SectionId = "orchestrator" | "updates" | "paths" | "about";

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: "orchestrator", label: "Orchestrator", icon: Bot },
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
  const [section, setSection] = useState<SectionId>("orchestrator");

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
            {section === "orchestrator" && <OrchestratorSection />}
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

// ---- Orchestrator ----

/**
 * Codex defaults NEW orchestrator chats are stamped with (a per-chat override
 * the model picker can still change per chat). Same model source as the
 * picker — recently-used ids on this machine + free text. Empty = the user's
 * plain codex config.
 */
function CodexDefaultsRows() {
  const settings = useSwarm((s) => s.settings);
  const updateSettings = useSwarm((s) => s.updateSettings);
  const model = settings.orchestratorCodexModel;
  const effort = settings.orchestratorCodexEffort;
  return (
    <Row
      label="Default model & effort"
      help="Model and reasoning effort new chats start on — the same picker (Available · Recent · Custom) each chat's header uses. Every chat can still change it per turn. Default = your plain codex config."
    >
      <ModelEffortPicker
        model={model}
        effort={effort}
        models={recentCodexModels()}
        footer="Default for new chats."
        onApply={(next) =>
          updateSettings({
            orchestratorCodexModel: next.model || undefined,
            orchestratorCodexEffort: next.effort || undefined,
          })
        }
      >
        <button
          title="Default model & reasoning effort for new chats"
          className="focus-ring flex items-center gap-1 rounded-full border border-border bg-secondary px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:border-ring/50 hover:text-foreground"
        >
          <span className="max-w-40 truncate">
            {model ? prettyModel(model) : "Default"}
          </span>
          {effort && <span className="text-faint">· {effort}</span>}
          <ChevronDown size={11} className="text-faint" />
        </button>
      </ModelEffortPicker>
    </Row>
  );
}

function OrchestratorSection() {
  const settings = useSwarm((s) => s.settings);
  const updateSettings = useSwarm((s) => s.updateSettings);

  const scanRoots = settings.orchestratorScanRoots ?? [];

  if (!IS_TAURI) {
    return (
      <>
        <SectionHeader
          title="Orchestrator"
          sub="The AI team lead behind the Conductor stage (⌘⇧O)."
        />
        <p className="border-t border-border py-3 text-xs leading-relaxed text-muted-foreground">
          The orchestrator ships with the native macOS app.
        </p>
      </>
    );
  }

  return (
    <>
      <SectionHeader
        title="Orchestrator"
        sub="The AI team lead behind the Conductor stage (⌘⇧O) — runs on your ChatGPT subscription via the codex CLI."
      />

      <CodexDefaultsRows />

      <Row
        label="Auto-review finished lanes"
        help="When an agent the Conductor tasked finishes work that changed code, a detached codex review runs automatically and its findings ride into the Conductor's report — you hear about reviewed work, not just finished work. Costs an extra review turn per lane."
      >
        <Switch
          checked={!!settings.autoReviewFinishedLanes}
          onCheckedChange={(v) =>
            updateSettings({ autoReviewFinishedLanes: v })
          }
        />
      </Row>

      <StackedRow
        label="Project scan folders"
        help="Extra folders (e.g. ~/Code) the orchestrator's project discovery shallow-scans for git repos when the model doesn't name its own — on top of your Codex session history and folders the app already knows."
      >
        <div className="flex flex-col gap-1.5">
          {scanRoots.map((root) => (
            <div
              key={root}
              className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1"
            >
              <FolderOpen
                size={12}
                className="shrink-0 text-muted-foreground"
              />
              <span
                className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground"
                title={root}
              >
                {shortPath(root)}
              </span>
              <Button
                size="xs"
                variant="ghost"
                title="Remove folder"
                className="hover:text-destructive"
                onClick={() =>
                  updateSettings({
                    orchestratorScanRoots: scanRoots.filter((r) => r !== root),
                  })
                }
              >
                <Trash2 size={11} />
              </Button>
            </div>
          ))}
          {scanRoots.length === 0 && (
            <p className="px-1 text-[11px] text-faint">
              No folders yet — discovery then relies on session history and
              known folders alone.
            </p>
          )}
          <div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void pickDirectory().then((dir) => {
                  if (dir && !scanRoots.includes(dir))
                    updateSettings({
                      orchestratorScanRoots: [...scanRoots, dir],
                    });
                });
              }}
            >
              <Plus size={13} /> Add folder…
            </Button>
          </div>
        </div>
      </StackedRow>

      <PersonaControls />
      <MemoryControls />
    </>
  );
}

/**
 * Persona editor: a preset picker (Maestro / Hive / Orchestrator) plus the
 * editable voice fields. Persona is voice/self-image only — it never reaches
 * the orchestrator's tools or safety rules (those are hard-wired in Rust).
 * Editing writes the full persona object; unset = the Maestro seed.
 */
function PersonaControls() {
  const stored = useSwarm((s) => s.settings.orchestratorPersona);
  const updateSettings = useSwarm((s) => s.updateSettings);
  const persona = effectivePersona(stored);

  const patch = (p: Partial<OrchestratorPersona>) =>
    updateSettings({ orchestratorPersona: { ...persona, ...p } });

  const applyPreset = (preset: PersonaPreset) =>
    updateSettings({
      orchestratorPersona: {
        name: preset.name,
        role: preset.role,
        tone: preset.tone,
        principles: [...preset.principles],
        emoji: preset.emoji,
      },
    });

  const activePresetId = PERSONA_PRESETS.find(
    (p) =>
      p.name === persona.name &&
      p.role === persona.role &&
      p.tone === persona.tone &&
      p.principles.join("\n") === persona.principles.join("\n"),
  )?.id;

  return (
    <StackedRow
      label="Persona"
      help="Who the orchestrator is — its name, self-image, voice and principles. This shapes tone only; its tools, safety rules and delivery contract are fixed and can't be overridden here."
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-3 gap-1.5">
          {PERSONA_PRESETS.map((preset) => (
            <button
              key={preset.id}
              onClick={() => applyPreset(preset)}
              className={cn(
                "focus-ring flex flex-col gap-0.5 rounded-lg border px-2.5 py-2 text-left",
                activePresetId === preset.id
                  ? "border-ring/60 ring-1 ring-ring/30"
                  : "border-border hover:border-input",
              )}
            >
              <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <span>{preset.emoji}</span>
                {preset.name}
              </span>
              <span className="text-[10px] leading-snug text-faint">
                {preset.blurb}
              </span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Input
            value={persona.emoji ?? ""}
            onChange={(e) => patch({ emoji: e.target.value.slice(0, 4) })}
            className="w-14 text-center text-sm"
            placeholder="🎼"
            aria-label="Persona emoji"
          />
          <Input
            value={persona.name}
            onChange={(e) => patch({ name: e.target.value })}
            className="flex-1 text-xs"
            placeholder="Name"
            aria-label="Persona name"
          />
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            Self-image
          </span>
          <Input
            value={persona.role}
            onChange={(e) => patch({ role: e.target.value })}
            className="text-xs"
            placeholder="the fleet's conductor — you keep the tempo, the agents play"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            Voice
          </span>
          <Input
            value={persona.tone}
            onChange={(e) => patch({ tone: e.target.value })}
            className="text-xs"
            placeholder="Calm, precise, leading."
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            Principles (one per line)
          </span>
          <Textarea
            value={persona.principles.join("\n")}
            onChange={(e) =>
              patch({
                principles: e.target.value
                  .split("\n")
                  .map((l) => l.trim())
                  .filter(Boolean),
              })
            }
            rows={3}
            className="resize-none text-xs"
            placeholder={"Clarity over chatter.\nYou delegate, you don't do the work yourself."}
          />
        </label>

        {stored !== undefined && (
          <div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => updateSettings({ orchestratorPersona: undefined })}
            >
              <RotateCcw size={12} /> Reset to {DEFAULT_PERSONA.name}
            </Button>
          </div>
        )}
      </div>
    </StackedRow>
  );
}

/**
 * Curated-memory management (Phase 3: scoped): a global list plus one list
 * per project — the toggle switches between Global and the ACTIVE project.
 * Shows the stored facts with a count against the cap and per-line delete.
 * New entries are only ever added by the orchestrator via its `remember`
 * tool (transparent chip in the chat) — the files themselves are editable
 * directly at the shown path.
 */
function MemoryControls() {
  const activeProjectId = useProjects((s) => s.activeProjectId);
  const activeProjectName = useProjects((s) =>
    s.activeProjectId ? (s.projects[s.activeProjectId]?.name ?? "") : "",
  );
  const [scope, setScope] = useState<"global" | "project">("global");
  const [entries, setEntries] = useState<OrchestratorMemoryEntry[] | null>(null);
  const [path, setPath] = useState<string | null>(null);
  // stale-read guard: every scope/project switch mints a new token; only the
  // matching response may land. Otherwise a slow read of the OLD scope can
  // overwrite the new scope's list — and a delete would then hit the wrong
  // fact at that stale index.
  const readToken = useRef(0);
  const [deleting, setDeleting] = useState(false);

  // "project" without an open project degrades to global
  const effectiveScope: "global" | "project" =
    scope === "project" && activeProjectId ? "project" : "global";

  useEffect(() => {
    if (!IS_TAURI) return;
    const token = ++readToken.current;
    setEntries(null);
    setDeleting(false);
    readMemory(effectiveScope, activeProjectId ?? undefined).then(
      (list) => {
        if (readToken.current === token) setEntries(list);
      },
      () => {
        if (readToken.current === token) setEntries([]);
      },
    );
    const file =
      effectiveScope === "project" && activeProjectId
        ? `orchestrator-memory/${activeProjectId}.md`
        : "orchestrator-memory/global.md";
    void appDataDir()
      .then((dir) => join(dir, file))
      .then(setPath, () => {});
  }, [effectiveScope, activeProjectId]);

  const del = (index: number) => {
    if (deleting) return;
    const token = readToken.current; // bound to the scope shown right now
    setDeleting(true);
    void removeMemory(index, effectiveScope, activeProjectId ?? undefined).then(
      (list) => {
        if (readToken.current === token) {
          setEntries(list);
          setDeleting(false);
        }
      },
      () => {
        if (readToken.current === token) setDeleting(false);
      },
    );
  };

  const count = entries?.length ?? 0;

  return (
    <StackedRow
      label="Memory"
      help={
        <>
          Durable facts the orchestrator chose to remember (preferences,
          corrections, recurring workflows) — injected into every new session.
          Global facts reach every project's Conductor; project facts only its
          own. The orchestrator writes these itself via its{" "}
          <code>remember</code> tool; here you can review and prune them.
          {path && (
            <>
              {" "}
              File: <span className="font-mono text-[10px]">{path}</span>
            </>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setScope("global")}
              className={cn(
                "focus-ring rounded-md border px-2 py-0.5 font-mono text-[10px]",
                effectiveScope === "global"
                  ? "border-ring/60 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              Global
            </button>
            <button
              onClick={() => setScope("project")}
              disabled={!activeProjectId}
              title={
                activeProjectId
                  ? `Memory of "${activeProjectName}"`
                  : "Open a project to see its memory"
              }
              className={cn(
                "focus-ring max-w-40 truncate rounded-md border px-2 py-0.5 font-mono text-[10px] disabled:opacity-40",
                effectiveScope === "project"
                  ? "border-ring/60 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {activeProjectName || "Project"}
            </button>
          </div>
          <span className="font-mono text-[10px] text-faint">
            {count}/20 entries
          </span>
        </div>
        {entries === null ? (
          <p className="px-1 text-[11px] text-faint">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="px-1 text-[11px] text-faint">
            No memories yet — the orchestrator adds them as you work.
          </p>
        ) : (
          entries.map((entry, i) => (
            <div
              key={`${i}-${entry.text}`}
              className="flex items-start gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1.5"
            >
              {entry.date && (
                <span className="shrink-0 font-mono text-[10px] text-faint tabular-nums">
                  {entry.date}
                </span>
              )}
              <span className="min-w-0 flex-1 text-[11px] leading-snug text-foreground">
                {entry.text}
              </span>
              <Button
                size="xs"
                variant="ghost"
                title="Forget this entry"
                className="hover:text-destructive"
                disabled={deleting}
                onClick={() => del(i)}
              >
                <Trash2 size={11} />
              </Button>
            </div>
          ))
        )}
      </div>
    </StackedRow>
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
          In-app updates ship with the native macOS app.
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
          // Once an update is found, downloaded or installing, checking again is
          // pointless — and in the "ready"/"downloading" states poll() is a
          // no-op anyway, so an enabled button would just feel like a freeze.
          disabled={
            manualCheck === "checking" ||
            stage === "available" ||
            stage === "downloading" ||
            stage === "ready"
          }
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

/**
 * Binary-path override input: edits stay local until blur/Enter, and the
 * persisted value is stat'ed via the backend — a typo'd path silently
 * degrades several features at once, so it gets an inline error instead.
 */
function BinaryPathInput({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder: string;
  onCommit: (v: string | undefined) => void;
}) {
  const [text, setText] = useState(value);
  const [status, setStatus] = useState<"ok" | "missing" | null>(null);
  // re-sync when the persisted value changes from elsewhere
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    const v = value.trim();
    if (!v || !IS_TAURI) {
      setStatus(null);
      return;
    }
    let stale = false;
    void pathIsFile(v)
      .then((ok) => {
        if (!stale) setStatus(ok ? "ok" : "missing");
      })
      .catch(() => {
        if (!stale) setStatus(null);
      });
    return () => {
      stale = true;
    };
  }, [value]);
  const commit = () => onCommit(text.trim() || undefined);
  return (
    <div>
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        className="font-mono text-xs"
        placeholder={placeholder}
        spellCheck={false}
      />
      {status === "missing" && (
        <p className="mt-1 text-[11px] text-destructive">
          No file at this path — fix it or clear the field.
        </p>
      )}
      {status === "ok" && (
        <p className="mt-1 text-[11px] text-success">Found.</p>
      )}
    </div>
  );
}

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
        label="Codex binary"
        help={
          <>
            Absolute path to the{" "}
            <code className="font-mono text-muted-foreground">codex</code>{" "}
            binary used to spawn the app-server behind sessions and the
            orchestrator.
          </>
        }
      >
        <BinaryPathInput
          value={settings.codexPath ?? ""}
          placeholder="codex — resolved by your login shell"
          onCommit={(v) => updateSettings({ codexPath: v })}
        />
      </StackedRow>

      <StackedRow
        label="Git binary"
        help="Used for the read-only git status and the worktree management."
      >
        <BinaryPathInput
          value={settings.gitPath ?? ""}
          placeholder="/usr/bin/git"
          onCommit={(v) => updateSettings({ gitPath: v })}
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
            Run and monitor a swarm of native Codex agents — live sessions,
            approvals, tokens &amp; cost. 100% local.
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
