import { useState } from "react";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
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
import { useSwarm } from "@/store";
import { AGENT_COLORS, shortPath } from "@/lib/utils";
import type { Profile } from "@/types";

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

  const blank = (): Profile => ({
    id: "",
    name: "",
    startup: "claude --dangerously-skip-permissions",
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
                    {p.startup || "(plain shell)"}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                  Edit
                </Button>
                <button
                  className="flex h-7 w-7 items-center justify-center rounded-md text-faint hover:bg-destructive/15 hover:text-destructive"
                  onClick={() => deleteProfile(p.id)}
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
              <Label>Startup command</Label>
              <Input
                className="font-mono text-xs"
                value={current.startup}
                onChange={(e) =>
                  setEditing({ ...current, startup: e.target.value })
                }
                placeholder="claude --dangerously-skip-permissions"
              />
            </div>
            <div>
              <Label>Default working directory (optional)</Label>
              <button
                onClick={async () => {
                  const sel = await pickDirectory();
                  if (sel) setEditing({ ...current, defaultCwd: sel });
                }}
                className="flex h-9 w-full items-center gap-2 rounded-md border border-border bg-secondary/60 px-3 text-sm transition-colors hover:border-input"
              >
                <FolderOpen size={14} className="text-faint" />
                <span className="truncate font-mono text-xs">
                  {current.defaultCwd ? shortPath(current.defaultCwd) : "None"}
                </span>
              </button>
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
