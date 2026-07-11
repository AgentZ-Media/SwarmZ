import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ExternalLink,
  FolderOpen,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input, Label } from "./ui/input";
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

/**
 * Settings v2 — one scrolling column of mono-labeled sections:
 * Conductor · Autonomy · Appearance · Memory · Paths · Updates · About.
 */
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl overflow-hidden p-0"
        aria-describedby={undefined}
      >
        <div className="flex h-[560px] max-h-[80vh] flex-col">
          <div className="shrink-0 border-b border-line px-6 pb-3 pt-5">
            <DialogTitle>Settings</DialogTitle>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
            <ConductorSection />
            <AutonomySection />
            <GithubSection />
            <AppearanceSection />
            <MemorySection />
            <PathsSection />
            <UpdatesSection />
            <AboutSection />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- shared section building blocks ----

/** A settings section: mono uppercase micro-label (+ optional sub) above rows. */
function Section({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="font-mono text-10 font-medium uppercase tracking-[.08em] text-fnt">
        {label}
      </div>
      {sub && <p className="mt-1 text-11 leading-relaxed text-fnt">{sub}</p>}
      <div className="mt-2">{children}</div>
    </section>
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
    <div className="flex items-center justify-between gap-4 border-t border-line py-3">
      <div className="min-w-0 flex-1">
        <div className="text-13 font-medium text-txt">{label}</div>
        {help && (
          <div className="mt-0.5 text-11 leading-relaxed text-fnt">{help}</div>
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
    <div className="border-t border-line py-3">
      <div className="text-13 font-medium text-txt">{label}</div>
      <div className="mt-2">{children}</div>
      {help && (
        <div className="mt-1.5 text-11 leading-relaxed text-fnt">{help}</div>
      )}
    </div>
  );
}

/** Card row: title + subtext on the left, a Switch on the right. */
function ToggleCard({
  title,
  sub,
  checked,
  onChange,
}: {
  title: string;
  sub: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-line bg-card p-3">
      <div className="min-w-0">
        <div className="text-13 font-medium text-txt">{title}</div>
        <div className="mt-0.5 text-11 leading-relaxed text-fnt">{sub}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} label={title} />
    </div>
  );
}

/** Read-only informational row — explains behavior, offers no control. */
function InfoRow({ title, text }: { title: string; text: string }) {
  return (
    <div className="px-3 py-1">
      <div className="text-13 font-medium text-txt">{title}</div>
      <div className="mt-0.5 text-11 leading-relaxed text-fnt">{text}</div>
    </div>
  );
}

// ---- Conductor ----

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
          className="focus-ring flex items-center gap-1 rounded-full border border-line bg-pop px-2.5 py-1 font-mono text-11 text-mut transition-colors hover:border-acc/55 hover:text-txt"
        >
          <span className="max-w-40 truncate">
            {model ? prettyModel(model) : "Default"}
          </span>
          {effort && <span className="text-fnt">· {effort}</span>}
          <ChevronDown size={11} className="text-fnt" />
        </button>
      </ModelEffortPicker>
    </Row>
  );
}

