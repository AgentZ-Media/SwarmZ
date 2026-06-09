import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Claude encodes a cwd as the project dir name by replacing every `/` and `.` with `-`. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
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

/** Turn `claude-opus-4-7` into `Opus 4.7`, `claude-fable-5` into `Fable 5`. */
export function prettyModel(model: string | null | undefined): string {
  if (!model) return "—";
  const m = model.toLowerCase();
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
