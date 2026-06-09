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
