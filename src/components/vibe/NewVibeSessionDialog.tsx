import { useEffect, useState } from "react";
import { Dices, Folder, FolderOpen } from "lucide-react";
import { pickDirectory } from "@/lib/transport";
import { discoverProjects } from "@/lib/orchestrator/native";
import {
  closeProjectAndAlign,
  closeSession,
  focusSession,
  sendMessage,
  startSession,
} from "@/lib/vibe/controller";
import { useVibe } from "@/lib/vibe/session-store";
import { pickAgentName } from "@/lib/vibe/names";
import {
  addWorktree,
  generateBranchName,
  removeWorktree,
} from "@/lib/worktree";
import { useProjects } from "@/lib/projects/store";
import { useVibeUi } from "@/lib/vibe/ui-store";
import { useSwarm } from "@/store";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn, folderName, shortPath } from "@/lib/utils";
import type { ProjectEntry } from "@/lib/orchestrator/types";
import type { VibeAccess } from "@/types";

const EFFORTS = ["default", "low", "medium", "high"] as const;

/** All live session names — the generator's strict global collision set. */
function takenSessionNames(): string[] {
  const v = useVibe.getState();
  const taken: string[] = [];
  for (const id of v.order) {
    const s = v.sessions[id]?.session;
    if (s) taken.push(s.name, s.agentName);
  }
  return taken;
}

/**
 * The New-agent dialog (Vibe v3). Project = the active tab by default,
 * generated agent name with 🎲 reroll, runtime is codex (the only one),
 * model/effort/access, an optional git worktree (own branch + folder, reroll)
 * and an optional first prompt that starts the agent working immediately.
 */
