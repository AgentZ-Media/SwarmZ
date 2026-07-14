import type { MissionTask } from "@/lib/missions/types";

const UNSAFE_HEADS = new Set([
  "sh", "bash", "zsh", "dash", "fish", "env", "sudo", "xargs", "eval", "exec", "source",
]);

function hash(value: string, seed: number): string {
  let state = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index);
    state = Math.imul(state, 16_777_619);
  }
  return (state >>> 0).toString(36);
}

export function integrationIdentity(missionId: string, root: string): {
  trainId: string;
  branch: string;
  worktreePath: string;
} {
  const digest = `${hash(`${missionId}\u001f${root}`, 2_166_136_261)}${hash(root, 3_332_666_709)}`;
  const branch = `swarmz/integration/${digest}`;
  return {
    trainId: `train-${digest}`,
    branch,
    worktreePath: `${root.replace(/\/+$/, "")}/.worktrees/${digest}`,
  };
}

/** Group successful work by canonical repo root; commits never cross repositories. */
export function missionTasksByRoot(tasks: readonly MissionTask[]): Map<string, MissionTask[]> {
  const grouped = new Map<string, MissionTask[]>();
  for (const task of tasks) {
    const current = grouped.get(task.root.path) ?? [];
    current.push(task);
    grouped.set(task.root.path, current);
  }
  for (const entries of grouped.values()) {
    entries.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }
  return grouped;
}

/**
 * Parse a human-approved quality command into direct argv. Shell expansion,
 * substitutions, redirects and control operators are refused, not emulated.
 */
export function parseApprovedArgv(command: string): string[] {
  if (!command.trim() || command.length > 1_000 || /[\r\n\0]/.test(command)) {
    throw new Error("quality command must be one bounded line");
  }
  const argv: string[] = [];
  let token = "";
  let quote: "single" | "double" | null = null;
  let escaping = false;
  let started = false;
  for (const character of command) {
    if (escaping) {
      token += character;
      escaping = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "single") {
      escaping = true;
      started = true;
      continue;
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? null : "single";
      started = true;
      continue;
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? null : "double";
      started = true;
      continue;
    }
    if (character === "$" || character === "`") {
      throw new Error("quality commands cannot use shell substitution");
    }
    if (!quote && /[|&;<>()[\]{}]/.test(character)) {
      throw new Error("quality commands cannot use shell operators");
    }
    if (!quote && /\s/.test(character)) {
      if (started) {
        argv.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += character;
    started = true;
  }
  if (escaping || quote) throw new Error("quality command has an unfinished quote or escape");
  if (started) argv.push(token);
  if (argv.length === 0 || argv.length > 128 || argv.some((part) => part.length > 4_096)) {
    throw new Error("quality command argv is invalid or too large");
  }
  const head = argv[0].split("/").pop()?.toLowerCase() ?? "";
  if (UNSAFE_HEADS.has(head)) throw new Error(`quality command executable ${JSON.stringify(head)} is not allowed`);
  return argv;
}
