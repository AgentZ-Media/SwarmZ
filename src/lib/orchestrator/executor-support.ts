import { invoke } from "@tauri-apps/api/core";
import { appendMemory } from "./memory";
import { cancelTimer, createTimer, listTimers } from "./timers";
import { describeRemaining, resolveFireAt } from "./timers-core";
import type { ConductorPlanDocument, ConductorPlanInfo } from "./types";
import type { ExecutorFamily } from "./executor-types";
import { requireProject } from "./executor-agents";

type SupportTool =
  | "set_timer"
  | "list_timers"
  | "cancel_timer"
  | "write_plan"
  | "list_plans"
  | "read_plan"
  | "remember";

function planWrite(
  projectDir: string,
  title: string,
  markdown: string,
): Promise<ConductorPlanInfo> {
  return invoke<ConductorPlanInfo>("conductor_plan_write", {
    projectDir,
    title,
    markdown,
  });
}

function planList(projectDir: string): Promise<ConductorPlanInfo[]> {
  return invoke<ConductorPlanInfo[]>("conductor_plan_list", { projectDir });
}

function planRead(
  projectDir: string,
  slug: string,
): Promise<ConductorPlanDocument> {
  return invoke<ConductorPlanDocument>("conductor_plan_read", {
    projectDir,
    slug,
  });
}

export const supportExecutors: ExecutorFamily<SupportTool> = {
  set_timer: async (args, ctx) => {
    const { id: projectId } = requireProject(ctx);
    const note = typeof args.note === "string" ? args.note.trim() : "";
    if (!note) throw new Error("note must not be empty");
    const resolved = resolveFireAt(Date.now(), args.delay_seconds, args.at_iso);
    if ("error" in resolved) throw new Error(resolved.error);
    const timer = await createTimer(projectId, note, resolved.at);
    return {
      timer_id: timer.id,
      note: timer.note,
      fires_at: new Date(timer.at).toISOString(),
      remaining: describeRemaining(timer.at, Date.now()),
    };
  },

  list_timers: async (_args, ctx) => {
    const { id: projectId } = requireProject(ctx);
    const now = Date.now();
    return {
      timers: listTimers(projectId).map((timer) => ({
        timer_id: timer.id,
        note: timer.note,
        fires_at: new Date(timer.at).toISOString(),
        remaining: describeRemaining(timer.at, now),
      })),
    };
  },

  cancel_timer: async (args, ctx) => {
    const { id: projectId } = requireProject(ctx);
    const timerId = String(args.timer_id ?? "").trim();
    const timer = await cancelTimer(projectId, timerId);
    return { cancelled: true, timer_id: timer.id, note: timer.note };
  },

  write_plan: async (args, ctx) => {
    const { dir } = requireProject(ctx);
    const info = await planWrite(
      dir,
      String(args.title ?? ""),
      String(args.markdown ?? ""),
    );
    return {
      written: true,
      slug: info.slug,
      path: info.path,
      note: "agents can read this file — reference the path in their briefs",
    };
  },

  list_plans: async (_args, ctx) => {
    const { dir } = requireProject(ctx);
    return { plans: await planList(dir) };
  },

  read_plan: async (args, ctx) => {
    const { dir } = requireProject(ctx);
    return planRead(dir, String(args.slug ?? ""));
  },

  remember: async (args, ctx) => {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) throw new Error("nothing to remember: text must not be empty");
    const requested =
      args.scope === "global" || args.scope === "project"
        ? args.scope
        : undefined;
    const scope = requested ?? (ctx.projectId ? "project" : "global");
    if (scope === "project" && !ctx.projectId)
      throw new Error('no project context for scope "project" — use scope "global"');
    const result = await appendMemory(text, scope, ctx.projectId ?? undefined);
    return { remembered: text, scope, ...result };
  },
};
