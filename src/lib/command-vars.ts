import { folderName } from "./utils";

/**
 * Placeholder substitution for custom commands (insert picker, ⌘⇧K).
 *
 * Supported: {{folder}} (last path segment of the cwd), {{cwd}}, {{branch}},
 * {{agent}} — filled from the target pane's context — and {{input:Label}},
 * asked from the user right before inserting. Unknown tokens stay literal so
 * prompts that themselves contain {{…}} examples survive substitution.
 */

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export interface CommandVarContext {
  cwd?: string;
  agentName?: string;
  /** branch of the pane's repo; null/undefined = not a repo */
  branch?: string | null;
}

/** Label of an `input:` token, or null for anything else. */
function inputLabel(token: string): string | null {
  const m = /^input\s*:(.*)$/i.exec(token);
  return m ? m[1].trim() : null;
}

/**
 * Ordered, de-duplicated labels of all {{input:Label}} placeholders. Labels
 * are case-sensitive keys — the same label twice means the same value.
 */
export function extractInputLabels(text: string): string[] {
  const labels: string[] = [];
  for (const m of text.matchAll(VAR_RE)) {
    const label = inputLabel(m[1]);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/**
 * Replace built-in and input placeholders. A known variable without a value
 * (e.g. {{branch}} outside a repo) becomes "" — an empty hole confuses agents
 * less than a leftover mustache. Unknown tokens are returned literally.
 */
export function substituteVars(
  text: string,
  ctx: CommandVarContext,
  inputs?: Record<string, string>,
): string {
  return text.replace(VAR_RE, (match, rawToken: string) => {
    const label = inputLabel(rawToken);
    if (label !== null) return inputs?.[label] ?? "";
    switch (rawToken.toLowerCase()) {
      case "folder":
        return ctx.cwd ? folderName(ctx.cwd) : "";
      case "cwd":
        return ctx.cwd ?? "";
      case "branch":
        return ctx.branch ?? "";
      case "agent":
        return ctx.agentName ?? "";
      default:
        return match;
    }
  });
}
