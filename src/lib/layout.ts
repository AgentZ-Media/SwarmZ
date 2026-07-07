import { nanoid } from "nanoid";
import type { LayoutNode, PaneNode, SplitNode } from "@/types";

export const newPane = (agentId: string): PaneNode => ({
  type: "pane",
  id: nanoid(8),
  agentId,
});

export function collectPanes(node: LayoutNode | null): PaneNode[] {
  if (!node) return [];
  if (node.type === "pane") return [node];
  return node.children.flatMap(collectPanes);
}

export function findPaneByAgent(
  node: LayoutNode | null,
  agentId: string,
): PaneNode | null {
  return collectPanes(node).find((p) => p.agentId === agentId) ?? null;
}

/**
 * Split the pane `targetPaneId` into two, inserting a new pane for `newAgentId`.
 * If the target sits inside a split of the same direction, the new pane is added
 * as a sibling (tmux-style) instead of nesting a fresh split.
 */
export function splitPane(
  root: LayoutNode,
  targetPaneId: string,
  newAgentId: string,
  direction: "row" | "column",
): LayoutNode {
  const created = newPane(newAgentId);

  function recurse(node: LayoutNode, parent: SplitNode | null): LayoutNode {
    if (node.type === "pane") {
      if (node.id !== targetPaneId) return node;
      // If parent is a split of the same direction, the caller handles sibling
      // insertion; here we always wrap into a new split.
      if (parent && parent.direction === direction) {
        return node; // handled by parent-level insertion below
      }
      const split: SplitNode = {
        type: "split",
        id: nanoid(8),
        direction,
        sizes: [50, 50],
        children: [node, created],
      };
      return split;
    }

    // split node
    if (node.direction === direction) {
      const idx = node.children.findIndex(
        (c) => c.type === "pane" && c.id === targetPaneId,
      );
      if (idx >= 0) {
        const children = [...node.children];
        children.splice(idx + 1, 0, created);
        const avg =
          node.sizes.reduce((a, b) => a + b, 0) / node.sizes.length || 50;
        const sizes = [...node.sizes];
        // give the new pane an equal-ish share by halving its neighbour
        const half = node.sizes[idx] / 2;
        sizes[idx] = half;
        sizes.splice(idx + 1, 0, half || avg);
        return { ...node, children, sizes };
      }
    }
    return {
      ...node,
      children: node.children.map((c) => recurse(c, node)),
    };
  }

  return recurse(root, null);
}

/** Remove a pane by agentId, collapsing now-single-child splits. */
export function removePaneByAgent(
  root: LayoutNode | null,
  agentId: string,
): LayoutNode | null {
  if (!root) return null;
  if (root.type === "pane") return root.agentId === agentId ? null : root;

  function recurse(node: SplitNode): LayoutNode | null {
    const kept: LayoutNode[] = [];
    const keptSizes: number[] = [];
    node.children.forEach((child, i) => {
      if (child.type === "pane") {
        if (child.agentId !== agentId) {
          kept.push(child);
          keptSizes.push(node.sizes[i] ?? 50);
        }
      } else {
        const r = recurse(child);
        if (r) {
          kept.push(r);
          keptSizes.push(node.sizes[i] ?? 50);
        }
      }
    });
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0];
    const total = keptSizes.reduce((a, b) => a + b, 0) || 1;
    const sizes = keptSizes.map((s) => (s / total) * 100);
    return { ...node, children: kept, sizes };
  }

  return recurse(root);
}

/** Drop target when dragging a pane: center swaps, edges dock the pane to that side. */
export type DropZone = "center" | "left" | "right" | "top" | "bottom";

// ---- Geometry: layout tree → pane/divider rects (percent of the container) ----

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface PaneRect {
  paneId: string;
  agentId: string;
  rect: Rect;
}
export interface HandleRect {
  splitId: string;
  index: number; // boundary between child index and index+1
  direction: "row" | "column";
  /** position of the divider bar, in percent of the container */
  pos: { x: number; y: number; span: number };
  /** the parent split's extent along the drag axis, in percent of container */
  regionPercent: number;
  sizes: number[];
}

