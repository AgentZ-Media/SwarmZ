import { useEffect, useState } from "react";
import { Folder, FolderOpen } from "lucide-react";
import { pickDirectory } from "@/lib/transport";
import { discoverProjects } from "@/lib/orchestrator/native";
import { closeSession, startSession } from "@/lib/vibe/controller";
import { useVibe } from "@/lib/vibe/session-store";
import { useVibeUi } from "@/lib/vibe/ui-store";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { folderName, shortPath } from "@/lib/utils";
import { AgentPicker } from "@/components/agents/AgentPicker";
import { AgentIdentityMark } from "@/components/agents/AgentIdentity";
import { useAgents } from "@/lib/agents/store";
import type { AgentSummary } from "@/lib/agents/types";
import type { ProjectEntry } from "@/lib/orchestrator/types";
import type { VibeAccess } from "@/types";

const NO_EFFORT = "__default__";

/** A custom agent's access default → the Vibe session's access mode. */
function agentVibeAccess(access: string | undefined): VibeAccess {
  return access === "workspace" ? "workspace" : "full";
}

export function NewVibeSessionDialog() {
  const open = useVibeUi((s) => s.newSessionOpen);
  const setOpen = useVibeUi((s) => s.setNewSessionOpen);

  const [projectDir, setProjectDir] = useState<string | undefined>();
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [access, setAccess] = useState<VibeAccess>("workspace");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<string>(NO_EFFORT);
  const [recents, setRecents] = useState<ProjectEntry[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentSlug, setAgentSlug] = useState<string | undefined>();
  const agentSummary = useAgents((s) =>
    agentSlug ? s.agents?.find((a) => a.slug === agentSlug) : undefined,
  );

  const applyAgentPrefill = (a: AgentSummary) => {
    setAgentSlug(a.slug);
    setAccess(agentVibeAccess(a.defaultAccess));
    if (a.defaultModel) setModel(a.defaultModel);
    if (a.defaultEffort) setEffort(a.defaultEffort);
    setName(a.name);
    setNameEdited(true);
  };

  const onAgent = (a: AgentSummary | null) => {
    if (!a) {
      setAgentSlug(undefined);
      return;
    }
    applyAgentPrefill(a);
  };

  // reset + load recents on the opening edge only
  useEffect(() => {
    if (!open) return;
    setProjectDir(undefined);
    setName("");
    setNameEdited(false);
    setAccess("workspace");
    setModel("");
    setEffort(NO_EFFORT);
    setError(null);
    setCreating(false);
    // opened via the Library "Start" action: preselect the agent + its defaults
    const preSlug = useVibeUi.getState().newSessionAgentSlug;
    setAgentSlug(preSlug ?? undefined);
    if (preSlug) {
      const summary = useAgents.getState().agents?.find((a) => a.slug === preSlug);
      if (summary) applyAgentPrefill(summary);
    }
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
    if (!nameEdited) setName(folderName(dir));
  };

  const pick = async () => {
    const dir = await pickDirectory();
    if (dir) choose(dir);
  };

  const submit = async () => {
    if (creating || !projectDir) return;
    setCreating(true);
    setError(null);
    try {
      await startSession({
        name: name.trim() || folderName(projectDir),
        projectDir,
        access,
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(effort !== NO_EFFORT ? { effort } : {}),
        ...(agentSlug ? { agentSlug } : {}),
      });
      // a freshly created session takes the stage (leave the Conductor)
      useVibeUi.getState().setStageMode("session");
      setOpen(false);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>
            Start a native Codex agent on a project folder.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>Project folder</Label>
            <button
              onClick={pick}
              className="flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-border bg-secondary/60 px-3 text-left text-sm transition-colors hover:border-input"
            >
              {projectDir ? (
                <>
                  <FolderOpen size={14} className="shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-xs text-foreground">
                    {shortPath(projectDir)}
                  </span>
                </>
              ) : (
                <>
                  <Folder size={14} className="shrink-0 text-faint" />
                  <span className="text-faint">Choose folder…</span>
                </>
              )}
            </button>

            {recents.length > 0 && (
              <div className="mt-2 flex flex-col gap-0.5">
                {recents.map((p) => (
                  <button
                    key={p.path}
                    onClick={() => choose(p.path)}
                    className="focus-ring flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                      {p.name}
                    </span>
                    <span className="max-w-[55%] shrink-0 truncate font-mono text-[10px] text-faint">
                      {shortPath(p.path)}
                    </span>
                  </button>
                ))}
              </div>
            )}
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
                  <span className="text-faint">No agent (plain session)</span>
                )}
              </button>
            </AgentPicker>
          </div>

          <div>
            <Label>Session name</Label>
            <Input
              value={name}
              onChange={(e) => {
                setNameEdited(true);
                setName(e.target.value);
              }}
              placeholder="Session name"
              onKeyDown={(e) => e.key === "Enter" && void submit()}
            />
          </div>

          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-secondary/40 px-3 py-2.5">
            <div className="min-w-0">
              <span className="text-sm text-foreground">Workspace sandbox</span>
              <p className="text-[11px] text-faint">
                On: writes stay in the folder, anything outside asks first. Off:
                full access.
              </p>
            </div>
            <Switch
              checked={access === "workspace"}
              onCheckedChange={(on) => setAccess(on ? "workspace" : "full")}
              label="Workspace sandbox"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Model (optional)</Label>
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="codex default"
                className="font-mono text-xs"
              />
            </div>
            <div>
              <Label>Reasoning</Label>
              <Select value={effort} onValueChange={setEffort}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_EFFORT}>Default</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
              <p className="break-words font-mono text-[10px] leading-relaxed text-destructive">
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
            {creating ? "Starting…" : "Start session"}
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

  const open = !!id && !!name;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && setId(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close “{name}”?</DialogTitle>
          <DialogDescription>
            This session has a turn running. Closing stops it and ends the
            process — the transcript is discarded.
          </DialogDescription>
        </DialogHeader>
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
            Close session
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