function ConductorSection() {
  if (!IS_TAURI) {
    return (
      <Section
        label="Conductor"
        sub="The AI team lead behind the Conductor stage (⌘⇧O)."
      >
        <p className="border-t border-line py-3 text-12 leading-relaxed text-mut">
          The Conductor ships with the native macOS app.
        </p>
      </Section>
    );
  }

  return (
    <Section
      label="Conductor"
      sub="The AI team lead behind the Conductor stage (⌘⇧O) — runs on your ChatGPT subscription via the codex CLI."
    >
      <CodexDefaultsRows />
      <PersonaControls />
    </Section>
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
                "focus-ring flex flex-col gap-0.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
                activePresetId === preset.id
                  ? "border-acc/60 ring-1 ring-acc/30"
                  : "border-line hover:border-line2",
              )}
            >
              <span className="flex items-center gap-1.5 text-12 font-semibold text-txt">
                <span>{preset.emoji}</span>
                {preset.name}
              </span>
              <span className="text-10 leading-snug text-fnt">
                {preset.blurb}
              </span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Input
            value={persona.emoji ?? ""}
            onChange={(e) => patch({ emoji: e.target.value.slice(0, 4) })}
            className="w-14 text-center"
            placeholder="🎼"
            aria-label="Persona emoji"
          />
          <Input
            value={persona.name}
            onChange={(e) => patch({ name: e.target.value })}
            className="flex-1 text-12"
            placeholder="Name"
            aria-label="Persona name"
          />
        </div>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-10 font-medium uppercase tracking-[.08em] text-fnt">
            Self-image
          </span>
          <Input
            value={persona.role}
            onChange={(e) => patch({ role: e.target.value })}
            className="text-12"
            placeholder="the fleet's conductor — you keep the tempo, the agents play"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-10 font-medium uppercase tracking-[.08em] text-fnt">
            Voice
          </span>
          <Input
            value={persona.tone}
            onChange={(e) => patch({ tone: e.target.value })}
            className="text-12"
            placeholder="Calm, precise, leading."
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-10 font-medium uppercase tracking-[.08em] text-fnt">
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
            className="resize-none text-12"
            placeholder={"Clarity over chatter.\nYou delegate, you don't do the work yourself."}
          />
        </label>

        {stored !== undefined && (
          <div>
            <Button
              size="sm"
              variant="ghost"
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

// ---- Autonomy ----

function AutonomySection() {
  const autoReview = useSwarm((s) => !!s.settings.autoReviewFinishedLanes);
  const autoCompact = useSwarm((s) => s.settings.autoCompact !== false);
  const updateSettings = useSwarm((s) => s.updateSettings);

  if (!IS_TAURI) return null;

  return (
    <Section label="Autonomy">
      <div className="flex flex-col gap-2">
        <ToggleCard
          title="Auto-review finished lanes"
          sub="When an agent the Conductor tasked finishes work that changed code, a detached codex review runs automatically and its findings ride into the Conductor's report — you hear about reviewed work, not just finished work. Costs an extra review turn per lane."
          checked={autoReview}
          onChange={(v) => updateSettings({ autoReviewFinishedLanes: v })}
        />
        <ToggleCard
          title="Auto-compact context"
          sub="When a session or Conductor chat nears its context window (≥85%), it compacts automatically before the next turn — the model keeps a summarized history so it stays coherent on long runs. Your visible transcript is never touched. Only when idle. You can also compact any time via the ctx gauge."
          checked={autoCompact}
          onChange={(v) => updateSettings({ autoCompact: v })}
        />
        <InfoRow
          title="Autonomy budget"
          text="Autonomous turns are budget-capped — max 5 consecutive without your message, 20 per hour per project. A tripped breaker re-arms on your next message."
        />
        <InfoRow
          title="Approval policy"
          text="Routine (read-only/test) approvals can be decided by the Conductor; anything destructive always waits for you."
        />
      </div>
    </Section>
  );
}

// ---- GitHub (Phase 7) ----

/** Watch-interval choices (seconds). */
const WATCH_INTERVALS: { label: string; sec: number }[] = [
  { label: "1m", sec: 60 },
  { label: "2m", sec: 120 },
  { label: "5m", sec: 300 },
  { label: "10m", sec: 600 },
];

/**
 * The GitHub integration — everything runs over the LOCAL `gh` CLI, no OAuth,
 * no tokens in SwarmZ. The master toggle gates the Conductor's github tools,
 * the PR watcher, the Deck indicator AND the routine-classification of the
 * two sanctioned agent-run gh writes (comment/review — mirrored into Rust).
 * The read-only GitHub panel works regardless.
 */
function GithubSection() {
  const settings = useSwarm((s) => s.settings);
  const updateSettings = useSwarm((s) => s.updateSettings);
  if (!IS_TAURI) return null;

  const enabled = !!settings.githubIntegration;
  const intervalSec = settings.githubWatchIntervalSec ?? 120;

  return (
    <Section
      label="GitHub"
      sub="Uses your locally installed, logged-in gh CLI — SwarmZ never handles tokens or its own login. The panel (title bar) is always read-only available; this switch adds the automation."
    >
      <div className="flex flex-col gap-2">
        <ToggleCard
          title="GitHub integration"
          sub="Gives the Conductor its GitHub tools (PRs listen/read/create/review/comment/watch), starts the PR watcher and the Deck indicator, and lets it decide routine agent approvals for gh comment/review. Merging and closing PRs always stay with you."
          checked={enabled}
          onChange={(v) => updateSettings({ githubIntegration: v })}
        />
        <div className={enabled ? "flex flex-col gap-2" : "pointer-events-none flex flex-col gap-2 opacity-40"}>
          <ToggleCard
            title="Auto-review new PRs"
            sub="A newly opened PR wakes the Conductor with an autonomous review turn (budget-capped like every autonomous turn)."
            checked={!!settings.githubAutoReviewPrs}
            onChange={(v) => updateSettings({ githubAutoReviewPrs: v })}
          />
          <ToggleCard
            title="Suggest a PR when a lane finishes"
            sub="When a Conductor-tasked agent finishes work on a branch without an open PR, the Conductor's report suggests opening one. Creating it still needs your order."
            checked={!!settings.githubSuggestPrOnFinish}
            onChange={(v) => updateSettings({ githubSuggestPrOnFinish: v })}
          />
          <ToggleCard
            title="Autonomous GitHub writes"
            sub="Lets the Conductor open PRs, comment and post reviews DURING an autonomous turn (a fleet event drove it, not your message). Off = it must propose these to you instead; turns you trigger directly always allow them. Merging and closing a PR always stay with you. A safety cap against a prompt-injected autonomous cascade posting on your repo — leave off unless you want hands-off GitHub."
            checked={!!settings.autonomousGithubWrites}
            onChange={(v) => updateSettings({ autonomousGithubWrites: v })}
          />
          <Row
            label="Watch interval"
            help="How often open PRs are polled for check/review changes."
          >
            <div className="flex items-center gap-1">
              {WATCH_INTERVALS.map((w) => (
                <button
                  key={w.sec}
                  onClick={() => updateSettings({ githubWatchIntervalSec: w.sec })}
                  className={cn(
                    "focus-ring rounded-md border px-2 py-0.5 font-mono text-10 transition-colors",
                    intervalSec === w.sec
                      ? "border-acc/60 text-txt"
                      : "border-line text-mut hover:text-txt",
                  )}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </Row>
        </div>
      </div>
    </Section>
  );
}

// ---- Appearance ----

function AppearanceSection() {
  const reduceMotion = useSwarm((s) => !!s.settings.reduceMotion);
  const updateSettings = useSwarm((s) => s.updateSettings);

  return (
    <Section label="Appearance">
      <ToggleCard
        title="Reduce motion"
        sub="Collapses sweeps, pulses and entrance animations."
        checked={reduceMotion}
        onChange={(v) => updateSettings({ reduceMotion: v })}
      />
    </Section>
  );
}

// ---- Memory ----

/**
 * Curated-memory management (Phase 3: scoped): a global list plus one list
 * per project — the toggle switches between Global and the ACTIVE project.
 * Shows the stored facts with a count against the cap and per-line delete.
 * New entries are only ever added by the orchestrator via its `remember`
 * tool (transparent chip in the chat) — the files themselves are editable
 * directly at the shown path.
 */
function MemorySection() {
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

  if (!IS_TAURI) return null;

  return (
    <Section label="Memory">
      <p className="text-11 leading-relaxed text-fnt">
        Durable facts the orchestrator chose to remember (preferences,
        corrections, recurring workflows) — injected into every new session.
        Global facts reach every project's Conductor; project facts only its
        own. The orchestrator writes these itself via its{" "}
        <code className="font-mono">remember</code> tool; here you can review
        and prune them.
        {path && (
          <>
            {" "}
            File: <span className="font-mono text-10">{path}</span>
          </>
        )}
      </p>
      <div className="mt-2 flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setScope("global")}
              className={cn(
                "focus-ring rounded-md border px-2 py-0.5 font-mono text-10 transition-colors",
                effectiveScope === "global"
                  ? "border-acc/60 text-txt"
                  : "border-line text-mut hover:text-txt",
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
                "focus-ring max-w-40 truncate rounded-md border px-2 py-0.5 font-mono text-10 transition-colors disabled:opacity-40",
                effectiveScope === "project"
                  ? "border-acc/60 text-txt"
                  : "border-line text-mut hover:text-txt",
              )}
            >
              {activeProjectName || "Project"}
            </button>
          </div>
          <span className="font-mono text-10 tabular-nums text-fnt">
            {count}/20 entries
          </span>
        </div>
        {entries === null ? (
          <p className="px-1 text-11 text-fnt">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="px-1 text-11 text-fnt">
            No memories yet — the orchestrator adds them as you work.
          </p>
        ) : (
          entries.map((entry, i) => (
            <div
              key={`${i}-${entry.text}`}
              className="flex items-start gap-2 rounded-md border border-line bg-card px-2 py-1.5"
            >
              {entry.date && (
                <span className="shrink-0 font-mono text-10 tabular-nums text-fnt">
                  {entry.date}
                </span>
              )}
              <span className="min-w-0 flex-1 text-11 leading-snug text-txt">
                {entry.text}
              </span>
              <Button
                size="xs"
                variant="ghost"
                title="Forget this entry"
                className="hover:text-err"
                disabled={deleting}
                onClick={() => del(i)}
              >
                <Trash2 size={11} />
              </Button>
            </div>
          ))
        )}
      </div>
    </Section>
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
        className="font-mono text-12"
        placeholder={placeholder}
        spellCheck={false}
      />
      {status === "missing" && (
        <p className="mt-1 text-11 text-err">
          No file at this path — fix it or clear the field.
        </p>
      )}
      {status === "ok" && <p className="mt-1 text-11 text-ok">Found.</p>}
    </div>
  );
}

function PathsSection() {
  const settings = useSwarm((s) => s.settings);
  const updateSettings = useSwarm((s) => s.updateSettings);

  const scanRoots = settings.orchestratorScanRoots ?? [];

  return (
    <Section
      label="Paths"
      sub="Override binaries when they aren't on the PATH the app sees. Leave empty for the defaults."
    >
      <div className="flex flex-col gap-4 pt-1">
        <div>
          <Label>Codex binary</Label>
          <BinaryPathInput
            value={settings.codexPath ?? ""}
            placeholder="codex — resolved by your login shell"
            onCommit={(v) => updateSettings({ codexPath: v })}
          />
          <p className="mt-1.5 text-11 leading-relaxed text-fnt">
            Absolute path to the{" "}
            <code className="font-mono text-mut">codex</code> binary used to
            spawn the app-server behind sessions and the orchestrator.
          </p>
        </div>

        <div>
          <Label>Git binary</Label>
          <BinaryPathInput
            value={settings.gitPath ?? ""}
            placeholder="/usr/bin/git"
            onCommit={(v) => updateSettings({ gitPath: v })}
          />
          <p className="mt-1.5 text-11 leading-relaxed text-fnt">
            Used for the read-only git status and the worktree management.
          </p>
        </div>

        <div>
          <Label>GitHub CLI binary</Label>
          <BinaryPathInput
            value={settings.ghPath ?? ""}
            placeholder="gh — auto-resolved (homebrew paths probed)"
            onCommit={(v) => updateSettings({ ghPath: v })}
          />
          <p className="mt-1.5 text-11 leading-relaxed text-fnt">
            Absolute path to <code className="font-mono text-mut">gh</code> for
            the GitHub integration and panel.
          </p>
        </div>

        {IS_TAURI && (
          <div>
            <Label>Project scan folders</Label>
            <div className="flex flex-col gap-1.5">
              {scanRoots.map((root) => (
                <div
                  key={root}
                  className="flex items-center gap-2 rounded-md border border-line bg-card px-2 py-1"
                >
                  <FolderOpen size={12} className="shrink-0 text-mut" />
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-10 text-txt"
                    title={root}
                  >
                    {shortPath(root)}
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    title="Remove folder"
                    className="hover:text-err"
                    onClick={() =>
                      updateSettings({
                        orchestratorScanRoots: scanRoots.filter(
                          (r) => r !== root,
                        ),
                      })
                    }
                  >
                    <Trash2 size={11} />
                  </Button>
                </div>
              ))}
              {scanRoots.length === 0 && (
                <p className="px-1 text-11 text-fnt">
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
            <p className="mt-1.5 text-11 leading-relaxed text-fnt">
              Extra folders (e.g. ~/Code) the orchestrator's project discovery
              shallow-scans for git repos when the model doesn't name its own —
              on top of your Codex session history and folders the app already
              knows.
            </p>
          </div>
        )}
      </div>
    </Section>
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
      <Section
        label="Updates"
        sub="Keep SwarmZ up to date from GitHub Releases."
      >
        <p className="border-t border-line py-3 text-12 leading-relaxed text-mut">
          In-app updates ship with the native macOS app.
        </p>
      </Section>
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
    <Section label="Updates" sub="Keep SwarmZ up to date from GitHub Releases.">
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
    </Section>
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
        className="focus-ring flex items-center gap-1.5 font-mono text-12 text-acc hover:underline"
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
    <Section label="About">
      <div className="mb-3 pt-1">
        <div className="flex items-center gap-2 text-14 font-bold tracking-[-0.01em] text-txt">
          <span className="hex-mark hex-mark-flat inline-block h-5 w-5" />
          SwarmZ
          <span className="font-mono text-12 font-normal text-mut">
            v{__APP_VERSION__}
          </span>
        </div>
        <p className="mt-1 text-12 leading-relaxed text-mut">
          Run and monitor a swarm of native Codex agents — live sessions,
          approvals, tokens &amp; cost. 100% local.
        </p>
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
    </Section>
  );
}
