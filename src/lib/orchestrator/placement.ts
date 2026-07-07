// Placement planner for the orchestrator's create_panes (layout awareness).
//
// PURE module: a state snapshot of the fleet + the model's wishes go in, a
// deterministic placement plan comes out. The model supplies INTENT (which
// workspace, how to arrange, what to put beside what); this code owns the
// MATH and the guardrails (capacity at a minimum readable pane size, overflow
// into a fresh workspace, keeping same-project panes together). The executor
// (executors.ts) only carries the plan out. Unit-tested via the scratchpad
// harness — no imports beyond the local types below.

import type { Arrangement } from "@/lib/layout";

/** Minimum readable pane size (px). A terminal below this is barely usable:
 * ~48 cols × ~12 rows at a typical font — the floor before we overflow. */
export const MIN_PANE = { w: 380, h: 240 };

export interface PlannerDims {
  w: number;
  h: number;
}

/** One requested pane, reduced to what placement needs. */
export interface PlanSpec {
  /** grouping key — the pane's project (folder basename), or null */
  project: string | null;
  /** targeted split next to an existing pane (bypasses auto-distribution) */
  beside?: { paneId: string; direction: "right" | "below" };
}

export interface WsMeta {
  id: string;
  name: string;
  /** current pane count */
  panes: number;
  /** measured grid size, or null when unmeasured */
  dims: PlannerDims | null;
}

export interface PlanInput {
  /** semantic target: "current" | "new" | an existing workspace name */
  workspace?: string;
  /** legacy id-based target (used when `workspace` is absent) */
  workspaceId?: string;
  arrangement?: Arrangement;
  activeWorkspaceId: string;
  workspaces: WsMeta[];
  /** dims a brand-new workspace would render at (= the active grid) */
  newWorkspaceDims: PlannerDims | null;
  specs: PlanSpec[];
  min?: { w: number; h: number };
}

/** One workspace's slice of the plan. */
export interface PlanBucket {
  ref: { kind: "existing"; id: string } | { kind: "new"; name?: string };
  arrangement: "rows" | "columns" | "grid";
  /** indices into PlanInput.specs, in original order */
  indices: number[];
}

export interface BesidePlacement {
  index: number;
  targetPaneId: string;
  direction: "right" | "below";
}

export interface PlacementPlan {
  buckets: PlanBucket[];
  beside: BesidePlacement[];
  summary: string;
  /** set when the workspace param could not be resolved */
  error?: string;
}

/** Concrete arrangement for `count` panes given the container aspect. */
export function resolveArrangement(
  count: number,
  dims: PlannerDims | null,
): "rows" | "columns" | "grid" {
  if (count <= 1) return "columns";
  const aspect = dims && dims.h > 0 ? dims.w / dims.h : 1.6;
  if (count <= 3) return aspect >= 1 ? "columns" : "rows";
  return "grid";
}

/**
 * How many panes fit in `dims` without any dropping below `min`, for the
 * resolved arrangement. Unmeasured dims → Infinity (no overflow, i.e. the old
 * behavior). `total` seeds the auto arrangement choice.
 */
export function capacityFor(
  dims: PlannerDims | null,
  arrangement: Arrangement,
  total: number,
  min = MIN_PANE,
): number {
  if (!dims || dims.w <= 0 || dims.h <= 0) return Infinity;
  const cols = Math.max(1, Math.floor(dims.w / min.w));
  const rows = Math.max(1, Math.floor(dims.h / min.h));
  const mode = arrangement === "auto" ? resolveArrangement(total, dims) : arrangement;
  if (mode === "columns") return cols; // one row of columns
  if (mode === "rows") return rows; // one column of rows
  return cols * rows; // grid
}

/** Group spec indices by project, preserving first-appearance order. */
function groupByProject(indices: number[], specs: PlanSpec[]): number[][] {
  const groups: number[][] = [];
  const byKey = new Map<string, number[]>();
  for (const i of indices) {
    const key = specs[i].project ?? `__ungrouped_${i}`;
    let g = byKey.get(key);
    if (!g) {
      g = [];
      byKey.set(key, g);
      groups.push(g);
    }
    g.push(i);
  }
  return groups;
}

/** Name suggestion for an overflow workspace: its single project, else auto. */
function bucketName(indices: number[], specs: PlanSpec[]): string | undefined {
  const projects = new Set(indices.map((i) => specs[i].project).filter(Boolean));
  return projects.size === 1 ? [...projects][0] ?? undefined : undefined;
}

/**
 * Plan where each requested pane lands. `beside` specs are echoed straight
 * through (targeted splits, no distribution). The rest are packed into the
 * target workspace up to its capacity, then overflow into fresh workspaces —
 * keeping a project's panes together whenever a whole group fits in a bucket.
 */
