import { useEffect, useRef, useState } from "react";
import { FolderOpen, Plus, Trash2, X } from "lucide-react";
import { pickDirectory } from "@/lib/transport";
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
import { DEFAULT_CODEX_STARTUP, DEFAULT_STARTUP, useSwarm } from "@/store";
import { AGENT_COLORS, cn, runtimeFromStartup, shortPath } from "@/lib/utils";
import type { AgentRuntime, Profile } from "@/types";

function runtimeLabel(runtime: AgentRuntime): string {
  if (runtime === "codex") return "Codex";
  if (runtime === "claude") return "Claude";
  return "Shell";
}

export function ProfilesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const profiles = useSwarm((s) => s.profiles);
  const saveProfile = useSwarm((s) => s.saveProfile);
  const deleteProfile = useSwarm((s) => s.deleteProfile);
  const [editing, setEditing] = useState<Profile | null>(null);
  // deleting needs a second click on the armed trash button; auto-disarms
  // after a moment or on pointer-leave
  const [armDelete, setArmDelete] = useState<string | null>(null);
  const disarmTimer = useRef<number | undefined>(undefined);
  const disarm = () => {
    window.clearTimeout(disarmTimer.current);
    setArmDelete(null);
  };
  useEffect(() => () => window.clearTimeout(disarmTimer.current), []);

  const blank = (): Profile => ({
    id: "",
    name: "",
    runtime: "claude",
    startup: DEFAULT_STARTUP,
    color: AGENT_COLORS[profiles.length % AGENT_COLORS.length],
  });

  const current = editing;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Profiles</DialogTitle>
          <DialogDescription>
            Presets for model flags, startup command and working directory.
          </DialogDescription>
        </DialogHeader>

        {!current ? (
          <div className="space-y-1.5">
            {profiles.map((p) => (
              <div
                key={p.id}
                className="group flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2"
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: p.color }}
                />
                <div className="flex-1 overflow-hidden">
                  <div className="truncate text-sm font-medium">{p.name}</div>
                  <div className="truncate font-mono text-[11px] text-faint">
                    {runtimeLabel(p.runtime ?? runtimeFromStartup(p.startup))} ·{" "}
                    {p.startup || "(plain shell)"}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                  Edit
                </Button>
                <button
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
                    armDelete === p.id
                      ? "bg-destructive/15 text-destructive"
                      : "text-faint hover:bg-destructive/15 hover:text-destructive",
                  )}
                  title={
                    armDelete === p.id
                      ? "Click again to delete"
                      : "Delete profile"
                  }
                  onClick={() => {
                    if (armDelete !== p.id) {
                      setArmDelete(p.id);
                      window.clearTimeout(disarmTimer.current);
                      disarmTimer.current = window.setTimeout(
                        () => setArmDelete(null),
                        4000,
                      );
                      return;
                    }
                    disarm();
                    deleteProfile(p.id);
                  }}
                  onPointerLeave={() => {
                    if (armDelete === p.id) disarm();
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <Button
              variant="secondary"
              className="mt-2 w-full"
              onClick={() => setEditing(blank())}
            >
              <Plus size={15} /> New profile
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <Label>Name</Label>
              <Input
                value={current.name}
                onChange={(e) => setEditing({ ...current, name: e.target.value })}
                placeholder="Profile name"
              />
            </div>
            <div>
              <Label>Agent runtime</Label>
              <Select
                value={current.runtime ?? runtimeFromStartup(current.startup)}
                onValueChange={(v) => {
                  const runtime = v as AgentRuntime;
                  setEditing({
                    ...current,
                    runtime,
                    startup:
                      runtime === "codex"
                        ? DEFAULT_CODEX_STARTUP
                        : runtime === "claude"
                          ? DEFAULT_STARTUP
                          : "",
                  });
                }}
              >
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
              <Label>Startup command</Label>
              <Input
                className="font-mono text-xs"
                value={current.startup}
                onChange={(e) =>
                  setEditing({
                    ...current,
                    startup: e.target.value,
                    runtime: runtimeFromStartup(e.target.value),
                  })
                }
                placeholder="claude, codex, or a shell command"
              />
            </div>
            <div>
              <Label>Default working directory (optional)</Label>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={async () => {
                    const sel = await pickDirectory();
                    if (sel) setEditing({ ...current, defaultCwd: sel });
                  }}
                  className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-secondary/60 px-3 text-sm transition-colors hover:border-input"
                >
                  <FolderOpen size={14} className="text-faint" />
                  <span className="truncate font-mono text-xs">
                    {current.defaultCwd ? shortPath(current.defaultCwd) : "None"}
                  </span>
                </button>
                {current.defaultCwd && (
                  <button
                    onClick={() =>
                      setEditing({ ...current, defaultCwd: undefined })
                    }
                    title="Clear default directory"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-faint transition-colors hover:border-input hover:text-foreground"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>
            <div>
              <Label>Color</Label>
              <div className="flex flex-wrap gap-1.5">
                {AGENT_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setEditing({ ...current, color: c })}
                    className="h-6 w-6 rounded-full border-2 transition-transform hover:scale-110"
                    style={{
                      backgroundColor: c,
                      borderColor:
                        current.color === c
                          ? "var(--foreground)"
                          : "transparent",
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="flex justify-between gap-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Back
              </Button>
              <Button
                disabled={!current.name.trim()}
                onClick={() => {
                  saveProfile(current.id ? current : { ...current, id: undefined });
                  setEditing(null);
                }}
              >
                Save profile
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
