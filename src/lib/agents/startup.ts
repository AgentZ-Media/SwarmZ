// Custom-agent persona injection into a terminal pane's startup command.
//
// The startup string is TYPED into the login shell (see pty.rs / store.ts), so
// injection has to be a shell fragment appended to the base command. Verified
// live against the installed CLIs (codex-cli 0.142.5, Claude Code):
//
//   - Claude:  `--append-system-prompt-file <path>` (additive system prompt).
//   - Codex:   `-c developer_instructions="$(cat <path>)"` — the `-c` value is
//              parsed as TOML and falls back to the raw literal when that fails,
//              so a multi-line markdown blob rides through; wrapping the file in
//              command substitution inside double quotes keeps embedded quotes
//              and newlines intact. `developer_instructions` is ADDITIVE (the
//              standard harness stays intact), unlike `model_instructions_file`
//              which REPLACES the base prompt.
//   - shell:   no persona — shells stay shells.
//
// The `<path>` is the agent's `.compiled.md` cache (Rust `agent_write_compiled`).

import type { AgentRuntime } from "@/types";

/** Single-quote a path for safe use as one shell word. */
export function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Append the persona-injection fragment for `runtime` (reading the compiled
 * context from `compiledPath`) to `baseStartup`. A blank path, or a runtime
 * that can't carry a persona (shell), returns `baseStartup` unchanged — the
 * no-agent path must behave EXACTLY as before (injection is purely additive).
 */
export function injectAgentIntoStartup(
  baseStartup: string,
  runtime: AgentRuntime,
  compiledPath: string,
): string {
  const base = baseStartup.trimEnd();
  if (!compiledPath) return baseStartup;
  const q = shellQuote(compiledPath);
  if (runtime === "claude") {
    return `${base} --append-system-prompt-file ${q}`;
  }
  if (runtime === "codex") {
    return `${base} -c developer_instructions="$(cat ${q})"`;
  }
  return baseStartup;
}
