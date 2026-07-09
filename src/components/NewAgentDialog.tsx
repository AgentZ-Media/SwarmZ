import { useEffect, useRef, useState } from "react";
import { Dices, Folder, FolderGit2, FolderOpen, X } from "lucide-react";
import { fetchGitInfo, IS_TAURI, pickDirectory } from "@/lib/transport";
import { addWorktree, generateBranchName, removeWorktree } from "@/lib/worktree";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input, Label } from "./ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Switch } from "./ui/switch";
import { Tip } from "./ui/tooltip";
import {
  CODEX_READONLY_STARTUP,
  CODEX_WORKSPACE_STARTUP,
  DEFAULT_CODEX_STARTUP,
  DEFAULT_RUNTIME,
  DEFAULT_STARTUP,
  defaultStartupForRuntime,
  useSwarm,
} from "@/store";
import { runtimeFromStartup, shortPath } from "@/lib/utils";
import { AgentPicker } from "./agents/AgentPicker";
import { AgentIdentityMark } from "./agents/AgentIdentity";
import { useAgents } from "@/lib/agents/store";
import { writeAgentCompiled } from "@/lib/agents/api";
import { injectAgentIntoStartup } from "@/lib/agents/startup";
import type { AgentSummary } from "@/lib/agents/types";
import type { AgentRuntime } from "@/types";

/** A custom agent's terminal runtime — "vibe"-default agents fall back to
 * codex here (the terminal has no native-session runtime). */
function agentTerminalRuntime(defaultRuntime: string): AgentRuntime {
  return defaultRuntime === "claude" ? "claude" : "codex";
}

/** Base startup command for a custom agent's runtime + access default (the
 * user can still edit it). Only codex encodes access in its flags. */
function baseStartupForAgent(
  runtime: AgentRuntime,
  access: string | undefined,
): string {
  if (runtime === "claude") return DEFAULT_STARTUP;
  if (runtime === "codex") {
    if (access === "workspace") return CODEX_WORKSPACE_STARTUP;
    if (access === "read-only" || access === "readonly")
      return CODEX_READONLY_STARTUP;
    return DEFAULT_CODEX_STARTUP;
  }
  return "";
}

/**
 * Map the common worktree-creation failures (raw git stderr) to a human
 * sentence that says what to DO; unknown errors fall back to a generic lead.
 * The raw text always stays visible as a smaller secondary line.
 */
function humanizeWorktreeError(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("not a git repository") || s.includes("not a regular git repository"))
    return "This folder isn't inside a git repository — pick a repo folder or turn the worktree option off.";
  if (s.includes("already exists"))
    return "A branch or worktree with this name already exists — pick a different branch name (or reroll one).";
  if (s.includes("is not a valid branch name") || s.includes("branch name is empty"))
    return "That branch name isn't valid — letters, digits, dashes and slashes work best.";
  if (s.includes("failed to run git") || s.includes("no such file"))
    return "Couldn't run git — check the git binary path in Settings → Paths.";
  return "Creating the worktree failed.";
}

