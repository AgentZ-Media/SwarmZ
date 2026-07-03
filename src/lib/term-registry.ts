import type { Terminal } from "@xterm/xterm";

/**
 * Live xterm instances by pty id (agent panes + floating terminals),
 * registered by `TerminalView` for callers that need terminal-level APIs
 * rather than the raw PTY — e.g. dnd.ts pastes dropped paths via
 * `term.paste()` so they arrive bracketed-paste-wrapped like in iTerm.
 */
const terms = new Map<string, Terminal>();

export function registerTerm(id: string, term: Terminal): void {
  terms.set(id, term);
}

export function unregisterTerm(id: string): void {
  terms.delete(id);
}

export function getTerm(id: string): Terminal | undefined {
  return terms.get(id);
}
