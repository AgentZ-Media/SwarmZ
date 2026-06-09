import { useCallback, useRef } from "react";
import { useSwarm } from "@/store";
import { AgentPane } from "./AgentPane";
import type { LayoutNode } from "@/types";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface PaneRect {
  paneId: string;
  agentId: string;
  rect: Rect;
}
interface HandleRect {
  splitId: string;
  index: number; // boundary between child index and index+1
  direction: "row" | "column";
  /** position of the divider bar, in percent of the container */
  pos: { x: number; y: number; span: number };
  /** the parent split's extent along the drag axis, in percent of container */
  regionPercent: number;
  sizes: number[];
}

function computeLayout(
  node: LayoutNode,
  rect: Rect,
  panes: PaneRect[],
  handles: HandleRect[],
) {
  if (node.type === "pane") {
    panes.push({ paneId: node.id, agentId: node.agentId, rect });
    return;
  }
  const total = node.sizes.reduce((a, b) => a + b, 0) || node.children.length;
  let offset = 0;
  node.children.forEach((child, i) => {
    const frac = (node.sizes[i] ?? total / node.children.length) / total;
    const childRect: Rect =
      node.direction === "row"
        ? { x: rect.x + offset * rect.w, y: rect.y, w: frac * rect.w, h: rect.h }
        : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: frac * rect.h };
    computeLayout(child, childRect, panes, handles);
    offset += frac;
    if (i < node.children.length - 1) {
      if (node.direction === "row") {
        handles.push({
          splitId: node.id,
          index: i,
          direction: "row",
          pos: { x: rect.x + offset * rect.w, y: rect.y, span: rect.h },
          regionPercent: rect.w,
          sizes: node.sizes,
        });
      } else {
        handles.push({
          splitId: node.id,
          index: i,
          direction: "column",
          pos: { x: rect.x, y: rect.y + offset * rect.h, span: rect.w },
          regionPercent: rect.h,
          sizes: node.sizes,
        });
      }
    }
  });
}

const GAP = 4; // px gutter between panes

export function TilingGrid() {
  const layout = useSwarm((s) => s.layout);
  const activePaneId = useSwarm((s) => s.activePaneId);
  const setSizes = useSwarm((s) => s.setSizes);
  const containerRef = useRef<HTMLDivElement>(null);

  const startDrag = useCallback(
    (handle: HandleRect, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const container = containerRef.current;
      if (!container) return;
      const bounds = container.getBoundingClientRect();
      const startSizes = [...handle.sizes];
      const total = startSizes.reduce((a, b) => a + b, 0) || 1;
      const i = handle.index;

      // pixel length of the split region along the drag axis
      const pxLen =
        (handle.direction === "row" ? bounds.width : bounds.height) *
        (handle.regionPercent / 100);
      if (pxLen <= 0) return;

      const startPos = handle.direction === "row" ? e.clientX : e.clientY;
      const min = total * 0.08;

      const onMove = (ev: MouseEvent) => {
        const pos = handle.direction === "row" ? ev.clientX : ev.clientY;
        const deltaUnits = ((pos - startPos) / pxLen) * total;
        let a = startSizes[i] + deltaUnits;
        let b = startSizes[i + 1] - deltaUnits;
        if (a < min) {
          b -= min - a;
          a = min;
        }
        if (b < min) {
          a -= min - b;
          b = min;
        }
        const next = [...startSizes];
        next[i] = a;
        next[i + 1] = b;
        setSizes(handle.splitId, next);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor =
        handle.direction === "row" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [setSizes],
  );

  if (!layout) return null;

  const panes: PaneRect[] = [];
  const handles: HandleRect[] = [];
  computeLayout(layout, { x: 0, y: 0, w: 100, h: 100 }, panes, handles);

  return (
    <div ref={containerRef} className="relative h-full w-full">
      {panes.map((p) => (
        <div
          key={p.agentId}
          className="absolute"
          style={{
            left: `${p.rect.x}%`,
            top: `${p.rect.y}%`,
            width: `${p.rect.w}%`,
            height: `${p.rect.h}%`,
            padding: GAP / 2,
          }}
        >
          <AgentPane agentId={p.agentId} active={p.paneId === activePaneId} />
        </div>
      ))}
      {handles.map((h, idx) => (
        <div
          key={`${h.splitId}-${h.index}-${idx}`}
          onMouseDown={(e) => startDrag(h, e)}
          className="group absolute z-10"
          style={
            h.direction === "row"
              ? {
                  left: `calc(${h.pos.x}% - 4px)`,
                  top: `${h.pos.y}%`,
                  width: 8,
                  height: `${h.pos.span}%`,
                  cursor: "col-resize",
                }
              : {
                  left: `${h.pos.x}%`,
                  top: `calc(${h.pos.y}% - 4px)`,
                  width: `${h.pos.span}%`,
                  height: 8,
                  cursor: "row-resize",
                }
          }
        >
          <div
            className={
              h.direction === "row"
                ? "mx-auto h-full w-0.5 rounded bg-transparent transition-colors group-hover:bg-ring/60"
                : "my-auto h-0.5 w-full rounded bg-transparent transition-colors group-hover:bg-ring/60"
            }
          />
        </div>
      ))}
    </div>
  );
}
