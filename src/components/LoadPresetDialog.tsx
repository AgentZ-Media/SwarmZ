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
import { Label } from "./ui/input";
import { PresetThumbnail } from "./PresetThumbnail";
import { useSwarm } from "@/store";
import { collectPresetPanes } from "@/lib/presets";
import { shortPath } from "@/lib/utils";

/**
 * Asked once when a preset with inheriting panes loads: pick the folder those
 * panes start in (panes with a fixed folder keep it). Skipped entirely when
 * every pane is pinned — requestLoadPreset applies such presets directly.
 */
export function LoadPresetDialog() {
  const presetId = useSwarm((s) => s.loadPresetRequest);
  const preset = useSwarm((s) =>
    s.workspacePresets.find((p) => p.id === s.loadPresetRequest),
  );
  const setLoadPresetRequest = useSwarm((s) => s.setLoadPresetRequest);
  const applyPreset = useSwarm((s) => s.applyPreset);
  const workspace = useSwarm((s) => s.workspaces[s.activeWorkspaceId]);
  const settings = useSwarm((s) => s.settings);

  const [cwd, setCwd] = useState<string | undefined>();

  useEffect(() => {
    if (presetId) setCwd(workspace?.defaultCwd ?? settings.lastCwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetId]);

  if (!preset) return null;

  const panes = collectPresetPanes(preset.layout);
  const inheriting = panes.filter((p) => !p.cwd).length;

  const pickFolder = async () => {
    const selected = await pickDirectory();
    if (selected) setCwd(selected);
  };

  const submit = () => applyPreset(preset.id, cwd);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) setLoadPresetRequest(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Load “{preset.name}”</DialogTitle>
          <DialogDescription>
            {inheriting === panes.length
              ? `All ${panes.length} agents start in this folder.`
              : `${inheriting} of ${panes.length} agents inherit this folder — the rest keep their fixed one.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-4">
          <PresetThumbnail
            layout={preset.layout}
            className="h-16 w-24 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <Label>Working directory</Label>
            <div className="flex items-center gap-1.5">
              <button
                onClick={pickFolder}
                className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-secondary/60 px-3 text-left text-sm transition-colors hover:border-input"
              >
                {cwd ? (
                  <>
                    <FolderOpen
                      size={14}
                      className="shrink-0 text-muted-foreground"
                    />
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
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setLoadPresetRequest(null)}>
            Cancel
          </Button>
          <Button onClick={submit}>
            Launch {panes.length} agent{panes.length === 1 ? "" : "s"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
