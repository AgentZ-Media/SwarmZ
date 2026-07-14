import type { OrchestratorToolName } from "./types";
import type { ToolCallContext } from "./executor-agents";

export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx: ToolCallContext,
) => Promise<unknown>;

/** A cohesive, compile-time checked subset of the native tool registry. */
export type ExecutorFamily<Name extends OrchestratorToolName> = Record<
  Name,
  ToolExecutor
>;