/** Walk the tree and collect pane rects (and divider handles) in percent. */
export function computeLayout(
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

/** Pane rects of a full layout, in percent of the container. */
export function paneRects(node: LayoutNode | null): PaneRect[] {
  if (!node) return [];
  const panes: PaneRect[] = [];
  computeLayout(node, { x: 0, y: 0, w: 100, h: 100 }, panes, []);
  return panes;
}

/** Insert an existing pane next to `targetPaneId` (tmux-style sibling insertion
 *  when the parent split already runs in `direction`, otherwise wrap in a new split). */
function insertPaneBeside(
  root: LayoutNode,
  targetPaneId: string,
  pane: PaneNode,
  direction: "row" | "column",
  before: boolean,
): LayoutNode {
  function recurse(node: LayoutNode, parent: SplitNode | null): LayoutNode {
    if (node.type === "pane") {
      if (node.id !== targetPaneId) return node;
      if (parent && parent.direction === direction) {
        return node; // sibling insertion handled at the parent level below
      }
      const split: SplitNode = {
        type: "split",
        id: nanoid(8),
        direction,
        sizes: [50, 50],
        children: before ? [pane, node] : [node, pane],
      };
      return split;
    }

    if (node.direction === direction) {
      const idx = node.children.findIndex(
        (c) => c.type === "pane" && c.id === targetPaneId,
      );
      if (idx >= 0) {
        const children = [...node.children];
        const sizes = [...node.sizes];
        const half = (sizes[idx] ?? 50) / 2;
        sizes[idx] = half;
        const at = before ? idx : idx + 1;
        children.splice(at, 0, pane);
        sizes.splice(at, 0, half || 50);
        return { ...node, children, sizes };
      }
    }
    return {
      ...node,
      children: node.children.map((c) => recurse(c, node)),
    };
  }

  return recurse(root, null);
}

/**
 * Move `srcPaneId` onto `targetPaneId`: "center" swaps the two panes in place,
 * edge zones detach the source pane and dock it to that side of the target.
 * Pane nodes (ids + agentIds) are preserved, so panes never remount.
 */
export function movePane(
  root: LayoutNode,
  srcPaneId: string,
  targetPaneId: string,
  zone: DropZone,
): LayoutNode {
  if (srcPaneId === targetPaneId) return root;
  const panes = collectPanes(root);
  const src = panes.find((p) => p.id === srcPaneId);
  const target = panes.find((p) => p.id === targetPaneId);
  if (!src || !target) return root;

  if (zone === "center") {
    const swap = (node: LayoutNode): LayoutNode => {
      if (node.type === "pane") {
        if (node.id === srcPaneId) return target;
        if (node.id === targetPaneId) return src;
        return node;
      }
      return { ...node, children: node.children.map(swap) };
    };
    return swap(root);
  }

  const without = removePaneByAgent(root, src.agentId);
  if (!without) return root;
  const direction = zone === "left" || zone === "right" ? "row" : "column";
  const before = zone === "left" || zone === "top";
  return insertPaneBeside(without, targetPaneId, src, direction, before);
}

export function setSplitSizes(
  root: LayoutNode,
  splitId: string,
  sizes: number[],
): LayoutNode {
  function recurse(node: LayoutNode): LayoutNode {
    if (node.type === "pane") return node;
    if (node.id === splitId) return { ...node, sizes };
    return { ...node, children: node.children.map(recurse) };
  }
  return recurse(root);
}

// ---- Balanced layout builders (orchestrator create_panes) --------------------
//
// Pure tree constructors used ONLY by the orchestrator's create_panes executor
// to lay out a freshly-created batch of panes with EQUAL sizes (fixing the
// "each new pane smaller than the last" split cascade). Hand-split/drag paths
// (splitPane/movePane/setSplitSizes) are untouched.

/** How a batch of new panes is arranged among themselves. */
export type Arrangement = "auto" | "rows" | "columns" | "grid";

/** Equal flex weights for `n` children (computeLayout divides by the sum). */
function equalSizes(n: number): number[] {
  return Array.from({ length: n }, () => 100 / n);
}

/** A split of the children, or the single child unwrapped. */
function splitOf(direction: "row" | "column", children: LayoutNode[]): LayoutNode {
  if (children.length === 1) return children[0];
  return {
    type: "split",
    id: nanoid(8),
    direction,
    sizes: equalSizes(children.length),
    children,
  };
}

/**
 * Pick a concrete arrangement for `count` panes given the container aspect
 * (w/h): a few panes tile along the long axis, more panes go to a grid.
 */
export function autoArrangement(
  count: number,
  aspect: number,
): "rows" | "columns" | "grid" {
  if (count <= 1) return "columns";
  if (count <= 3) return aspect >= 1 ? "columns" : "rows";
  return "grid";
}

/**
 * Build a balanced layout subtree for a set of agents with EQUAL sizes.
 * `columns` = side by side (row split), `rows` = stacked (column split),
 * `grid` = rows of columns (ceil(√n) per row). Returns null for an empty set.
 */
export function buildArrangement(
  agentIds: string[],
  arrangement: Arrangement,
  aspect: number,
): LayoutNode | null {
  const ids = agentIds.filter((id) => !!id);
  if (ids.length === 0) return null;
  if (ids.length === 1) return newPane(ids[0]);
  const mode =
    arrangement === "auto" ? autoArrangement(ids.length, aspect) : arrangement;
  const leaves = ids.map(newPane);
  if (mode === "columns") return splitOf("row", leaves);
  if (mode === "rows") return splitOf("column", leaves);
  // grid: rows (stacked) of columns (side by side)
  const cols = Math.ceil(Math.sqrt(ids.length));
  const rows: LayoutNode[] = [];
  for (let i = 0; i < leaves.length; i += cols) {
    rows.push(splitOf("row", leaves.slice(i, i + cols)));
  }
  return splitOf("column", rows);
}

/**
 * Graft a freshly-built block `added` beside an untouched `existing` layout,
 * proportioned by pane count so panes stay ~equal across the boundary. Wide
 * containers dock the block to the right (row), tall ones below (column).
 */
export function combineLayouts(
  existing: LayoutNode,
  added: LayoutNode,
  aspect: number,
): LayoutNode {
  const ec = collectPanes(existing).length || 1;
  const ac = collectPanes(added).length || 1;
  const direction = aspect >= 1 ? "row" : "column";
  return {
    type: "split",
    id: nanoid(8),
    direction,
    sizes: [ec, ac],
    children: [existing, added],
  };
}