export function planPlacement(input: PlanInput): PlacementPlan {
  const specs = input.specs;
  const min = input.min ?? MIN_PANE;
  const arrangementParam: Arrangement = input.arrangement ?? "auto";
  const byId = new Map(input.workspaces.map((w) => [w.id, w] as const));

  // 1. resolve the target workspace
  let target: { kind: "existing"; id: string } | { kind: "new" };
  const wsParam = typeof input.workspace === "string" ? input.workspace.trim() : "";
  if (wsParam) {
    const lower = wsParam.toLowerCase();
    if (lower === "current") {
      target = { kind: "existing", id: input.activeWorkspaceId };
    } else if (lower === "new") {
      target = { kind: "new" };
    } else {
      const match = input.workspaces.find((w) => w.name.toLowerCase() === lower);
      if (!match) {
        const valid = input.workspaces.map((w) => `"${w.name}"`).join(", ");
        return {
          buckets: [],
          beside: [],
          summary: "",
          error: `unknown workspace ${JSON.stringify(wsParam)} — use "current", "new", or an existing name: ${valid || "(none)"}`,
        };
      }
      target = { kind: "existing", id: match.id };
    }
  } else if (typeof input.workspaceId === "string" && input.workspaceId) {
    if (!byId.has(input.workspaceId)) {
      const valid = input.workspaces
        .map((w) => `${w.id} ("${w.name}")`)
        .join(", ");
      return {
        buckets: [],
        beside: [],
        summary: "",
        error: `unknown workspace_id "${input.workspaceId}" — valid workspaces: ${valid}`,
      };
    }
    target = { kind: "existing", id: input.workspaceId };
  } else {
    target = { kind: "existing", id: input.activeWorkspaceId };
  }

  // 2. split off beside specs (targeted, not distributed)
  const beside: BesidePlacement[] = [];
  const autoIdx: number[] = [];
  specs.forEach((s, i) => {
    if (s.beside) {
      beside.push({
        index: i,
        targetPaneId: s.beside.paneId,
        direction: s.beside.direction,
      });
    } else {
      autoIdx.push(i);
    }
  });

  // 3. capacity of the target + a fresh overflow workspace
  const targetMeta = target.kind === "existing" ? byId.get(target.id) : undefined;
  const targetExisting = targetMeta?.panes ?? 0;
  const targetDims =
    target.kind === "existing" ? targetMeta?.dims ?? null : input.newWorkspaceDims;
  const totalAuto = autoIdx.length;
  const targetCap = capacityFor(
    targetDims,
    arrangementParam,
    targetExisting + totalAuto,
    min,
  );
  const freeInTarget = Math.max(0, targetCap - targetExisting);
  const newWsCap = capacityFor(input.newWorkspaceDims, arrangementParam, totalAuto, min);

  // 4. pack groups into buckets (target first, then fresh workspaces)
  interface RawBucket {
    ref: { kind: "existing"; id: string } | { kind: "new" };
    cap: number;
    indices: number[];
  }
  const raw: RawBucket[] = [{ ref: target, cap: freeInTarget, indices: [] }];
  const freshBucket = (): RawBucket => ({ ref: { kind: "new" }, cap: newWsCap, indices: [] });

  for (const group of groupByProject(autoIdx, specs)) {
    let i = 0;
    while (i < group.length) {
      const b = raw[raw.length - 1];
      const room = b.cap - b.indices.length;
      if (room <= 0) {
        raw.push(freshBucket());
        continue;
      }
      const remaining = group.length - i;
      // keep the group whole if it fits in a fresh workspace but not here
      if (remaining > room && remaining <= newWsCap && b.indices.length > 0) {
        raw.push(freshBucket());
        continue;
      }
      const take = Math.min(room, remaining);
      for (let k = 0; k < take; k++) b.indices.push(group[i + k]);
      i += take;
    }
  }

  const usable = raw.filter((b) => b.indices.length > 0);
  const buckets: PlanBucket[] = usable.map((b) => {
    const existing = b.ref.kind === "existing" ? targetExisting : 0;
    const dims = b.ref.kind === "existing" ? targetDims : input.newWorkspaceDims;
    const arrangement =
      arrangementParam === "auto"
        ? resolveArrangement(existing + b.indices.length, dims)
        : (arrangementParam as "rows" | "columns" | "grid");
    return {
      ref:
        b.ref.kind === "existing"
          ? b.ref
          : { kind: "new", name: bucketName(b.indices, specs) },
      arrangement,
      indices: b.indices,
    };
  });

  // 5. plan-level summary (the executor writes the final, actual-count one)
  const overflow = buckets.filter((b) => b.ref.kind === "new").length;
  const parts = buckets.map((b) =>
    b.ref.kind === "existing"
      ? `${b.indices.length} in target workspace`
      : `${b.indices.length} in a new workspace${b.ref.name ? ` «${b.ref.name}»` : ""}`,
  );
  if (beside.length) parts.push(`${beside.length} beside an existing pane`);
  const summary = parts.length
    ? `plan: ${parts.join("; ")}${overflow ? " (overflowed to keep panes readable)" : ""}`
    : "plan: nothing to place";

  return { buckets, beside, summary };
}
