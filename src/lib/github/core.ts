// Pure GitHub helpers — no Tauri, no store (unit-tested). The heavy lifting
// (check summaries, PR diffing) happens Rust-side; this is the thin layer the
// UI and the executors share.

import type { GhOutcome, GhPr } from "./types";

/** Human note for a typed gh degradation (executors + panel share it). */
export function describeGhUnavailable(
  status: "not_installed" | "not_authenticated" | "no_remote",
): string {
  switch (status) {
    case "not_installed":
      return "the GitHub CLI (gh) is not installed on this machine — install it (brew install gh) and log in (gh auth login)";
    case "not_authenticated":
      return "gh is installed but not logged in — the user must run `gh auth login`";
    case "no_remote":
      return "this project has no GitHub remote — nothing to do on GitHub here";
  }
}

/**
 * Unwrap a GhOutcome into data-or-throw with a readable message. The typed
 * unavailable states become actionable sentences the Conductor can relay.
 */
export function unwrapGh<T>(outcome: GhOutcome<T>, what: string): T {
  switch (outcome.status) {
    case "ok":
      return outcome.data;
    case "error":
      throw new Error(`${what} failed: ${outcome.data}`);
    default:
      throw new Error(`${what} unavailable: ${describeGhUnavailable(outcome.status)}`);
  }
}

/** Is there an open PR whose head is `branch`? (suggest-PR-on-finish gate) */
export function hasOpenPrForBranch(
  prs: GhPr[] | undefined,
  branch: string | null | undefined,
): boolean {
  if (!prs || !branch) return false;
  return prs.some((p) => p.head_ref === branch);
}

/**
 * Primitive Deck-indicator signature of one project's PRs — a zustand
 * selector must never return a fresh object, so the Deck selects THIS string
 * and splits it in useMemo. "" = nothing to show.
 */
export function deckPrSignature(prs: GhPr[] | undefined): string {
  if (!prs || prs.length === 0) return "";
  let failing = 0;
  let pending = 0;
  for (const p of prs) {
    if (p.checks.failing > 0) failing++;
    else if (p.checks.pending > 0) pending++;
  }
  return `${prs.length}:${failing}:${pending}`;
}

/** One-line ticker label for a watcher change note. */
export function prEventLabel(number: number, note: string): string {
  return `PR #${number} ${note}`;
}
