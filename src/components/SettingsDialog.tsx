import { useEffect, useState, type ReactNode } from "react";
import {
  ExternalLink,
  Folder,
  FolderCog,
  FolderOpen,
  Info,
  LayoutTemplate,
  Mic,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  ScrollText,
  SquareTerminal,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_STARTUP,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  presetKey,
  useSwarm,
} from "@/store";
import { useUpdates } from "@/lib/updates";
import { IS_TAURI, openUrl, pickDirectory } from "@/lib/transport";
import { invoke } from "@tauri-apps/api/core";

// native-only direct invoke (like lib/openrouter.ts) — validates the binary
// path overrides below
const pathIsFile = (path: string) => invoke<boolean>("path_is_file", { path });
import {
  DEFAULT_CLEANUP_MODEL,
  DEFAULT_CLEANUP_PROMPT,
  DEFAULT_STT_MODEL,
  clearOpenrouterKey,
  fetchOpenrouterModels,
  setOpenrouterKey,
} from "@/lib/openrouter";
import { listMicrophones } from "@/lib/dictation";
import {
  LOCAL_STT_DOWNLOAD_MB,
  LOCAL_STT_MODEL_NAME,
  LOCAL_STT_MODEL_URL,
  LOCAL_STT_RAM_GB,
  cancelLocalSttDownload,
  downloadLocalSttModel,
  fetchLocalSttStatus,
  onLocalSttProgress,
  removeLocalSttModel,
  unloadLocalSttModel,
} from "@/lib/local-stt";
import {
  collectPresetPanes,
  removePresetPane,
  updatePresetPane,
} from "@/lib/presets";
import { PresetThumbnail } from "./PresetThumbnail";
import { cn, folderName, shortPath } from "@/lib/utils";
import type {
  CustomCommand,
  OpenrouterModel,
  PresetPaneNode,
  WorkspacePreset,
} from "@/types";

const REPO_URL = "https://github.com/AgentZ-Media/SwarmZ";
const AGENTZ_URL = "https://linktr.ee/deragentz";

type SectionId =
  | "terminal"
  | "presets"
  | "commands"
  | "voice"
  | "updates"
  | "paths"
  | "about";

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "presets", label: "Presets", icon: LayoutTemplate },
  { id: "commands", label: "Commands", icon: ScrollText },
  { id: "voice", label: "Voice", icon: Mic },
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
            {section === "presets" && <PresetsSection />}
            {section === "commands" && <CommandsSection />}
            {section === "voice" && <VoiceSection />}
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
        label="Restore agents on launch"
        help={
          <>
            Reopen the last grid on start and resume each pane's Claude
            conversation (
            <code className="font-mono text-muted-foreground">
              claude --resume
            </code>
            ). Floating terminals don't come back.
          </>
        }
      >
        <Switch
          checked={settings.restoreAgents === true}
          onCheckedChange={(v) => updateSettings({ restoreAgents: v })}
          label="Restore agents on launch"
        />
      </Row>

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

// ---- Presets ----

function PresetsSection() {
  const presets = useSwarm((s) => s.workspacePresets);
  const updateWorkspacePreset = useSwarm((s) => s.updateWorkspacePreset);
  const deleteWorkspacePreset = useSwarm((s) => s.deleteWorkspacePreset);

  return (
    <>
      <SectionHeader
        title="Workspace presets"
        sub="Grid blueprints loadable from any empty workspace. Save new ones via ⌘K → “Save workspace as preset”."
      />
      <p className="mb-2 text-[11px] leading-relaxed text-faint">
        A pane without a fixed folder inherits the one asked for when the
        preset loads. The starter presets leave the command unset — they follow
        the default startup command; an explicitly empty command is a plain
        shell.
      </p>

      {presets.length === 0 && (
        <p className="border-t border-border py-3 text-[11px] text-faint">
          No presets yet.
        </p>
      )}
      {presets.map((preset) => (
        <PresetEditor
          key={preset.id}
          preset={preset}
          onChange={updateWorkspacePreset}
          onDelete={() => deleteWorkspacePreset(preset.id)}
        />
      ))}
    </>
  );
}

