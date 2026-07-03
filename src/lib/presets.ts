import { nanoid } from "nanoid";
import type {
  Agent,
  LayoutNode,
  PresetLayoutNode,
  PresetPaneNode,
  WorkspacePreset,
} from "@/types";

/** All pane templates of a preset, in layout order. */
export function collectPresetPanes(node: PresetLayoutNode): PresetPaneNode[] {
  if (node.type === "pane") return [node];
  return node.children.flatMap(collectPresetPanes);
}

/** True when loading must ask for a folder (some pane inherits its cwd). */
export function presetNeedsFolder(preset: WorkspacePreset): boolean {
  return collectPresetPanes(preset.layout).some((p) => !p.cwd);
}

/**
 * Turn a live workspace grid into a preset layout ("save workspace as
 * preset"). Folders and startup commands are captured as fixed values; agent
 * names only when the user set them deliberately — captured terminal titles
 * are conversation topics, not part of a reusable setup.
 */
export function presetLayoutFromGrid(
  layout: LayoutNode,
  agents: Record<string, Agent>,
): PresetLayoutNode {
  if (layout.type === "pane") {
    const a = agents[layout.agentId];
    return {
      type: "pane",
      id: nanoid(6),
      runtime: a?.runtime,
      cwd: a?.cwd,
      startup: a?.startup ?? "",
      name: a?.renamed ? a.name : undefined,
      profileId: a?.profileId,
      color: a?.color,
    };
  }
  return {
    type: "split",
    direction: layout.direction,
    sizes: [...layout.sizes],
    children: layout.children.map((c) => presetLayoutFromGrid(c, agents)),
  };
}

/** Patch one pane template in place (Settings → Presets editor). */
export function updatePresetPane(
  root: PresetLayoutNode,
  paneId: string,
  patch: Partial<Omit<PresetPaneNode, "type" | "id">>,
): PresetLayoutNode {
  if (root.type === "pane") {
    return root.id === paneId ? { ...root, ...patch } : root;
  }
  return {
    ...root,
    children: root.children.map((c) => updatePresetPane(c, paneId, patch)),
  };
}

/**
 * Remove one pane from a preset layout, collapsing single-child splits —
 * mirrors lib/layout.ts removePaneByAgent. Returns null when the last pane
 * goes (callers should delete the preset instead).
 */
export function removePresetPane(
  root: PresetLayoutNode,
  paneId: string,
): PresetLayoutNode | null {
  if (root.type === "pane") return root.id === paneId ? null : root;
  const children: PresetLayoutNode[] = [];
  const sizes: number[] = [];
  root.children.forEach((c, i) => {
    const kept = removePresetPane(c, paneId);
    if (kept) {
      children.push(kept);
      sizes.push(root.sizes[i] ?? 1);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...root, children, sizes };
}

const pane = (): PresetPaneNode => ({ type: "pane", id: nanoid(6) });
const split = (
  direction: "row" | "column",
  children: PresetLayoutNode[],
  sizes?: number[],
): PresetLayoutNode => ({
  type: "split",
  direction,
  sizes: sizes ?? children.map(() => 1),
  children,
});

/**
 * Starter presets, created once when no `workspacePresets` key exists yet.
 * Plain editable presets — renaming/deleting them sticks (an empty saved
 * list is respected, only a missing key seeds).
 */
export function seedPresets(): WorkspacePreset[] {
  return [
    { id: nanoid(8), name: "Solo", layout: pane() },
    { id: nanoid(8), name: "1×2", layout: split("row", [pane(), pane()]) },
    {
      id: nanoid(8),
      name: "2×2",
      layout: split("column", [
        split("row", [pane(), pane()]),
        split("row", [pane(), pane()]),
      ]),
    },
    {
      id: nanoid(8),
      name: "1+2",
      layout: split(
        "row",
        [pane(), split("column", [pane(), pane()])],
        [60, 40],
      ),
    },
  ];
}
