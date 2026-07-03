import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { AgentRuntime } from "@/types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Claude encodes a cwd as the project dir name by replacing every `/` and `.` with `-`. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

export function runtimeFromStartup(startup: string | undefined): AgentRuntime {
  const cmd = (startup ?? "").trimStart();
  if (cmd === "codex" || cmd.startsWith("codex ")) return "codex";
  if (cmd === "claude" || cmd.startsWith("claude ")) return "claude";
  return "shell";
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export function formatUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "$" + n.toFixed(4);
  if (n < 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(2);
}

/** Turn `claude-opus-4-7` into `Opus 4.7`, `gpt-5.5` into `GPT-5.5`. */
export function prettyModel(model: string | null | undefined): string {
  if (!model) return "—";
  const m = model.toLowerCase();
  if (m.startsWith("gpt-")) return model.replace(/^gpt-/i, "GPT-");
  let family = "";
  if (m.includes("fable")) family = "Fable";
  else if (m.includes("opus")) family = "Opus";
  else if (m.includes("sonnet")) family = "Sonnet";
  else if (m.includes("haiku")) family = "Haiku";
  else return model;
  const match = model.match(/(\d+)[-.](\d+)/) ?? model.match(/(\d+)/);
  const ver = match ? (match[2] ? `${match[1]}.${match[2]}` : match[1]) : "";
  return `${family} ${ver}`.trim();
}

/**
 * Data-viz color per model family — a single blue ramp (bright = most capable)
 * instead of a rainbow, in line with the near-monochrome design system.
 */
export function modelAccent(model: string | null | undefined): string {
  const m = (model ?? "").toLowerCase();
  if (m.includes("fable")) return "var(--chart-1)";
  if (m.includes("opus")) return "var(--chart-2)";
  if (m.includes("sonnet")) return "var(--chart-3)";
  if (m.includes("haiku")) return "var(--chart-4)";
  if (m.startsWith("gpt-")) return "var(--chart-1)";
  return "var(--chart-5)";
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Last path segment — used to auto-name a workspace after its first project folder. */
export function folderName(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

export function shortPath(p?: string): string {
  if (!p) return "~";
  const home = "/Users/";
  let s = p;
  if (s.startsWith(home)) {
    const rest = s.slice(home.length).split("/").slice(1).join("/");
    s = "~/" + rest;
  }
  const parts = s.split("/");
  if (parts.length > 3) return parts.slice(0, 1).concat("…", parts.slice(-2)).join("/");
  return s;
}

/**
 * Apply the Settings "claude path" override to a startup command: a leading
 * `claude` token is replaced with the configured binary path (quoted, so
 * paths with spaces survive the shell). Other commands pass through untouched.
 */
export function applyClaudePath(startup: string, claudePath?: string): string {
  const bin = claudePath?.trim();
  if (!bin) return startup;
  const cmd = startup.trimStart();
  if (cmd !== "claude" && !cmd.startsWith("claude ")) return startup;
  return `"${bin}"` + cmd.slice("claude".length);
}

export function applyRuntimePath(
  startup: string,
  runtime: AgentRuntime | undefined,
  paths: { claudePath?: string; codexPath?: string },
): string {
  const resolved = runtime ?? runtimeFromStartup(startup);
  if (resolved === "claude") return applyClaudePath(startup, paths.claudePath);
  if (resolved !== "codex") return startup;
  const bin = paths.codexPath?.trim();
  if (!bin) return startup;
  const cmd = startup.trimStart();
  if (cmd !== "codex" && !cmd.startsWith("codex ")) return startup;
  return `"${bin}"` + cmd.slice("codex".length);
}

/**
 * Rewrite a claude startup command so a restored pane reopens its previous
 * conversation: `--resume <sessionId>` is appended to a leading `claude`
 * command. Non-claude commands, commands that already pick a session
 * (--resume/--continue) and compound commands (;, &&, |) pass through
 * untouched and start fresh.
 */
export function resumeStartup(startup: string, sessionId?: string): string {
  if (!sessionId) return startup;
  const cmd = startup.trimStart();
  if (cmd !== "claude" && !cmd.startsWith("claude ")) return startup;
  if (/\s--(resume|continue)\b/.test(cmd) || /[;&|]/.test(cmd)) return startup;
  return `${startup} --resume ${sessionId}`;
}

export function resumeRuntimeStartup(
  startup: string,
  sessionId: string | undefined,
  runtime: AgentRuntime | undefined,
): string {
  if (!sessionId) return startup;
  const resolved = runtime ?? runtimeFromStartup(startup);
  if (resolved === "claude") return resumeStartup(startup, sessionId);
  if (resolved !== "codex") return startup;
  const cmd = startup.trimStart();
  if (cmd !== "codex" && !cmd.startsWith("codex ")) return startup;
  if (/^codex\s+resume(?:\s|$)/.test(cmd) || /[;&|]/.test(cmd)) return startup;
  return `${startup.replace(/^(\s*)codex\b/, "$1codex resume")} ${sessionId}`;
}

/**
 * Backslash-escape a dropped file path the way Terminal.app/iTerm do when a
 * file is dragged in — Claude Code (and shells) un-escape exactly this form.
 * ASCII specials (space, quotes, parens, …) get escaped; unicode stays as-is.
 */
export function escapeDropPath(p: string): string {
  return p.replace(/[^A-Za-z0-9,._+/@%\u0080-\uffff-]/g, (c) => "\\" + c);
}

/** Desaturated identity palette for profiles/agents — quiet, never neon. */
export const AGENT_COLORS = [
  "#5b8def",
  "#6fae8f",
  "#c2a36b",
  "#c48a8a",
  "#6fa8b5",
  "#9d93c8",
  "#8e98a8",
  "#b08f6a",
];

export function pickColor(index: number): string {
  return AGENT_COLORS[index % AGENT_COLORS.length];
}
