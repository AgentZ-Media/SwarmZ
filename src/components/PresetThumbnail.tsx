import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { PresetLayoutNode } from "@/types";

/** Schematic mini-grid of a preset's layout (preset cards, settings list). */
export function PresetThumbnail({
  layout,
  className,
}: {
  layout: PresetLayoutNode;
  className?: string;
}) {
  return (
    <div className={cn("flex overflow-hidden", className)}>
      {renderNode(layout)}
    </div>
  );
}

function renderNode(node: PresetLayoutNode): ReactNode {
  if (node.type === "pane") {
    return (
      <div
        key={node.id}
        className="min-h-0 min-w-0 flex-1 rounded-[2px] border border-border bg-secondary/80"
      />
    );
  }
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 gap-[3px]",
        node.direction === "row" ? "flex-row" : "flex-col",
      )}
    >
      {node.children.map((c, i) => (
        <div
          key={c.type === "pane" ? c.id : i}
          className="flex min-h-0 min-w-0"
          style={{ flexGrow: node.sizes[i] ?? 1, flexBasis: 0 }}
        >
          {renderNode(c)}
        </div>
      ))}
    </div>
  );
}
