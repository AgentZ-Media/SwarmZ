import { useMemo } from "react";
import { useMissions } from "@/lib/missions/store";
import type { MissionTask } from "@/lib/missions/types";
import { useVibeUi } from "@/lib/vibe/ui-store";
import { cn } from "@/lib/utils";

const NODE_W = 210;
const NODE_H = 58;
const GAP_X = 70;
const GAP_Y = 24;

const STATE: Record<string, { glyph: string; cls: string }> = {
  ready: { glyph: "◆", cls: "text-acc" },
  running: { glyph: "▶", cls: "text-acc" },
  succeeded: { glyph: "✓", cls: "text-ok" },
  needs_human: { glyph: "⚑", cls: "text-attn" },
  blocked: { glyph: "■", cls: "text-attn" },
  failed: { glyph: "×", cls: "text-err" },
  paused: { glyph: "Ⅱ", cls: "text-warn" },
  blocked_by_dependency: { glyph: "◇", cls: "text-fnt" },
  draft: { glyph: "○", cls: "text-fnt" },
};

interface Positioned { task: MissionTask; x: number; y: number; level: number }

function layout(tasks: MissionTask[]): { nodes: Positioned[]; width: number; height: number } {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const levelOf = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const task = byId.get(id);
    const value = task?.dependencyIds.length
      ? 1 + Math.max(...task.dependencyIds.filter((dep) => byId.has(dep)).map(levelOf), -1)
      : 0;
    visiting.delete(id);
    memo.set(id, value);
    return value;
  };
  const buckets = new Map<number, MissionTask[]>();
  tasks.forEach((task) => {
    const level = levelOf(task.id);
    buckets.set(level, [...(buckets.get(level) ?? []), task]);
  });
  const maxRows = Math.max(1, ...[...buckets.values()].map((items) => items.length));
  const nodes: Positioned[] = [];
  for (const [level, items] of buckets) {
    items.sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title));
    const offset = ((maxRows - items.length) * (NODE_H + GAP_Y)) / 2;
    items.forEach((task, row) => nodes.push({ task, level, x: 28 + level * (NODE_W + GAP_X), y: 28 + offset + row * (NODE_H + GAP_Y) }));
  }
  const levels = Math.max(1, ...nodes.map((node) => node.level + 1));
  return { nodes, width: 56 + levels * NODE_W + (levels - 1) * GAP_X, height: 56 + maxRows * NODE_H + (maxRows - 1) * GAP_Y };
}

export function MissionGraph({ missionId }: { missionId: string }) {
  const signature = useMissions((state) => {
    const mission = state.projection.missions[missionId];
    return mission?.taskIds.map((id) => {
      const task = state.projection.tasks[id];
      return task ? `${id}:${task.status}:${task.priority}:${task.dependencyIds.join(",")}` : id;
    }).join("|") ?? "";
  });
  const graph = useMemo(() => {
    const projection = useMissions.getState().projection;
    const mission = projection.missions[missionId];
    const tasks = (mission?.taskIds ?? []).map((id) => projection.tasks[id]).filter((task): task is MissionTask => !!task && !["archived", "cancelled"].includes(task.status));
    return layout(tasks);
  }, [missionId, signature]);
  const positions = new Map(graph.nodes.map((node) => [node.task.id, node]));

  return (
    <div className="dot-grid min-h-0 flex-1 overflow-auto">
      <div className="relative" style={{ width: graph.width, height: graph.height, minWidth: "100%", minHeight: "100%" }}>
        <svg aria-hidden className="pointer-events-none absolute inset-0" width={graph.width} height={graph.height}>
          {graph.nodes.flatMap((node) => node.task.dependencyIds.map((dependencyId) => {
            const from = positions.get(dependencyId);
            if (!from) return null;
            const x1 = from.x + NODE_W;
            const y1 = from.y + NODE_H / 2;
            const x2 = node.x;
            const y2 = node.y + NODE_H / 2;
            const mid = (x1 + x2) / 2;
            return <path key={`${dependencyId}-${node.task.id}`} d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`} fill="none" stroke="var(--line2)" strokeWidth="1.25" />;
          }))}
        </svg>
        {graph.nodes.map((node) => {
          const state = STATE[node.task.status] ?? STATE.draft;
          return (
            <button key={node.task.id} onClick={() => useVibeUi.getState().setSelectedMissionTaskId(node.task.id)} className="focus-ring absolute border border-line2 bg-card px-3 py-2 text-left shadow-lg hover:border-acc/45 hover:bg-pop" style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}>
              <div className="flex items-center gap-2"><span aria-hidden className={cn("font-mono text-10", state.cls)}>{state.glyph}</span><span className="truncate text-11 font-medium text-txt">{node.task.title}</span></div>
              <div className="mt-1.5 flex items-center gap-2 pl-4 font-mono text-10 text-fnt"><span>{node.task.role}</span><span className="ml-auto">P{Math.max(0, 3 - Math.floor(node.task.priority / 26))}</span></div>
            </button>
          );
        })}
        {graph.nodes.length === 0 && <div className="flex h-full items-center justify-center text-12 text-fnt">This mission has no active tasks.</div>}
      </div>
    </div>
  );
}