export function NewAgentDialog() {
  const open_ = useSwarm((s) => s.newAgentOpen);
  const setOpen = useSwarm((s) => s.setNewAgentOpen);
  const profiles = useSwarm((s) => s.profiles);
  const createAgent = useSwarm((s) => s.createAgent);
  const prefill = useSwarm((s) => s.newAgentPrefill);
  const settings = useSwarm((s) => s.settings);

  const [name, setName] = useState("");
  const [cwd, setCwd] = useState<string | undefined>();
  const [runtime, setRuntime] = useState<AgentRuntime>("claude");
  const [startup, setStartup] = useState(DEFAULT_STARTUP);
  const [profileId, setProfileId] = useState<string | undefined>();
  // custom-agent persona: unset = a plain pane (behaves exactly as before)
  const [agentSlug, setAgentSlug] = useState<string | undefined>();
  const agentSummary = useAgents((s) =>
    agentSlug ? s.agents?.find((a) => a.slug === agentSlug) : undefined,
  );

  // worktree toggle — only offered when the chosen folder is a git repo
  // (repoName: undefined = still checking, null = not a repo)
  const [repoName, setRepoName] = useState<string | null | undefined>();
  const [worktree, setWorktree] = useState(false);
  const [branch, setBranch] = useState("");
  const branchEdited = useRef(false);
  const [copyEnv, setCopyEnv] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // bumped on every open — lets an in-flight worktree creation detect that
  // its dialog session ended (cancel, or cancel + reopen) and roll back
  const openGen = useRef(0);

  /** Preselect an agent + its start defaults (runtime, startup, name). The
   * user can still override every field afterwards. */
  const applyAgentPrefill = (summary: AgentSummary) => {
    const rt = agentTerminalRuntime(summary.defaultRuntime);
    setAgentSlug(summary.slug);
    setRuntime(rt);
    setProfileId(undefined);
    setStartup(baseStartupForAgent(rt, summary.defaultAccess));
    setName(summary.name);
  };

  const onAgent = (summary: AgentSummary | null) => {
    if (!summary) {
      setAgentSlug(undefined);
      return;
    }
    applyAgentPrefill(summary);
  };

  // reset ONLY on the opening edge: inherit from the split-source pane if
  // present, otherwise fall back to the profile's default cwd or the last
  // used folder. Everything is read via getState() so a background store
  // write (settings prune, profile edit) landing while the dialog is open
  // can never wipe what the user already typed.
  useEffect(() => {
    if (!open_) return;
    openGen.current++;
    const s = useSwarm.getState();
    const pre = s.newAgentPrefill;
    const ws = s.workspaces[s.activeWorkspaceId];
    setName("");
    const defaultRuntime = pre?.runtime ?? s.settings.defaultRuntime ?? DEFAULT_RUNTIME;
    const hasExplicitStartup =
      pre?.startup !== undefined || s.settings.defaultStartup !== undefined;
    const nextStartup =
      pre?.startup ??
      s.settings.defaultStartup ??
      defaultStartupForRuntime(defaultRuntime);
    const nextRuntime =
      pre?.runtime ?? (hasExplicitStartup ? runtimeFromStartup(nextStartup) : defaultRuntime);
    const profile =
      (pre?.profileId && s.profiles.find((p) => p.id === pre.profileId)) ||
      s.profiles.find(
        (p) =>
          p.startup === nextStartup &&
          (p.runtime ?? runtimeFromStartup(p.startup)) === nextRuntime,
      ) ||
      (!hasExplicitStartup
        ? s.profiles.find(
            (p) => (p.runtime ?? runtimeFromStartup(p.startup)) === nextRuntime,
          )
        : undefined);
    setProfileId(profile?.id);
    setRuntime(nextRuntime);
    // the configured default command beats the preselected profile's startup —
    // picking a profile by hand still overwrites the field (see onProfile)
    setStartup(nextStartup);
    // opened via the Library "Start" action: preselect the agent + its defaults
    // (the library is already loaded, so the summary is in the cache)
    setAgentSlug(undefined);
    if (pre?.agentSlug) {
      const summary = useAgents.getState().agents?.find((a) => a.slug === pre.agentSlug);
      if (summary) applyAgentPrefill(summary);
      else setAgentSlug(pre.agentSlug);
    }
    // workspace context wins over the generic profile/last-used fallbacks
    setCwd(
      pre?.cwd ?? ws?.defaultCwd ?? profile?.defaultCwd ?? s.settings.lastCwd,
    );
    // splitting a worktree pane preselects the toggle (fresh branch below)
    setWorktree(!!pre?.worktree);
    setBranch("");
    branchEdited.current = false;
    setCopyEnv(true);
    setCreating(false);
    setError(null);
  }, [open_]);

  // is the chosen folder a git repo? (gates the worktree section; the repo
  // root's folder name also prefixes the generated branch names)
  useEffect(() => {
    if (!open_ || !IS_TAURI) return;
    if (!cwd) {
      setRepoName(null);
      return;
    }
    let stale = false;
    setRepoName(undefined);
    fetchGitInfo(cwd, settings.gitPath?.trim() || undefined)
      .then((info) => {
        if (!stale) setRepoName(info?.repo ?? null);
      })
      .catch(() => {
        if (!stale) setRepoName(null);
      });
    return () => {
      stale = true;
    };
  }, [open_, cwd, settings.gitPath]);

  // a fresh random branch whenever the toggle goes on / the repo changes —
  // unless the user already typed their own name
  useEffect(() => {
    if (!open_ || !worktree || !repoName || branchEdited.current) return;
    setBranch(generateBranchName(repoName));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open_, worktree, repoName]);

  const pickFolder = async () => {
    const selected = await pickDirectory();
    if (selected) setCwd(selected);
  };

  const onProfile = (id: string) => {
    setProfileId(id);
    const p = profiles.find((x) => x.id === id);
    if (p) {
      setRuntime(p.runtime ?? runtimeFromStartup(p.startup));
      setStartup(p.startup);
      if (p.defaultCwd) setCwd(p.defaultCwd);
    }
  };

  const onRuntime = (next: AgentRuntime) => {
    setRuntime(next);
    setProfileId(undefined);
    const currentRuntime = runtimeFromStartup(startup);
    if (
      !startup.trim() ||
      startup === DEFAULT_STARTUP ||
      startup === DEFAULT_CODEX_STARTUP ||
      currentRuntime !== next
    ) {
      setStartup(
        defaultStartupForRuntime(next),
      );
    }
  };

  const reroll = () => {
    if (!repoName) return;
    branchEdited.current = false;
    setBranch(generateBranchName(repoName));
  };

  const submit = () => {
    if (creating) return;
    // repo check still in flight: a submit now would silently downgrade the
    // requested worktree to a plain pane on the main checkout — wait
    if (worktree && repoName === undefined && cwd) return;
    void doSubmit();
  };

  const doSubmit = async () => {
    // a persona only rides on the coding-CLI runtimes; a shell stays a shell
    const personaSlug =
      agentSlug && (runtime === "claude" || runtime === "codex")
        ? agentSlug
        : undefined;
    // compile + write the agent's .compiled.md and inject the runtime-specific
    // flag onto the startup (a no-op without an agent — the plain path is
    // byte-for-byte what it was before)
    let startupToUse = startup;
    if (personaSlug) {
      setCreating(true);
      setError(null);
      try {
        const path = await writeAgentCompiled(personaSlug);
        startupToUse = injectAgentIntoStartup(startup, runtime, path);
      } catch (e) {
        setError(String(e).replace(/^Error:\s*/, ""));
        setCreating(false);
        return;
      }
    }

    if (!worktree || !repoName || !cwd) {
      createAgent(
        { name, runtime, cwd, startup: startupToUse, profileId, agentSlug: personaSlug },
        prefill?.direction ?? "row",
      );
      return;
    }
    // worktree flow: create it first, then spawn the agent inside it
    setCreating(true);
    setError(null);
    const gitBin = settings.gitPath?.trim() || undefined;
    const gen = openGen.current;
    await (async () => {
      // "still this dialog session": open, and not closed + reopened while
      // the worktree was being created (a fresh session must not receive a
      // stale agent with the old inputs)
      const sameSession = () =>
        useSwarm.getState().newAgentOpen && openGen.current === gen;
      try {
        const info = await addWorktree({
          cwd,
          branch: branch.trim(),
          copyEnv,
          gitBin,
        });
        // the user may have cancelled while the worktree was being created —
        // don't spawn a pane they no longer want, clean the worktree up again
        if (!sameSession()) {
          void removeWorktree({
            root: info.root,
            path: info.path,
            branch: info.branch,
            gitBin,
          }).catch(() => {});
          return;
        }
        createAgent(
          {
            name,
            cwd: info.path,
            startup: startupToUse,
            runtime,
            profileId,
            agentSlug: personaSlug,
            worktree: { root: info.root, branch: info.branch },
          },
          prefill?.direction ?? "row",
        );
      } catch (e) {
        if (sameSession()) {
          // our commands reject with plain strings; a real Error would
          // stringify as "Error: …" — strip the prefix either way
          setError(String(e).replace(/^Error:\s*/, ""));
          setCreating(false);
        }
      }
    })();
  };

  const title =
    prefill?.direction === "column"
      ? "Split down"
      : prefill?.direction === "row"
        ? "Split right"
        : "New Agent";

  return (
    <Dialog open={open_} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Spawn a terminal running the chosen agent profile.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>Name</Label>
            <Input
              placeholder="Agent name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>

          <div>
            <Label>Agent</Label>
            <AgentPicker value={agentSlug ?? null} onChange={onAgent}>
              <button
                type="button"
                className="flex h-9 w-full items-center gap-2 rounded-md border border-border bg-secondary/60 px-3 text-left text-sm transition-colors hover:border-input"
              >
                {agentSummary ? (
                  <>
                    <AgentIdentityMark summary={agentSummary} size={14} />
                    <span className="min-w-0 truncate text-foreground">
                      {agentSummary.name}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">
                      {agentSummary.role || "agent"}
                    </span>
                  </>
                ) : (
                  <span className="text-faint">No agent (plain pane)</span>
                )}
              </button>
            </AgentPicker>
            {agentSummary && (
              <p className="mt-1.5 text-[11px] text-faint">
                Its persona is injected at launch via{" "}
                <code className="font-mono text-muted-foreground">
                  {runtime === "claude"
                    ? "--append-system-prompt-file"
                    : "developer_instructions"}
                </code>
                .
              </p>
            )}
          </div>

          <div>
            <Label>Agent runtime</Label>
            <Select value={runtime} onValueChange={(v) => onRuntime(v as AgentRuntime)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Claude Code</SelectItem>
                <SelectItem value="codex">ChatGPT Codex CLI</SelectItem>
                <SelectItem value="shell">Plain shell</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Profile</Label>
            <Select value={profileId} onValueChange={onProfile}>
              <SelectTrigger>
                <SelectValue placeholder="Select a profile" />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: p.color }}
                      />
                      {p.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Working directory</Label>
            <div className="flex items-center gap-1.5">
              <button
                onClick={pickFolder}
                className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-secondary/60 px-3 text-left text-sm transition-colors hover:border-input"
              >
                {cwd ? (
                  <>
                    <FolderOpen size={14} className="shrink-0 text-muted-foreground" />
                    <span className="truncate font-mono text-xs text-foreground">
                      {shortPath(cwd)}
                    </span>
                  </>
                ) : (
                  <>
                    <Folder size={14} className="shrink-0 text-faint" />
                    <span className="text-faint">
                      Home directory (click to choose…)
                    </span>
                  </>
                )}
              </button>
              {cwd && (
                <button
                  onClick={() => setCwd(undefined)}
                  title="Reset to home directory"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-faint transition-colors hover:border-input hover:text-foreground"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          {/* worktree section — only when the folder is inside a git repo */}
          {IS_TAURI && !!repoName && (
            <div className="rounded-md border border-border bg-secondary/40 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm text-foreground">
                  <FolderGit2 size={14} className="shrink-0 text-muted-foreground" />
                  Work in a git worktree
                </span>
                <Switch
                  checked={worktree}
                  onCheckedChange={setWorktree}
                  label="Work in a git worktree"
                />
              </div>
              <p className="mt-1 text-[11px] text-faint">
                Own branch + folder under{" "}
                <code className="font-mono text-muted-foreground">
                  {repoName}/.worktrees/
                </code>{" "}
                — several agents can change the same repo in parallel.
              </p>

              {worktree && (
                <div className="mt-3 space-y-3">
                  <div>
                    <Label>Branch</Label>
                    <div className="flex items-center gap-1.5">
                      <Input
                        value={branch}
                        onChange={(e) => {
                          branchEdited.current = true;
                          setBranch(e.target.value);
                        }}
                        className="font-mono text-xs"
                        placeholder="branch name"
                        onKeyDown={(e) => e.key === "Enter" && submit()}
                      />
                      <Tip label="New random name">
                        <button
                          onClick={reroll}
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-faint transition-colors hover:border-input hover:text-foreground"
                        >
                          <Dices size={14} />
                        </button>
                      </Tip>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="text-sm text-foreground">
                        Copy environment
                      </span>
                      <p className="text-[11px] text-faint">
                        Brings untracked files (.env, local configs, …) along.
                        Caches like node_modules are skipped.
                      </p>
                    </div>
                    <Switch
                      checked={copyEnv}
                      onCheckedChange={setCopyEnv}
                      label="Copy environment"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          <div>
            <Label>Startup command</Label>
            <Input
              value={startup}
              onChange={(e) => {
                const value = e.target.value;
                setStartup(value);
                setRuntime(runtimeFromStartup(value));
                setProfileId(undefined);
              }}
              className="font-mono text-xs"
              placeholder="(leave empty for a plain shell)"
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <p className="mt-1.5 text-[11px] text-faint">
              Typed into a login shell on launch. Runtime path overrides apply
              to leading{" "}
              <code className="font-mono text-muted-foreground">claude</code>{" "}
              or <code className="font-mono text-muted-foreground">codex</code>.
            </p>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
              <p className="text-[11px] leading-relaxed text-destructive">
                {humanizeWorktreeError(error)}
              </p>
              <p className="mt-1 break-words font-mono text-[10px] leading-relaxed text-destructive/70">
                {error}
              </p>
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={
              creating ||
              // repo check in flight with the toggle on — see submit()
              (worktree && repoName === undefined && !!cwd) ||
              (worktree && !!repoName && !branch.trim())
            }
          >
            {creating ? "Creating worktree…" : "Launch agent"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
