import {
  ORCHESTRATOR_TOOL_NAMES,
  type OrchestratorToolName,
} from "./types";
import type { ToolExecutor } from "./executor-types";

/** The single TS name mirror of `src-tauri/src/orchestrator/registry.rs`. */
export const EXECUTOR_TOOL_NAMES = ORCHESTRATOR_TOOL_NAMES;

type ExecutorEntries = Readonly<Record<string, ToolExecutor>>;

/**
 * Fail fast if two families claim the same tool or a family drifts away from
 * the native registry. Object spread alone would silently let the last owner
 * win, which is unsafe for permission-gated executors.
 */
export function composeExecutorRegistry(
  families: readonly ExecutorEntries[],
): Record<OrchestratorToolName, ToolExecutor> {
  const registry: Record<string, ToolExecutor> = {};
  for (const family of families) {
    for (const [name, executor] of Object.entries(family)) {
      if (registry[name]) throw new Error(`duplicate Conductor executor: ${name}`);
      registry[name] = executor;
    }
  }

  const expected = new Set<string>(EXECUTOR_TOOL_NAMES);
  const missing = EXECUTOR_TOOL_NAMES.filter((name) => !registry[name]);
  const unexpected = Object.keys(registry).filter((name) => !expected.has(name));
  if (missing.length || unexpected.length) {
    throw new Error(
      `Conductor executor registry drift (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`,
    );
  }
  return Object.fromEntries(
    EXECUTOR_TOOL_NAMES.map((name) => [name, registry[name]]),
  ) as Record<OrchestratorToolName, ToolExecutor>;
}
