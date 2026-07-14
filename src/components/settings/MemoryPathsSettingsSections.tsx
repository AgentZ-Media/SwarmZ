import { useEffect, useRef, useState } from "react";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { readMemory, removeMemory } from "@/lib/orchestrator/memory";
import type { OrchestratorMemoryEntry } from "@/lib/orchestrator/types";
import { useProjects } from "@/lib/projects/store";
import { IS_TAURI, pickDirectory } from "@/lib/transport";
import { cn, shortPath } from "@/lib/utils";
import { useSwarm } from "@/store";
import { SettingsSection } from "./SettingsPrimitives";

const pathIsFile = (path: string) =>
  invoke<boolean>("path_is_file", { path });

export function MemorySettingsSection() {
  const activeProjectId = useProjects((state) => state.activeProjectId);
  const activeProjectName = useProjects((state) =>
    state.activeProjectId
      ? (state.projects[state.activeProjectId]?.name ?? "")
      : "",
  );
  const [scope, setScope] = useState<"global" | "project">("global");
  const [entries, setEntries] = useState<OrchestratorMemoryEntry[] | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const readToken = useRef(0);
  const [deleting, setDeleting] = useState(false);

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
      .then((directory) => join(directory, file))
      .then(setPath, () => {});
  }, [effectiveScope, activeProjectId]);

  const deleteEntry = (index: number) => {
    if (deleting) return;
    const token = readToken.current;
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

  if (!IS_TAURI) return null;

  const count = entries?.length ?? 0;
  return (
    <SettingsSection label="Memory">
      <p className="text-11 leading-relaxed text-fnt">
        Durable facts the orchestrator chose to remember (preferences,
        corrections, recurring workflows) — injected into every new session.
        Global facts reach every project's Orchestrator; project facts only its
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
          entries.map((entry, index) => (
            <div
              key={`${index}-${entry.text}`}
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
                onClick={() => deleteEntry(index)}
              >
                <Trash2 size={11} />
              </Button>
            </div>
          ))
        )}
      </div>
    </SettingsSection>
  );
}

function BinaryPathInput({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder: string;
  onCommit: (value: string | undefined) => void;
}) {
  const [text, setText] = useState(value);
  const [status, setStatus] = useState<"ok" | "missing" | null>(null);

  useEffect(() => setText(value), [value]);
  useEffect(() => {
    const candidate = value.trim();
    if (!candidate || !IS_TAURI) {
      setStatus(null);
      return;
    }
    let stale = false;
    void pathIsFile(candidate)
      .then((exists) => {
        if (!stale) setStatus(exists ? "ok" : "missing");
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
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => event.key === "Enter" && commit()}
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

export function PathsSettingsSection() {
  const settings = useSwarm((state) => state.settings);
  const updateSettings = useSwarm((state) => state.updateSettings);
  const scanRoots = settings.orchestratorScanRoots ?? [];

  return (
    <SettingsSection
      label="Paths"
      sub="Override binaries when they aren't on the PATH the app sees. Leave empty for the defaults."
    >
      <div className="flex flex-col gap-4 pt-1">
        <div>
          <Label>Codex binary</Label>
          <BinaryPathInput
            value={settings.codexPath ?? ""}
            placeholder="codex — resolved by your login shell"
            onCommit={(value) => updateSettings({ codexPath: value })}
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
            onCommit={(value) => updateSettings({ gitPath: value })}
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
            onCommit={(value) => updateSettings({ ghPath: value })}
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
                          (candidate) => candidate !== root,
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
                    void pickDirectory().then((directory) => {
                      if (directory && !scanRoots.includes(directory)) {
                        updateSettings({
                          orchestratorScanRoots: [...scanRoots, directory],
                        });
                      }
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
    </SettingsSection>
  );
}
