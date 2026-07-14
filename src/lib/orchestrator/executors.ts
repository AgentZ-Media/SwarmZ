// Stable webview-side facade for the native Conductor tool registry.
//
// The Rust registry remains the source of truth for schemas and timeouts.
// Cohesive executor families own semantic validation and side effects; this
// module deliberately does nothing except compose an exhaustive 34-tool map
// and preserve the historical public exports consumed by the bus/dev hook.

import { sensingExecutors } from "./executor-sensing";
import { agentExecutors } from "./executor-agent-tools";
import { worktreeExecutors } from "./executor-worktree-tools";
import { supportExecutors } from "./executor-support";
import { githubExecutors } from "./executor-github";
import { composeExecutorRegistry } from "./executor-registry";

export type { ToolCallContext } from "./executor-agents";
export type { ToolExecutor } from "./executor-types";
export { EXECUTOR_TOOL_NAMES } from "./executor-registry";
export { DOUBLE_PROMPT_WINDOW_MS, fleetSessions } from "./executor-agents";
export {
  approvalLooksLikeGithubWrite,
  redactRemoteUrl,
  resolveAgentAccess,
  sanitizeAgentName,
} from "./executor-guards";

/**
 * Exhaustive by construction: a missing native tool or duplicate family key
 * is caught by this explicit typed boundary and its registry test.
 */
export const executors = composeExecutorRegistry([
  sensingExecutors,
  agentExecutors,
  worktreeExecutors,
  supportExecutors,
  githubExecutors,
]);
