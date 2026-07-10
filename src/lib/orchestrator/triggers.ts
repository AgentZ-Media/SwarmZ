// Autonomous trigger router — the STATEFUL wiring of the Phase-5 autonomy
// loop (the pure core lives in ./triggers-core.ts). This module owns ONE
// router instance with the real dependencies:
//
//   eligibility — the projects store: not yet hydrated = retry (a load race
//     must never eat a trigger), record gone = drop, and the EVENT kinds
//     (agent-finished / agent-blocked / idle) stay quiet for CLOSED tabs
//     (the status ping still lands in the chat; the user reads it on reopen).
//     Timers and approval escalations keep delivering into closed projects —
//     a timer is an explicit promise and a routine approval blocks a running
//     agent, both outrank tab visibility.
//   run — the controller's budget-gated `runAutonomousTurn`, REGISTERED from
//     App.tsx bootstrap (the timers pattern: controller.ts imports this
//     module for enqueueing, so the runner must arrive by registration to
//     keep the import graph acyclic).
//   schedule — plain setTimeout.
//
// Everything else (dedupe per (project, kind, subject), per-project
// serialization, bounded 10×30 s retries) is the core's job.

import { useProjects } from "@/lib/projects/store";
import type { AutonomousTriggerKind } from "@/types";
import {
  createTriggerRouter,
  type BuiltTrigger,
  type QueuedTrigger,
  type TriggerOutcome,
} from "./triggers-core";

export type AutonomousRunner = (
  projectId: string,
  marker: string,
  wireText: string,
  trigger: AutonomousTriggerKind,
) => Promise<TriggerOutcome>;

let runner: AutonomousRunner | null = null;

/** Install the budget-gated turn runner (App.tsx bootstrap, before hydrate). */
export function registerAutonomousRunner(fn: AutonomousRunner): void {
  runner = fn;
}

/** Event kinds that stay quiet for closed project tabs. */
const OPEN_TAB_ONLY: ReadonlySet<AutonomousTriggerKind> = new Set([
  "agent-finished",
  "agent-blocked",
  "idle",
]);

function eligibility(projectId: string, kind: AutonomousTriggerKind) {
  const p = useProjects.getState();
  if (!p.hydrated) return "retry" as const;
  const record = p.projects[projectId];
  if (!record) return "drop" as const;
  if (OPEN_TAB_ONLY.has(kind) && record.closedAt) return "drop" as const;
  return "ok" as const;
}

const router = createTriggerRouter({
  eligibility,
  run: async (projectId, kind, built: BuiltTrigger) => {
    if (!runner) return "retry"; // enqueue raced bootstrap — runner registers shortly
    return runner(projectId, built.marker, built.wire, kind);
  },
  schedule: (fn, ms) => void setTimeout(fn, ms),
});

/**
 * Enqueue one autonomous trigger. Returns false when an identical trigger
 * (same project, kind, subject) is already pending/running — the dedupe that
 * keeps double events, two windows and respawn races from double-firing.
 */
export function enqueueAutonomousTrigger(t: QueuedTrigger): boolean {
  return router.enqueue(t);
}

/**
 * Serialize arbitrary autonomous work into a project's chain — the timer
 * delivery shares this, so a timer turn never interleaves with an
 * event-triggered turn in the same project chat.
 */
export function runExclusiveAutonomous<T>(
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return router.runExclusive(projectId, fn);
}

/** Test/teardown seam. */
export function resetTriggerRouter(): void {
  router.reset();
}
