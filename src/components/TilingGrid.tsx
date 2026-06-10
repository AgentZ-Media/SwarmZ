import { useCallback, useEffect, useRef, useState } from "react";
import { useSwarm } from "@/store";
import { AgentPane } from "./AgentPane";
import { cn } from "@/lib/utils";
import {
  computeLayout,
  type DropZone,
  type HandleRect,
  type PaneRect,
  type Rect,
} from "@/lib/layout";
import type { LayoutNode } from "@/types";

/** Clone the layout with one split's sizes replaced — used to project the drag preview. */
function withSizes(
  node: LayoutNode,
  splitId: string,
  sizes: number[],
): LayoutNode {
  if (node.type === "pane") return node;
  return {
    ...node,
    sizes: node.id === splitId ? sizes : node.sizes,
    children: node.children.map((c) => withSizes(c, splitId, sizes)),
  };
}

const GAP = 4; // px gutter between panes

// Focus mode: the focused pane zooms to this rect, floating above the dimmed
// grid — everything underneath stays mounted and keeps running.
const FOCUS_RECT: Rect = { x: 2, y: 2.5, w: 96, h: 95 };
const FOCUS_ANIM_MS = 150;

/** Absolute-position style for a percent rect, matching the pane wrappers. */
function rectStyle(rect: Rect): React.CSSProperties {
  return {
    left: `${rect.x}%`,
    top: `${rect.y}%`,
    width: `${rect.w}%`,
    height: `${rect.h}%`,
    padding: GAP / 2,
  };
}

/** NoteZ-style five-zone hit test: 40% center box, corners resolve to the nearest edge. */
function zoneAt(rx: number, ry: number): DropZone {
  if (rx > 0.3 && rx < 0.7 && ry > 0.3 && ry < 0.7) return "center";
  const min = Math.min(rx, 1 - rx, ry, 1 - ry);
  if (min === rx) return "left";
  if (min === 1 - rx) return "right";
  if (min === ry) return "top";
  return "bottom";
}

