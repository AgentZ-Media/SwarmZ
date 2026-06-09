import { useEffect, useState } from "react";
import { ChevronUp, Folder, Home } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/misc";
import { resolveDirectory, subscribePicker } from "@/lib/dirpicker";

interface Listing {
  path: string;
  parent: string | null;
  home: string;
  entries: { name: string; path: string }[];
}

export function WebDirectoryPicker() {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => subscribePicker((o) => {
    setOpen(o);
    if (o) void load();
  }), []);

  const load = async (path?: string) => {
    setLoading(true);
    try {
      const url = path
        ? `/api/fs/list?path=${encodeURIComponent(path)}`
        : "/api/fs/list";
      const r = await fetch(url);
      if (r.ok) setListing(await r.json());
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  const cancel = () => resolveDirectory(undefined);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) cancel();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose a folder</DialogTitle>
        </DialogHeader>

        <div className="mb-2 flex items-center gap-1.5">
          <Button
            size="icon"
            variant="secondary"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && load(listing.parent)}
          >
            <ChevronUp size={15} />
          </Button>
          <Button
            size="icon"
            variant="secondary"
            onClick={() => listing && load(listing.home)}
          >
            <Home size={15} />
          </Button>
          <div className="flex-1 truncate rounded-md border border-border bg-secondary/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
            {listing?.path ?? "…"}
          </div>
        </div>

        <ScrollArea className="h-64 rounded-lg border border-border bg-card">
          <div className="p-1">
            {loading && (
              <div className="px-3 py-6 text-center text-xs text-faint">
                Loading…
              </div>
            )}
            {!loading && listing?.entries.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-faint">
                No sub-folders.
              </div>
            )}
            {!loading &&
              listing?.entries.map((e) => (
                <button
                  key={e.path}
                  onDoubleClick={() => load(e.path)}
                  onClick={() => load(e.path)}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-accent"
                >
                  <Folder size={14} className="shrink-0 text-muted-foreground" />
                  <span className="truncate">{e.name}</span>
                </button>
              ))}
          </div>
        </ScrollArea>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button
            disabled={!listing?.path}
            onClick={() => listing && resolveDirectory(listing.path)}
          >
            Select this folder
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
