import { useSwarm } from "@/store";
import type { VibeAccess } from "@/types";
import { isAutonomousTurnInFlight } from "./controller";
import { isFlattenedChar } from "./triggers-core";
import type { ToolCallContext } from "./executor-agents";

export function gitBin(): string | undefined {
  return useSwarm.getState().settings.gitPath?.trim() || undefined;
}

export function githubEnabled(): boolean {
  return Boolean(useSwarm.getState().settings.githubIntegration);
}

export function requireGithub(): void {
  if (!githubEnabled()) {
    throw new Error(
      "GitHub integration is disabled (Settings → GitHub) — this tool is unavailable. Do not retry; if the user wants GitHub work, tell them to enable the integration.",
    );
  }
}

export function guardOutwardGithub(
  ctx: ToolCallContext,
  action: string,
): void {
  if (!isAutonomousTurnInFlight(ctx.chatId)) return;
  if (useSwarm.getState().settings.autonomousGithubWrites === true) return;
  throw new Error(
    `refused: ${action} posts to GitHub on the user's behalf and this is an AUTONOMOUS turn. Outward GitHub writes stay with the user unless they enable Settings → "Autonomous GitHub actions". Report what you would ${action} and let the user run it (or ask them to).`,
  );
}

const GH_WRITE_COMMAND_RE =
  /\bgit\s+push\b|\bgh\s+(?:pr\s+(?:create|comment|review|merge|close|edit|ready|reopen)|release\s+(?:create|edit|delete|upload)|issue\s+(?:create|comment|close|edit|reopen)|api)\b/i;

function stripShellQuotes(text: string): string {
  return text
    .replace(/['"]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

export function approvalLooksLikeGithubWrite(approval: {
  approvalKind: "command" | "fileChange";
  payload: Record<string, unknown>;
}): boolean {
  if (approval.approvalKind !== "command") return false;
  const command = approval.payload?.command;
  const text = Array.isArray(command)
    ? command.map((part) => (typeof part === "string" ? part : "")).join(" ")
    : typeof command === "string"
      ? command
      : "";
  return (
    GH_WRITE_COMMAND_RE.test(text) ||
    GH_WRITE_COMMAND_RE.test(stripShellQuotes(text))
  );
}

export function redactRemoteUrl(url: string | null): string | null {
  if (!url) return null;
  return url.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@]*@/, "$1");
}

export function requirePrNumber(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new Error("number must be a positive PR number (from list_prs)");
  }
  return raw;
}

export function validModelId(model: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/.test(model);
}

export function resolveAgentAccess(raw: unknown): VibeAccess {
  if (raw === "full") {
    throw new Error(
      'access "full" (danger-full-access) is human-only — the Conductor can only use "workspace". If full access is truly needed, ask the user to grant it via the agent\'s access toggle.',
    );
  }
  return "workspace";
}

export function sanitizeAgentName(raw: string): string {
  let output = "";
  for (const character of raw) {
    output += isFlattenedChar(character.charCodeAt(0)) ? " " : character;
  }
  return output.replace(/\s+/g, " ").trim().slice(0, 60);
}
