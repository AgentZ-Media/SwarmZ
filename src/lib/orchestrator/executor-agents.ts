import { pushFleetEvent } from "@/lib/events";
import { useProjects } from "@/lib/projects/store";
import { useVibe, type VibeSessionEntry } from "@/lib/vibe/session-store";
import { useOrchestrator } from "./chat-store";
import { sessionSnapshot } from "./snapshot";

/** Project/chat authority carried by every dynamic tool request. */
export interface ToolCallContext {
  chatId: string | null;
  projectId: string | null;
}

/** Two orchestrator prompts into the same session inside this window refuse. */
export const DOUBLE_PROMPT_WINDOW_MS = 2_000;

const lastPromptDelivery = new Map<string, number>();

export function assertNoDoublePrompt(sessionId: string, name: string): void {
  const last = lastPromptDelivery.get(sessionId);
  if (last !== undefined && Date.now() - last < DOUBLE_PROMPT_WINDOW_MS) {
    throw new Error(
      `agent "${name}" (${sessionId}) already received an orchestrator prompt ${Date.now() - last} ms ago — this looks like a duplicate call; wait a moment and re-send only if it was intentional`,
    );
  }
}

export function notePromptDelivered(
  sessionId: string,
  sessionName: string,
  ctx: ToolCallContext,
): void {
  lastPromptDelivery.set(sessionId, Date.now());
  if (ctx.chatId) {
    useOrchestrator
      .getState()
      .recordTouchedPane(ctx.chatId, sessionId, sessionName);
  }
  pushFleetEvent({ kind: "orch_prompt", sessionId, sessionName });
}

/** Ordered session entries (rail order), optionally scoped to one project. */
export function orderedSessions(projectId: string | null): VibeSessionEntry[] {
  const vibe = useVibe.getState();
  return vibe.order
    .map((id) => vibe.sessions[id])
    .filter((entry): entry is VibeSessionEntry => Boolean(entry))
    .filter(
      (entry) => projectId === null || entry.session.projectId === projectId,
    );
}

export function fleetSessions(projectId: string | null = null) {
  const vibe = useVibe.getState();
  return sessionSnapshot({
    sessions: orderedSessions(projectId),
    busy: vibe.busy,
  });
}

/**
 * Pure characterization seam for id/name resolution. Callers must pass an
 * already project-scoped list; this function never broadens authority.
 */
export function resolveSessionReference(
  scoped: readonly VibeSessionEntry[],
  agent: unknown,
  projectScoped: boolean,
): VibeSessionEntry {
  if (typeof agent === "string" && agent.trim()) {
    const byId = scoped.find((entry) => entry.session.id === agent);
    if (byId) return byId;
    const needle = agent.trim().replace(/^@/, "").toLowerCase();
    const byName = scoped.filter(
      (entry) =>
        entry.session.name.toLowerCase() === needle ||
        entry.session.agentName.toLowerCase() === needle,
    );
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      throw new Error(
        `ambiguous agent name ${JSON.stringify(String(agent))} — matches: ${byName
          .map((entry) => `${entry.session.id} ("${entry.session.name}")`)
          .join(", ")}; use the id`,
      );
    }
  }
  const valid = scoped
    .map((entry) => `${entry.session.id} ("${entry.session.name}")`)
    .join(", ");
  throw new Error(
    `unknown agent ${JSON.stringify(String(agent))} — valid agents${
      projectScoped ? " in this project" : ""
    }: ${valid || "(no agents)"}`,
  );
}

/** Resolve only inside the calling Conductor's project. */
export function requireSession(
  agent: unknown,
  ctx: ToolCallContext,
): VibeSessionEntry {
  return resolveSessionReference(
    orderedSessions(ctx.projectId),
    agent,
    Boolean(ctx.projectId),
  );
}

/** Folder-note authority for the calling project; null exposes no folders. */
export function allowedProjectNotePaths(
  ctx: ToolCallContext,
): Set<string> | null {
  if (!ctx.projectId) return null;
  const normalize = (path: string) => path.replace(/\/+$/, "");
  const allowed = new Set<string>();
  const dir = useProjects.getState().projects[ctx.projectId]?.dir?.trim();
  if (dir) allowed.add(normalize(dir));
  for (const entry of orderedSessions(ctx.projectId)) {
    if (entry.session.projectDir?.trim()) {
      allowed.add(normalize(entry.session.projectDir));
    }
    if (entry.session.worktree?.root) {
      allowed.add(normalize(entry.session.worktree.root));
    }
  }
  return allowed;
}

export function requireProject(
  ctx: ToolCallContext,
): { id: string; dir: string } {
  const projectId = ctx.projectId ?? "";
  const dir = useProjects.getState().projects[projectId]?.dir?.trim() ?? "";
  if (!projectId || !dir) {
    throw new Error(
      "this tool needs a project context — no project folder available",
    );
  }
  return { id: projectId, dir };
}

export function takenAgentNames(projectId: string | null): string[] {
  const taken: string[] = [];
  for (const entry of orderedSessions(projectId)) {
    taken.push(entry.session.agentName, entry.session.name);
  }
  return taken;
}
