// Spawn a PR agent off the GitHub panel's Review / Review & merge buttons —
// the impure twin of `prAgentPrompt` (core.ts). A HUMAN-triggered spawn
// through the exact same path as the New-agent dialog: workspace sandbox,
// pool-generated name, no worktree (the prompt forbids touching the shared
// checkout; gh reads don't need one). The agent's gh calls go through the
// normal approval classification — reads are routine, `gh pr merge` stays
// destructive/human, so the merge itself always ends at a human click.

import { focusSession, sendMessage, startSession } from "@/lib/vibe/controller";
import { useProjects } from "@/lib/projects/store";
import { prAgentPrompt, type PrAgentMode } from "./core";
import type { GhPr } from "./types";

/**
 * Start a fresh agent on the project and hand it the PR prompt as its first
 * message. Resolves with the session id once the session started (the first
 * send itself is fire-and-forget — a failure surfaces as a warning item in
 * the transcript, same contract as the New-agent dialog's first prompt).
 */
export async function spawnPrAgent(
  projectId: string,
  pr: GhPr,
  mode: PrAgentMode,
): Promise<string> {
  const dir = useProjects.getState().projects[projectId]?.dir;
  if (!dir) throw new Error("unknown project — reopen the folder and retry");
  const id = await startSession({
    projectDir: dir,
    projectId,
    spawnedBy: "user",
    access: "workspace",
  });
  void sendMessage(id, prAgentPrompt(pr, mode));
  // the fresh agent takes the stage (the caller closes the drawer)
  focusSession(id);
  return id;
}