/** One preset: rename inline, edit each pane's folder/command, remove panes. */
function PresetEditor({
  preset,
  onChange,
  onDelete,
}: {
  preset: WorkspacePreset;
  onChange: (preset: WorkspacePreset) => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const panes = collectPresetPanes(preset.layout);

  const patchPane = (
    paneId: string,
    patch: Partial<Omit<PresetPaneNode, "type" | "id">>,
  ) =>
    onChange({ ...preset, layout: updatePresetPane(preset.layout, paneId, patch) });

  const removePane = (paneId: string) => {
    const layout = removePresetPane(preset.layout, paneId);
    if (layout) onChange({ ...preset, layout });
  };

  return (
    <div className="border-t border-border py-3">
      <div className="flex items-center gap-3">
        <button
          onClick={() => setExpanded((e) => !e)}
          title={expanded ? "Collapse" : "Edit panes"}
          className="shrink-0"
        >
          <PresetThumbnail layout={preset.layout} className="h-10 w-14" />
        </button>
        <Input
          value={preset.name}
          onChange={(e) => onChange({ ...preset, name: e.target.value })}
          onBlur={(e) => {
            // a preset must keep an identifiable name — empty would leave a
            // blank card on the empty-workspace screen
            if (!e.target.value.trim()) onChange({ ...preset, name: "Preset" });
          }}
          className="h-8 max-w-48 text-xs"
        />
        <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">
          {panes.length} pane{panes.length === 1 ? "" : "s"}
        </span>
        <Button
          size="xs"
          variant="ghost"
          title={expanded ? "Collapse" : "Edit panes"}
          onClick={() => setExpanded((e) => !e)}
        >
          <Pencil size={11} />
        </Button>
        <Button
          size="xs"
          variant="ghost"
          title="Delete preset"
          className="hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 size={11} />
        </Button>
      </div>

      {expanded && (
        <div className="mt-2 flex flex-col gap-1.5">
          {panes.map((pane, i) => (
            <div
              key={pane.id}
              className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 p-1.5"
            >
              <span className="w-5 shrink-0 text-center font-mono text-[10px] text-faint">
                {i + 1}
              </span>
              <button
                onClick={() => {
                  void pickDirectory().then((dir) => {
                    if (dir) patchPane(pane.id, { cwd: dir });
                  });
                }}
                title={pane.cwd ?? "Inherits the folder chosen when loading"}
                className="flex h-7 w-36 shrink-0 items-center gap-1.5 rounded-md border border-border bg-secondary/60 px-2 text-left transition-colors hover:border-input"
              >
                {pane.cwd ? (
                  <>
                    <FolderOpen
                      size={12}
                      className="shrink-0 text-muted-foreground"
                    />
                    <span className="truncate font-mono text-[10px] text-foreground">
                      {shortPath(pane.cwd)}
                    </span>
                  </>
                ) : (
                  <>
                    <Folder size={12} className="shrink-0 text-faint" />
                    <span className="truncate text-[10px] text-faint">
                      Inherit folder
                    </span>
                  </>
                )}
              </button>
              {pane.cwd && (
                <Button
                  size="xs"
                  variant="ghost"
                  title="Inherit the folder chosen when loading"
                  onClick={() => patchPane(pane.id, { cwd: undefined })}
                >
                  <X size={11} />
                </Button>
              )}
              <Input
                value={pane.startup ?? ""}
                onChange={(e) => patchPane(pane.id, { startup: e.target.value })}
                placeholder={
                  pane.startup === undefined
                    ? "default startup command"
                    : "(empty = plain shell)"
                }
                className="h-7 flex-1 font-mono text-[10px]"
                spellCheck={false}
              />
              <Button
                size="xs"
                variant="ghost"
                title="Remove pane"
                className="hover:text-destructive"
                disabled={panes.length === 1}
                onClick={() => removePane(pane.id)}
              >
                <Trash2 size={11} />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Commands ----

function CommandsSection() {
  const customCommands = useSwarm((s) => s.customCommands);
  // a folder picked via "Add folder…" that has no saved command yet — shown
  // as an empty group with the editor open until something is saved
  const [pendingFolder, setPendingFolder] = useState<string | null>(null);

  const folderKeys = Object.keys(customCommands.folders).sort();
  if (pendingFolder && !folderKeys.includes(pendingFolder))
    folderKeys.push(pendingFolder);

  return (
    <>
      <SectionHeader
        title="Commands"
        sub="Prompt snippets for the insert picker (⌘⇧K) — pasted into the active pane, not run."
      />
      <p className="mb-2 text-[11px] leading-relaxed text-faint">
        Placeholders are filled from the target pane when inserting:{" "}
        <code className="font-mono text-muted-foreground">
          {"{{folder}} {{cwd}} {{branch}} {{agent}}"}
        </code>{" "}
        — <code className="font-mono text-muted-foreground">{"{{input:Label}}"}</code>{" "}
        asks for a value first.
      </p>

      <CommandGroup
        title="Global"
        help="Available in every pane"
        folderKey={null}
        commands={customCommands.global}
      />

      {folderKeys.map((key) => (
        <CommandGroup
          key={key}
          title={folderName(key)}
          help={shortPath(key)}
          folderKey={key}
          commands={customCommands.folders[key] ?? []}
          startEditing={key === pendingFolder}
          onEditorClosed={() => {
            if (key === pendingFolder) setPendingFolder(null);
          }}
        />
      ))}

      <div className="border-t border-border py-3">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void pickDirectory().then((dir) => {
              if (dir) setPendingFolder(presetKey(dir));
            });
          }}
        >
          <Plus size={13} /> Add folder…
        </Button>
      </div>
    </>
  );
}

/** One scope (global or a project folder): its commands + inline add/edit. */
function CommandGroup({
  title,
  help,
  folderKey,
  commands,
  startEditing,
  onEditorClosed,
}: {
  title: string;
  help: string;
  folderKey: string | null;
  commands: CustomCommand[];
  startEditing?: boolean;
  onEditorClosed?: () => void;
}) {
  const saveCustomCommand = useSwarm((s) => s.saveCustomCommand);
  const deleteCustomCommand = useSwarm((s) => s.deleteCustomCommand);
  // id being edited, "new" for a fresh one, null = no editor open
  const [editing, setEditing] = useState<string | null>(
    startEditing ? "new" : null,
  );

  const closeEditor = () => {
    setEditing(null);
    onEditorClosed?.();
  };

  return (
    <div className="border-t border-border py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-foreground">{title}</div>
          <div className="truncate font-mono text-[10px] text-faint">{help}</div>
        </div>
        {editing === null && (
          <Button size="sm" variant="ghost" onClick={() => setEditing("new")}>
            <Plus size={13} /> Add command
          </Button>
        )}
      </div>

      <div className="mt-2 flex flex-col gap-1">
        {commands.length === 0 && editing === null && (
          <p className="px-1 text-[11px] text-faint">No commands yet.</p>
        )}
        {commands.map((c) =>
          editing === c.id ? (
            <CommandEditor
              key={c.id}
              initial={c}
              onSave={(label, text) => {
                saveCustomCommand(folderKey, label, text, c.id);
                closeEditor();
              }}
              onCancel={closeEditor}
            />
          ) : (
            <div
              key={c.id}
              className="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent/50"
            >
              <span className="shrink-0 text-[13px] text-foreground">
                {c.label}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-faint">
                {c.text.replace(/\s+/g, " ")}
              </span>
              <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <Button
                  size="xs"
                  variant="ghost"
                  title="Edit"
                  onClick={() => setEditing(c.id)}
                >
                  <Pencil size={11} />
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  title="Delete"
                  className="hover:text-destructive"
                  onClick={() => deleteCustomCommand(folderKey, c.id)}
                >
                  <Trash2 size={11} />
                </Button>
              </span>
            </div>
          ),
        )}
        {editing === "new" && (
          <CommandEditor
            onSave={(label, text) => {
              saveCustomCommand(folderKey, label, text);
              closeEditor();
            }}
            onCancel={closeEditor}
          />
        )}
      </div>
    </div>
  );
}

function CommandEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial?: CustomCommand;
  onSave: (label: string, text: string) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [text, setText] = useState(initial?.text ?? "");
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-secondary/40 p-2.5">
      <Input
        autoFocus
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Label"
        className="h-8 text-xs"
      />
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"Run the tests in {{folder}} and fix every failure."}
        className="min-h-16 font-mono text-xs"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!text.trim()}
          onClick={() => onSave(label, text)}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

// ---- Voice ----

/** Small two-way segmented control (hold / toggle). */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md border px-2.5 py-1 text-xs transition-colors",
            value === o.value
              ? "border-ring/60 bg-ring/15 text-foreground"
              : "border-border bg-secondary/60 text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function VoiceSection() {
  const settings = useSwarm((s) => s.settings);
  const updateSettings = useSwarm((s) => s.updateSettings);
  const status = useSwarm((s) => s.openrouterStatus);
  const setOpenrouterStatus = useSwarm((s) => s.setOpenrouterStatus);

  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  // null until the picker was opened — enumerating may open the mic for a
  // moment (WebKit label unlock), so it only happens on explicit interaction
  const [mics, setMics] = useState<
    { deviceId: string; label: string }[] | null
  >(null);
  const [models, setModels] = useState<OpenrouterModel[] | null>(null);

  // the catalog is public (no key needed) and cached for an hour in Rust
  useEffect(() => {
    if (!IS_TAURI) return;
    fetchOpenrouterModels().then(setModels, () => setModels(null));
  }, []);

  if (!IS_TAURI) {
    return (
      <>
        <SectionHeader
          title="Voice"
          sub="Dictate prompts into any pane via OpenRouter speech-to-text."
        />
        <p className="border-t border-border py-3 text-xs leading-relaxed text-muted-foreground">
          Voice dictation ships with the native macOS app.
        </p>
      </>
    );
  }

  const saveKey = async () => {
    const key = keyInput.trim();
    if (!key) return;
    setSaving(true);
    setKeyError(null);
    try {
      const st = await setOpenrouterKey(key);
      setOpenrouterStatus(st);
      setKeyInput("");
    } catch (e) {
      setKeyError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const removeKey = async () => {
    try {
      await clearOpenrouterKey();
      setOpenrouterStatus({ present: false, valid: false });
    } catch (e) {
      setKeyError(String(e));
    }
  };

  const local = (settings.dictationEngine ?? "openrouter") === "local";

  const keyStatusLine = keyError ? (
    <span className="text-destructive">{keyError}</span>
  ) : !status?.present ? (
    local
      ? "No key set — optional with the local engine; only the cleanup pass uses OpenRouter."
      : "No key set — the dictation mic stays hidden until one is added."
  ) : status.valid === true ? (
    <span className="text-success">
      {local
        ? "Key valid — transcript cleanup is available."
        : "Key valid — voice dictation is enabled."}
    </span>
  ) : status.valid === false ? (
    <span className="text-destructive">
      {local
        ? "Key stored, but OpenRouter rejected it — cleanup stays off."
        : "Key stored, but OpenRouter rejected it — dictation stays off."}
    </span>
  ) : (
    "Key stored — couldn't verify it right now (offline?). Dictation stays enabled."
  );

  const cleanupModel = settings.dictationCleanupModel ?? DEFAULT_CLEANUP_MODEL;
  const cleanupPrompt =
    settings.dictationCleanupPrompt ?? DEFAULT_CLEANUP_PROMPT;

  // until the list is loaded the saved selection still needs an item to
  // resolve against; once loaded, an unplugged saved mic keeps an entry so
  // the selection stays visible instead of silently jumping to default
  const micId = settings.dictationMicId;
  const savedMic = micId
    ? {
        deviceId: micId,
        label: settings.dictationMicLabel || "Saved microphone",
        missing: !!mics && !mics.some((m) => m.deviceId === micId),
      }
    : null;
  const micOptions: { deviceId: string; label: string; missing?: boolean }[] =
    mics
      ? savedMic?.missing
        ? [...mics, savedMic]
        : mics
      : savedMic
        ? [savedMic]
        : [];

  return (
    <>
      <SectionHeader
        title="Voice"
        sub="Dictate prompts into any pane — hold ⌘ (or click a pane's mic) and speak; the transcript is pasted into the terminal."
      />

      <Row
        label="Transcription engine"
        help="Cloud sends the recording to OpenRouter (API key required). Local runs NVIDIA Parakeet fully on-device — nothing leaves the machine and no key is needed to transcribe."
      >
        <Segmented
          value={local ? "local" : "openrouter"}
          options={[
            { value: "openrouter", label: "Cloud (OpenRouter)" },
            { value: "local", label: "Local (Parakeet)" },
          ]}
          onChange={(v) => {
            updateSettings({
              dictationEngine: v === "openrouter" ? undefined : v,
            });
            // switching back to cloud frees the ~2 GB resident model
            if (v === "openrouter")
              void unloadLocalSttModel()
                .then(() => fetchLocalSttStatus())
                .then((st) => useSwarm.getState().setLocalSttStatus(st))
                .catch(() => {});
          }}
        />
      </Row>

      {local && <LocalModelRow />}

      <StackedRow
        label="OpenRouter API key"
        help={
          <>
            {keyStatusLine} Stored in the macOS Keychain, never on disk — all
            requests are made natively.
          </>
        }
      >
        <div className="flex items-center gap-2">
          <Input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveKey();
            }}
            className="font-mono text-xs"
            placeholder={
              status?.present ? "••••••••  (replace key)" : "sk-or-…"
            }
            spellCheck={false}
          />
          <Button
            size="sm"
            disabled={!keyInput.trim() || saving}
            onClick={() => void saveKey()}
          >
            {saving ? "Checking…" : "Save"}
          </Button>
          {status?.present && (
            <Button size="sm" variant="outline" onClick={() => void removeKey()}>
              Remove
            </Button>
          )}
        </div>
      </StackedRow>

      <Row
        label="Microphone"
        help="Input device used for recordings. System default follows the input selected in macOS Sound settings; an unplugged device falls back to the default."
      >
        <Select
          value={micId ?? "default"}
          onValueChange={(v) => {
            if (v === "default")
              updateSettings({
                dictationMicId: undefined,
                dictationMicLabel: undefined,
              });
            else
              updateSettings({
                dictationMicId: v,
                dictationMicLabel: micOptions.find((m) => m.deviceId === v)
                  ?.label,
              });
          }}
          onOpenChange={(o) => {
            // re-enumerate on every open so newly plugged mics show up
            if (o) void listMicrophones().then(setMics, () => setMics([]));
          }}
        >
          <SelectTrigger className="w-56 text-xs [&>span]:truncate">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">System default</SelectItem>
            {micOptions.map((m) => (
              <SelectItem key={m.deviceId} value={m.deviceId}>
                {m.label}
                {m.missing ? " (not connected)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>

      <Row
        label="Hotkey behavior"
        help="Hold: keep plain ⌘ pressed and speak — recording starts after a brief moment (so ⌘-shortcuts never trigger it), release to transcribe. Toggle: ⌘⇧M starts and stops. Recordings under ~1 s are discarded; the cap is 5 minutes."
      >
        <Segmented
          value={settings.dictationHotkeyMode ?? "hold"}
          options={[
            { value: "hold", label: "Hold" },
            { value: "toggle", label: "Toggle" },
          ]}
          onChange={(v) => updateSettings({ dictationHotkeyMode: v })}
        />
      </Row>

      <Row
        label="Submit automatically"
        help="Press Enter right after pasting the transcript. Off = review first, submit yourself."
      >
        <Switch
          checked={!!settings.dictationAutoSubmit}
          onCheckedChange={(v) => updateSettings({ dictationAutoSubmit: v })}
          label="Submit automatically"
        />
      </Row>

      <Row
        label="Clean up transcripts"
        help={
          local
            ? "Polish the raw transcript with an LLM (filler words, punctuation) before pasting. Runs via OpenRouter — needs a key above even with the local engine."
            : "Polish the raw transcript with an LLM (filler words, punctuation) before pasting. Adds a little latency per dictation."
        }
      >
        <Switch
          checked={!!settings.dictationCleanup}
          onCheckedChange={(v) => updateSettings({ dictationCleanup: v })}
          label="Clean up transcripts"
        />
      </Row>

      {settings.dictationCleanup && (
        <>
          <StackedRow
            label="Cleanup model"
            help={
              <>
                Any text model on OpenRouter — suggestions come from the live
                catalog{models ? ` (${models.length} models)` : ""}.
                {settings.dictationCleanupModel !== undefined && (
                  <>
                    {" "}
                    <button
                      className="text-ring hover:underline"
                      onClick={() =>
                        updateSettings({ dictationCleanupModel: undefined })
                      }
                    >
                      Reset to default
                    </button>
                  </>
                )}
              </>
            }
          >
            <>
              <Input
                value={cleanupModel}
                onChange={(e) =>
                  updateSettings({
                    dictationCleanupModel:
                      e.target.value === DEFAULT_CLEANUP_MODEL
                        ? undefined
                        : e.target.value,
                  })
                }
                list="openrouter-models"
                className="font-mono text-xs"
                placeholder={DEFAULT_CLEANUP_MODEL}
                spellCheck={false}
              />
              <datalist id="openrouter-models">
                {models?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </datalist>
            </>
          </StackedRow>

          <StackedRow
            label="Cleanup prompt"
            help={
              <>
                System prompt of the cleanup pass. Keep the no-translation rule
                — dictation should work in every language.
                {settings.dictationCleanupPrompt !== undefined && (
                  <>
                    {" "}
                    <button
                      className="text-ring hover:underline"
                      onClick={() =>
                        updateSettings({ dictationCleanupPrompt: undefined })
                      }
                    >
                      Reset to default
                    </button>
                  </>
                )}
              </>
            }
          >
            <Textarea
              value={cleanupPrompt}
              onChange={(e) =>
                updateSettings({
                  dictationCleanupPrompt:
                    e.target.value === DEFAULT_CLEANUP_PROMPT
                      ? undefined
                      : e.target.value,
                })
              }
              className="min-h-32 font-mono text-xs"
              spellCheck={false}
            />
          </StackedRow>
        </>
      )}

      {!local && (
        <StackedRow
          label="Transcription model"
          help={
            <>
              OpenRouter speech-to-text model used for dictation.
              {settings.dictationSttModel !== undefined && (
                <>
                  {" "}
                  <button
                    className="text-ring hover:underline"
                    onClick={() =>
                      updateSettings({ dictationSttModel: undefined })
                    }
                  >
                    Reset to default
                  </button>
                </>
              )}
            </>
          }
        >
          <Input
            value={settings.dictationSttModel ?? DEFAULT_STT_MODEL}
            onChange={(e) =>
              updateSettings({
                dictationSttModel:
                  e.target.value === DEFAULT_STT_MODEL
                    ? undefined
                    : e.target.value,
              })
            }
            className="font-mono text-xs"
            placeholder={DEFAULT_STT_MODEL}
            spellCheck={false}
          />
        </StackedRow>
      )}
    </>
  );
}

/**
 * Status / download card of the local speech model (engine "local"). The
 * download streams from Hugging Face in Rust; progress arrives aggregated
 * over all model files via `localstt://progress`.
 */
function LocalModelRow() {
  const status = useSwarm((s) => s.localSttStatus);
  const setLocalSttStatus = useSwarm((s) => s.setLocalSttStatus);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<{
    downloaded: number;
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = onLocalSttProgress(setProgress);
    return () => void unlisten.then((f) => f());
  }, []);

  const refresh = () =>
    fetchLocalSttStatus()
      .then(setLocalSttStatus)
      .catch(() => {});

  // a download started earlier keeps running in Rust while this dialog is
  // closed — re-sync on open so the row doesn't show a stale state
  useEffect(() => void refresh(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const download = async () => {
    setError(null);
    setDownloading(true);
    setProgress({ downloaded: 0, total: status?.totalBytes ?? 0 });
    try {
      await downloadLocalSttModel();
    } catch (e) {
      // a user-initiated cancel is not an error worth showing
      if (!String(e).includes("cancelled")) setError(String(e));
    } finally {
      setDownloading(false);
      setProgress(null);
      void refresh();
    }
  };

  const remove = async () => {
    setError(null);
    try {
      await removeLocalSttModel();
    } catch (e) {
      setError(String(e));
    }
    void refresh();
  };

  const totalMb = Math.round((status?.totalBytes ?? 0) / 1e6) || LOCAL_STT_DOWNLOAD_MB;
  const pct = progress?.total
    ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
    : 0;

  return (
    <StackedRow
      label="Local model"
      help={
        <>
          <button
            className="text-ring hover:underline"
            onClick={() => void openUrl(LOCAL_STT_MODEL_URL)}
          >
            {LOCAL_STT_MODEL_NAME}
          </button>{" "}
          by NVIDIA — multilingual (25 languages), runs on-device via ONNX
          Runtime; nothing to install besides the one-time {totalMb} MB
          download. Transcribing takes roughly {LOCAL_STT_RAM_GB} GB of free
          RAM; the model loads on the first dictation and stays in memory
          until the engine is switched back to Cloud.
          {error && (
            <>
              {" "}
              <span className="text-destructive">{error}</span>
            </>
          )}
        </>
      }
    >
      {status?.installed ? (
        <div className="flex items-center gap-3">
          <span className="text-xs text-success">
            Installed ({totalMb} MB on disk)
            {status.loaded ? " — loaded in RAM" : ""}
          </span>
          <Button size="sm" variant="outline" onClick={() => void remove()}>
            Remove
          </Button>
        </div>
      ) : downloading || status?.downloading ? (
        <div className="flex items-center gap-3">
          <div className="h-1.5 w-48 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-ring transition-[width] duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">
            {pct}%
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void cancelLocalSttDownload()}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button size="sm" onClick={() => void download()}>
          Download model ({totalMb} MB)
        </Button>
      )}
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

/**
 * Binary-path override input: edits stay local until blur/Enter (a half-typed
 * path must never reach the live 7s git polling), and the persisted value is
 * stat'ed via the backend — a typo'd path silently degrades several features
 * at once, so it gets an inline error instead.
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
        <BinaryPathInput
          value={settings.claudePath ?? ""}
          placeholder="claude — resolved by your login shell"
          onCommit={(v) => updateSettings({ claudePath: v })}
        />
      </StackedRow>

      <StackedRow
        label="Git binary"
        help="Used for the read-only git status in pane headers (branch, ±lines, untracked)."
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
