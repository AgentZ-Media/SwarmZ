// @session routing for the Conductor composer (Phase 5). A message that starts
// with `@<session-name or -id> ` is routed DIRECTLY to that session instead of
// the orchestrator. Deliberately a tiny prefix parser — not a full mention
// system: pure so the composer and its unit test share one implementation.

/** A session candidate the parser matches against (id + display name). */
export interface MentionCandidate {
  id: string;
  name: string;
}

export interface ParsedMention {
  /** the matched session's id */
  sessionId: string;
  /** the message text with the `@…` prefix stripped (may be empty) */
  body: string;
  /** the key that matched (id or name) — for the composer's UI feedback */
  matched: string;
}

/**
 * Parse a leading `@session` mention. Matches against each candidate's id and
 * display name (case-insensitive), preferring the LONGEST key so a name that
 * is a prefix of another never shadows the more specific one. Names may contain
 * spaces — the match consumes the full name when it is followed by a space or
 * ends the string. Returns null when the text has no leading mention or no
 * candidate matches (the caller then routes the text to the orchestrator).
 */
export function parseSessionMention(
  text: string,
  candidates: MentionCandidate[],
): ParsedMention | null {
  if (!text.startsWith("@")) return null;
  const rest = text.slice(1);
  const restLower = rest.toLowerCase();

  let best: ParsedMention | null = null;
  const consider = (sessionId: string, key: string) => {
    if (!key) return;
    const keyLower = key.toLowerCase();
    let body: string | null = null;
    if (restLower === keyLower) body = "";
    else if (restLower.startsWith(`${keyLower} `))
      body = rest.slice(key.length + 1).replace(/^\s+/, "");
    if (body === null) return;
    if (!best || key.length > best.matched.length)
      best = { sessionId, body, matched: key };
  };

  for (const c of candidates) {
    consider(c.id, c.id);
    consider(c.id, c.name);
  }
  return best;
}

/**
 * The partial mention token being typed, for the completion popover: returns
 * the text after a leading `@` while no space has been typed yet (so the
 * popover only shows while the user is still naming the session), else null.
 */
export function mentionQuery(text: string): string | null {
  if (!text.startsWith("@")) return null;
  const rest = text.slice(1);
  // once a space is typed the mention is "committed" — stop suggesting
  if (/\s/.test(rest)) return null;
  return rest;
}