export function NewVibeSessionDialog() {
  const open = useVibeUi((s) => s.newSessionOpen);
  const setOpen = useVibeUi((s) => s.setNewSessionOpen);

  const [projectDir, setProjectDir] = useState<string | undefined>();
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [access, setAccess] = useState<VibeAccess>("workspace");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>("default");
  const [worktree, setWorktree] = useState(false);
  const [branch, setBranch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [recents, setRecents] = useState<ProjectEntry[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // reset + load recents on the opening edge only. The folder defaults to
  // the ACTIVE project (⌘T = new agent there); picking another folder
  // opens/reuses that project's tab on create. The name comes prefilled
  // from the agent-name pool (🎲 rerolls).
  useEffect(() => {
    if (!open) return;
    const projects = useProjects.getState();
    const active = projects.activeProjectId
      ? projects.projects[projects.activeProjectId]
      : null;
    setProjectDir(active?.dir);
    setName(pickAgentName(takenSessionNames()));
    setNameEdited(false);
    setAccess("workspace");
    setModel("");
    setEffort("default");
    setWorktree(false);
    setBranch(active?.dir ? generateBranchName(folderName(active.dir)) : "");
    setPrompt("");
    setError(null);
    setCreating(false);
    let stale = false;
    void discoverProjects()
      .then((ps) => {
        if (!stale) setRecents(ps.filter((p) => p.exists).slice(0, 8));
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [open]);

  const choose = (dir: string) => {
    setProjectDir(dir);
    setBranch(generateBranchName(folderName(dir)));
  };

  const reroll = () => {
    setName(pickAgentName([...takenSessionNames(), name]));
    setNameEdited(false);
  };

  const pick = async () => {
    const dir = await pickDirectory();
    if (dir) choose(dir);
  };

  const submit = async () => {
    if (creating || !projectDir) return;
    setCreating(true);
    setError(null);
    // set once addWorktree succeeded — a later failure rolls the fresh
    // worktree back (same contract as the Conductor's spawn_agents path)
    let createdWorktree: { root: string; path: string; branch: string } | null =
      null;
    try {
      // the session always belongs to the PICKED folder's project tab — a
      // worktree only changes the cwd, never the owning project (the same
      // contract as the Conductor's spawn_agents placement)
      const projectId = await useProjects.getState().openProject(projectDir);
      let cwd = projectDir;
      let worktreeMeta: { root: string; branch: string; shared: boolean } | null =
        null;
      if (worktree && branch.trim()) {
        const info = await addWorktree({
          cwd: projectDir,
          branch: branch.trim(),
          copyEnv: true,
          gitBin: useSwarm.getState().settings.gitPath?.trim() || undefined,
        });
        useSwarm.getState().registerWorktreeRepo(info.root);
        cwd = info.path;
        worktreeMeta = { root: info.root, branch: info.branch, shared: false };
        createdWorktree = { root: info.root, path: info.path, branch: info.branch };
      }
      const id = await startSession({
        // the generated (or user-typed) name doubles as the agent identity
        name: name.trim() || undefined,
        projectDir: cwd,
        projectId,
        spawnedBy: "user",
        access,
        worktree: worktreeMeta,
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(effort !== "default" ? { effort } : {}),
      });
      // an optional first prompt starts the lane immediately
      const firstPrompt = prompt.trim();
      if (firstPrompt) void sendMessage(id, firstPrompt);
      // the fresh agent takes the stage
      focusSession(id);
      setOpen(false);
    } catch (e) {
      let msg = String(e).replace(/^Error:\s*/, "");
      if (createdWorktree) {
        // the fresh worktree must not orphan when the session never started —
        // roll it back (clean by construction; the gated non-force removal
        // double-checks that and refuses if anything appeared in it)
        try {
          await removeWorktree({
            root: createdWorktree.root,
            path: createdWorktree.path,
            branch: createdWorktree.branch,
            force: false,
            gitBin: useSwarm.getState().settings.gitPath?.trim() || undefined,
          });
          msg += " (the freshly created worktree was rolled back)";
          // re-scan so a now-empty repo root is pruned from the registry
          // again instead of lingering until the next scan
          void useSwarm.getState().refreshWorktrees();
        } catch {
          msg += ` — and the fresh worktree could not be rolled back; clean it up via the worktree panel: ${createdWorktree.path}`;
        }
      }
      setError(msg);
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[86vh] max-w-[480px] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            Spin up a native Codex agent on a project folder. The Conductor
            will track it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div>
            <Label>Project folder</Label>
            <button
              onClick={pick}
              className={cn(
                "focus-ring flex h-9 w-full min-w-0 items-center gap-2 rounded-md border px-3 text-left transition-colors",
                projectDir && !recents.some((r) => r.path === projectDir)
                  ? "border-acc/50 bg-acc/10"
                  : "border-line bg-card hover:border-line2",
              )}
            >
              {projectDir ? (
                <>
                  <FolderOpen size={14} className="shrink-0 text-mut" />
                  <span className="truncate font-mono text-12 text-txt">
                    {shortPath(projectDir)}
                  </span>
                </>
              ) : (
                <>
                  <Folder size={14} className="shrink-0 text-fnt" />
                  <span className="text-13 text-fnt">Choose folder…</span>
                </>
              )}
            </button>

            {recents.length > 0 && (
              <div className="mt-2 flex flex-col gap-1">
                {recents.map((p) => {
                  const selected = projectDir === p.path;
                  return (
                    <button
                      key={p.path}
                      onClick={() => choose(p.path)}
                      className={cn(
                        "focus-ring flex items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors",
                        selected
                          ? "border-acc/50 bg-acc/10"
                          : "border-line bg-card hover:border-line2",
                      )}
                    >
                      <Folder size={12} className="shrink-0 text-fnt" />
                      <span className="min-w-0 flex-1 truncate text-13 font-medium text-txt">
                        {p.name}
                      </span>
                      <span className="max-w-[52%] shrink-0 truncate font-mono text-10 text-fnt">
                        {shortPath(p.path)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Agent name</Label>
              <div className="flex items-center gap-2">
                <Input
                  value={name}
                  onChange={(e) => {
                    setNameEdited(true);
                    setName(e.target.value);
                  }}
                  placeholder="agent name"
                  onKeyDown={(e) => e.key === "Enter" && void submit()}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={reroll}
                  title="Roll a new name"
                  aria-label="Roll a new name"
                  className="shrink-0"
                >
                  <Dices size={15} />
                </Button>
              </div>
              {!nameEdited && (
                <p className="mt-1 text-10 text-fnt">
                  Auto-generated — edit or 🎲 reroll.
                </p>
              )}
            </div>
            <div>
              <Label>Runtime</Label>
              <div className="flex h-8 items-center justify-center rounded-md border border-acc/50 bg-acc/15 font-mono text-12 text-txt">
                codex
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Model (optional)</Label>
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="codex default"
                className="font-mono text-12"
              />
            </div>
            <div>
              <Label>Reasoning effort</Label>
              <div className="flex gap-1.5">
                {EFFORTS.map((ef) => (
                  <button
                    key={ef}
                    onClick={() => setEffort(ef)}
                    className={cn(
                      "focus-ring h-8 flex-1 rounded-md border font-mono text-11 transition-colors",
                      effort === ef
                        ? "border-acc/50 bg-acc/15 text-txt"
                        : "border-line text-fnt hover:border-line2",
                    )}
                  >
                    {ef === "default" ? "def" : ef}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-card px-3 py-2.5">
            <div className="min-w-0">
              <span className="text-13 font-medium text-txt">
                Workspace sandbox
              </span>
              <p className="text-11 leading-normal text-fnt">
                On: writes stay in the folder, anything outside asks first.
                Off: full access.
              </p>
            </div>
            <Switch
              checked={access === "workspace"}
              onCheckedChange={(on) => setAccess(on ? "workspace" : "full")}
              label="Workspace sandbox"
            />
          </div>

          <div
            className={cn(
              "rounded-lg border border-dashed p-3 transition-colors",
              worktree ? "border-acc/40 bg-acc/[.04]" : "border-line2",
            )}
          >
            {/* Switch + text button are SIBLINGS (no nested interactives) */}
            <div className="flex w-full items-center gap-2">
              <Switch
                checked={worktree}
                onCheckedChange={setWorktree}
                label="Run in a git worktree"
              />
              <button
                onClick={() => setWorktree((w) => !w)}
                className="focus-ring rounded-xs text-left text-13 font-medium text-txt"
              >
                Run in a git worktree
              </button>
              <span className="ml-auto font-mono text-10 text-fnt">
                parallel-safe
              </span>
            </div>
            {worktree && (
              <>
                <div className="mt-2.5 flex items-center gap-1.5">
                  <span aria-hidden className="font-mono text-12 text-fnt">
                    ⎇
                  </span>
                  <Input
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    className="h-7 flex-1 font-mono text-12"
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() =>
                      projectDir &&
                      setBranch(generateBranchName(folderName(projectDir)))
                    }
                    title="Reroll branch name"
                    aria-label="Reroll branch name"
                    className="h-7 w-7 shrink-0"
                  >
                    <Dices size={13} />
                  </Button>
                </div>
                <p className="mt-2 text-11 leading-normal text-fnt">
                  Own branch + folder under .worktrees/ — env files copied,
                  heavyweight caches skipped.
                </p>
              </>
            )}
          </div>

          <div>
            <Label>First prompt (optional)</Label>
            <textarea
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should this agent start on?"
              className="w-full select-text resize-none rounded-md border border-line bg-card px-3 py-2.5 text-12 leading-normal text-txt transition-colors placeholder:text-fnt focus-visible:border-acc/55 focus-visible:outline-none"
            />
          </div>

          {error && (
            <div className="rounded-md border border-err/40 bg-err/10 px-3 py-2">
              <p className="break-words font-mono text-10 leading-relaxed text-err">
                {error}
              </p>
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={creating || !projectDir}>
            {creating ? "Starting…" : "Start agent"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Confirm line for closing a project TAB while sessions are still busy.
 * Closing never blocks and never stops anything — the sessions keep working
 * in the background and the tab reopens with everything intact; the dialog
 * only makes the busy count explicit before hiding them from view.
 */
export function CloseProjectConfirm() {
  const confirm = useVibeUi((s) => s.closeProjectConfirm);
  const setConfirm = useVibeUi((s) => s.setCloseProjectConfirm);
  const name = useProjects((s) =>
    confirm ? (s.projects[confirm.projectId]?.name ?? "") : "",
  );

  const open = !!confirm && !!name;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && setConfirm(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close «{name}»?</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <ContextLine glyph="▸" glyphCls="text-acc" textCls="text-txt">
            {confirm?.busyCount === 1
              ? "1 agent in this project is still working."
              : `${confirm?.busyCount ?? 0} agents in this project are still working.`}
          </ContextLine>
          <ContextLine glyph="·" glyphCls="text-fnt" textCls="text-mut">
            They keep running in the background — closing only hides the tab;
            reopening the folder brings everything back.
          </ContextLine>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirm(null)}>
            Keep it open
          </Button>
          <Button
            onClick={() => {
              // the ONE close path (see closeProjectAndAlign): close the tab
              // AND realign stage/selection when it was the active project
              if (confirm) closeProjectAndAlign(confirm.projectId);
              setConfirm(null);
            }}
          >
            Close tab
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Confirm dialog shown only when closing a busy session (a turn is running). */
export function CloseSessionConfirm() {
  const id = useVibeUi((s) => s.closeConfirmId);
  const setId = useVibeUi((s) => s.setCloseConfirmId);
  const name = useVibe((s) => (id ? s.sessions[id]?.session.name : null));
  const branch = useVibe((s) =>
    id ? (s.sessions[id]?.session.worktree?.branch ?? "") : "",
  );

  const open = !!id && !!name;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && setId(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close «{name}»?</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <ContextLine glyph="■" glyphCls="text-err" textCls="text-txt">
            This agent is mid-turn — closing stops it and ends the process.
          </ContextLine>
          <ContextLine glyph="·" glyphCls="text-fnt" textCls="text-mut">
            The transcript is discarded.
          </ContextLine>
          {branch && (
            <ContextLine glyph="⎇" glyphCls="text-mut" textCls="text-mut">
              Its worktree ({branch}) stays on disk — clean it up via the
              worktree panel.
            </ContextLine>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setId(null)}>
            Keep it
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (id) void closeSession(id);
              setId(null);
            }}
          >
            Stop & close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One glyph + text context row (the reference's close-confirm lines). */
function ContextLine({
  glyph,
  glyphCls,
  textCls,
  children,
}: {
  glyph: string;
  glyphCls: string;
  textCls: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex gap-2 text-12 leading-normal", textCls)}>
      <span aria-hidden className={cn("shrink-0", glyphCls)}>
        {glyph}
      </span>
      <span>{children}</span>
    </div>
  );
}
