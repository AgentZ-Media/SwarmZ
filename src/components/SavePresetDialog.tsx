import { useEffect, useState } from "react";
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

/**
 * "Save workspace as preset" (command palette): snapshots the active grid —
 * layout plus each pane's folder, startup command, profile and color — as a
 * reusable preset. Editable afterwards in Settings → Presets.
 */
export function SavePresetDialog() {
  const open = useSwarm((s) => s.savePresetOpen);
  const setOpen = useSwarm((s) => s.setSavePresetOpen);
  const saveWorkspacePreset = useSwarm((s) => s.saveWorkspacePreset);
  const workspace = useSwarm((s) => s.workspaces[s.activeWorkspaceId]);
  const paneCount = useSwarm((s) => {
    let count = 0;
    for (const id of s.order)
      if (s.agents[id]?.workspaceId === s.activeWorkspaceId) count++;
    return count;
  });

  const [name, setName] = useState("");

  useEffect(() => {
    if (open) setName(workspace?.name ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save workspace as preset</DialogTitle>
          <DialogDescription>
            Captures the current grid — {paneCount} pane
            {paneCount === 1 ? "" : "s"} with their folders and startup
            commands. Edit it later in Settings → Presets.
          </DialogDescription>
        </DialogHeader>

        <div>
          <Label>Preset name</Label>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Preset name"
            onKeyDown={(e) => e.key === "Enter" && saveWorkspacePreset(name)}
          />
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => saveWorkspacePreset(name)}>Save preset</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
