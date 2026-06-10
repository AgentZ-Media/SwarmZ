import { useEffect, useState } from "react";
import { Folder, FolderOpen, X } from "lucide-react";
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
import { DEFAULT_STARTUP, useSwarm } from "@/store";
import { shortPath } from "@/lib/utils";

export function NewAgentDialog() {
  const open_ = useSwarm((s) => s.newAgentOpen);
  const setOpen = useSwarm((s) => s.setNewAgentOpen);
  const profiles = useSwarm((s) => s.profiles);
  const createAgent = useSwarm((s) => s.createAgent);
  const prefill = useSwarm((s) => s.newAgentPrefill);
  const settings = useSwarm((s) => s.settings);

  const [name, setName] = useState("");
  const [cwd, setCwd] = useState<string | undefined>();
  const [startup, setStartup] = useState(DEFAULT_STARTUP);
  const [profileId, setProfileId] = useState<string | undefined>();

  // reset on open: inherit from the split-source pane if present, otherwise
  // fall back to the profile's default cwd or the last used folder
  useEffect(() => {
    if (!open_) return;
    setName("");
    const profile =
      (prefill?.profileId &&
        profiles.find((p) => p.id === prefill.profileId)) ||
      profiles[0];
    setProfileId(profile?.id);
    // the configured default command beats the preselected profile's startup —
    // picking a profile by hand still overwrites the field (see onProfile)
    setStartup(
      prefill?.startup ??
        settings.defaultStartup ??
        profile?.startup ??
        DEFAULT_STARTUP,
    );
    setCwd(prefill?.cwd ?? profile?.defaultCwd ?? settings.lastCwd);
  }, [open_, prefill, profiles, settings]);

  const pickFolder = async () => {
    const selected = await pickDirectory();
    if (selected) setCwd(selected);
  };

  const onProfile = (id: string) => {
    setProfileId(id);
    const p = profiles.find((x) => x.id === id);
    if (p) {
      setStartup(p.startup);
      if (p.defaultCwd) setCwd(p.defaultCwd);
    }
  };

  const submit = () => {
    createAgent({ name, cwd, startup, profileId }, prefill?.direction ?? "row");
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
            Spawn a terminal running Claude with the chosen profile.
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

          <div>
            <Label>Startup command</Label>
            <Input
              value={startup}
              onChange={(e) => setStartup(e.target.value)}
              className="font-mono text-xs"
              placeholder="(leave empty for a plain shell)"
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <p className="mt-1.5 text-[11px] text-faint">
              Typed into a login shell on launch. Uses your system{" "}
              <code className="font-mono text-muted-foreground">claude</code>{" "}
              binary.
            </p>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>Launch agent</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