export function TilingGrid({ workspaceId }: { workspaceId: string }) {
  const layout = useSwarm((s) => s.layouts[workspaceId] ?? null);
  const activePaneId = useSwarm((s) => s.activePaneIds[workspaceId] ?? null);
  const isActiveWs = useSwarm((s) => s.activeWorkspaceId === workspaceId);
  const setSizes = useSwarm((s) => s.setSizes);
  const movePane = useSwarm((s) => s.movePane);
  const focusedAgentId = useSwarm((s) =>
    s.activeWorkspaceId === workspaceId ? s.focusedAgentId : null,
  );
  const setFocusedAgent = useSwarm((s) => s.setFocusedAgent);
  const containerRef = useRef<HTMLDivElement>(null);
  // When focus mode exits, the pane needs to animate back to its grid slot —
  // keep it elevated (and the backdrop fading out) until the transition ends.
  // Set during render (not in an effect) so the transition class is still on
  // the wrapper in the very commit where the rect snaps back.
  const [closingFocusId, setClosingFocusId] = useState<string | null>(null);
  const prevFocusRef = useRef<string | null>(null);
  if (prevFocusRef.current !== focusedAgentId) {
    if (!focusedAgentId && prevFocusRef.current) {
      setClosingFocusId(prevFocusRef.current);
    }
    prevFocusRef.current = focusedAgentId;
  }
  useEffect(() => {
    if (!closingFocusId) return;
    const t = setTimeout(() => setClosingFocusId(null), FOCUS_ANIM_MS + 50);
    return () => clearTimeout(t);
  }, [closingFocusId]);
  // While a divider is dragged, the real layout stays frozen; only this
  // preview updates (rendered as a translucent tile overlay). Committed on mouseup.
  const [preview, setPreview] = useState<{
    splitId: string;
    sizes: number[];
  } | null>(null);
  // Active pane drag (grab a pane header, drop it on another pane). Same
  // deferred pattern: only the drop-zone highlight updates, layout commits on mouseup.
  const [paneDrag, setPaneDrag] = useState<{
    srcPaneId: string;
    targetPaneId: string | null;
    zone: DropZone | null;
  } | null>(null);

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

      let latest: number[] | null = null;
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
        latest = next;
        setPreview({ splitId: handle.splitId, sizes: next });
      };
      const finish = (commit: boolean) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("keydown", onKey);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setPreview(null);
        if (commit && latest) setSizes(workspaceId, handle.splitId, latest);
      };
      const onUp = () => finish(true);
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") finish(false);
      };
      document.body.style.cursor =
        handle.direction === "row" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("keydown", onKey);
    },
    [setSizes, workspaceId],
  );

  /** Mousedown on a pane header: after a small movement threshold this becomes
   *  a pane drag — drop on another pane rearranges, drop on a workspace tab
   *  moves the agent there. Plain clicks (focus, rename, buttons) are unaffected. */
  const startPaneDrag = useCallback(
    (agentId: string, e: React.MouseEvent) => {
      if (e.button !== 0) return;
      // no rearranging while a pane floats above the grid
      if (useSwarm.getState().focusedAgentId) return;
      const container = containerRef.current;
      const root = useSwarm.getState().layouts[workspaceId] ?? null;
      if (!container || !root) return;
      const allPanes: PaneRect[] = [];
      computeLayout(root, { x: 0, y: 0, w: 100, h: 100 }, allPanes, []);
      // a single pane can still be dragged — onto another workspace's tab
      if (allPanes.length < 2 && useSwarm.getState().workspaceOrder.length < 2)
        return;
      const src = allPanes.find((p) => p.agentId === agentId);
      if (!src) return;

      const bounds = container.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      let active = false;
      let target: { paneId: string; zone: DropZone } | null = null;
      let tabTarget: string | null = null;
      let lastKey = "";

      const hitTest = (cx: number, cy: number) => {
        const px = ((cx - bounds.left) / bounds.width) * 100;
        const py = ((cy - bounds.top) / bounds.height) * 100;
        const hit = allPanes.find(
          (p) =>
            px >= p.rect.x &&
            px < p.rect.x + p.rect.w &&
            py >= p.rect.y &&
            py < p.rect.y + p.rect.h,
        );
        if (!hit || hit.paneId === src.paneId) return null;
        return {
          paneId: hit.paneId,
          zone: zoneAt((px - hit.rect.x) / hit.rect.w, (py - hit.rect.y) / hit.rect.h),
        };
      };

      const onMove = (ev: MouseEvent) => {
        if (!active) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
          active = true;
          document.body.style.cursor = "grabbing";
          document.body.style.userSelect = "none";
        }
        // hovering a workspace tab (title bar) beats pane targets
        const tabEl = (
          document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
        )?.closest?.("[data-ws-tab]") as HTMLElement | null;
        tabTarget =
          tabEl && tabEl.dataset.wsTab !== workspaceId
            ? (tabEl.dataset.wsTab ?? null)
            : null;
        useSwarm.getState().setTabDropTarget(tabTarget);
        target = tabTarget ? null : hitTest(ev.clientX, ev.clientY);
        const key = tabTarget
          ? `tab:${tabTarget}`
          : target
            ? `${target.paneId}:${target.zone}`
            : "none";
        if (key !== lastKey) {
          lastKey = key;
          setPaneDrag({
            srcPaneId: src.paneId,
            targetPaneId: target?.paneId ?? null,
            zone: target?.zone ?? null,
          });
        }
      };
      const finish = (commit: boolean) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("keydown", onKey);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setPaneDrag(null);
        useSwarm.getState().setTabDropTarget(null);
        if (commit && active && tabTarget) {
          useSwarm.getState().moveAgentToWorkspace(agentId, tabTarget);
        } else if (commit && active && target) {
          movePane(workspaceId, src.paneId, target.paneId, target.zone);
        }
      };
      const onUp = () => finish(true);
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") finish(false);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("keydown", onKey);
    },
    [movePane, workspaceId],
  );

  if (!layout) return null;

  const panes: PaneRect[] = [];
  const handles: HandleRect[] = [];
  computeLayout(layout, { x: 0, y: 0, w: 100, h: 100 }, panes, handles);

  let previewPanes: PaneRect[] | null = null;
  if (preview) {
    previewPanes = [];
    computeLayout(
      withSizes(layout, preview.splitId, preview.sizes),
      { x: 0, y: 0, w: 100, h: 100 },
      previewPanes,
      [],
    );
  }

  return (
    <div ref={containerRef} className="relative h-full w-full">
      {(focusedAgentId || closingFocusId) && (
        <div
          className={cn(
            "absolute inset-0 z-20 bg-background/70 transition-opacity duration-150",
            focusedAgentId ? "animate-overlay-in opacity-100" : "opacity-0",
          )}
          onMouseDown={() => setFocusedAgent(null)}
        />
      )}
      {panes.map((p) => {
        const focused = p.agentId === focusedAgentId;
        const animating = focused || p.agentId === closingFocusId;
        return (
          <div
            key={p.agentId}
            className={cn(
              "absolute",
              animating &&
                "z-30 transition-[left,top,width,height] duration-150 ease-out",
            )}
            style={rectStyle(focused ? FOCUS_RECT : p.rect)}
          >
            <AgentPane
              agentId={p.agentId}
              // only the active workspace's active pane focuses/blinks —
              // hidden workspaces must never steal keyboard focus
              active={isActiveWs && p.paneId === activePaneId}
              onHeaderDragStart={startPaneDrag}
            />
          </div>
        );
      })}
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
      {previewPanes && (
        <div className="pointer-events-none absolute inset-0 z-20">
          {previewPanes.map((p) => (
            <div key={p.paneId} className="absolute" style={rectStyle(p.rect)}>
              <div className="h-full w-full rounded-lg border border-ring/60 bg-ring/10" />
            </div>
          ))}
        </div>
      )}
      {paneDrag &&
        (() => {
          const src = panes.find((p) => p.paneId === paneDrag.srcPaneId);
          const tgt = paneDrag.targetPaneId
            ? panes.find((p) => p.paneId === paneDrag.targetPaneId)
            : null;
          let zoneRect: Rect | null = null;
          if (tgt && paneDrag.zone) {
            const r = tgt.rect;
            zoneRect =
              paneDrag.zone === "center"
                ? r
                : paneDrag.zone === "left"
                  ? { x: r.x, y: r.y, w: r.w / 2, h: r.h }
                  : paneDrag.zone === "right"
                    ? { x: r.x + r.w / 2, y: r.y, w: r.w / 2, h: r.h }
                    : paneDrag.zone === "top"
                      ? { x: r.x, y: r.y, w: r.w, h: r.h / 2 }
                      : { x: r.x, y: r.y + r.h / 2, w: r.w, h: r.h / 2 };
          }
          return (
            <div className="pointer-events-none absolute inset-0 z-20">
              {src && (
                <div className="absolute" style={rectStyle(src.rect)}>
                  <div className="h-full w-full rounded-lg bg-background/60" />
                </div>
              )}
              {zoneRect && (
                <div className="absolute" style={rectStyle(zoneRect)}>
                  <div className="flex h-full w-full items-center justify-center rounded-lg border border-ring/60 bg-ring/10">
                    <span className="rounded-md bg-popover px-2 py-0.5 text-[11px] text-muted-foreground shadow-sm">
                      {paneDrag.zone === "center" ? "Swap" : "Dock"}
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })()}
    </div>
  );
}
