import { FileDown } from "lucide-react";
import { useSwarm } from "@/store";
import { cn } from "@/lib/utils";

/**
 * Drop-zone indicator shown over a terminal while an OS file drag is in
 * progress (see lib/dnd.ts). Every terminal advertises itself as a target;
 * the one under the cursor lights up blue. `pointer-events-none` keeps the
 * overlay invisible to elementFromPoint, so hit-testing lands on the
 * terminal below — the `data-file-drop` container.
 */
export function FileDropOverlay({ targetId }: { targetId: string }) {
  const dragging = useSwarm((s) => s.fileDrag !== null);
  const hovered = useSwarm((s) => s.fileDrag?.targetId === targetId);
  if (!dragging) return null;

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md border border-dashed transition-colors",
        hovered ? "border-ring bg-ring/10" : "border-border bg-background/50",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-xs",
          hovered
            ? "border-ring/50 text-foreground"
            : "border-border text-muted-foreground",
        )}
      >
        <FileDown size={14} className={cn(hovered && "text-ring")} />
        Drop file to insert path
      </div>
    </div>
  );
}
