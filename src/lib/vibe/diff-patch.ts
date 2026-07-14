import type { VibeFileChange } from "@/types";
import { changeKind } from "./diff";

/**
 * True when a per-file unified diff chunk already carries file headers.
 * Only the preamble (everything before the first hunk) counts: a deleted
 * content line such as `--- separator` must not be mistaken for a header.
 */
export function hasFileHeader(diff: string): boolean {
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("@@")) return false;
    if (line.startsWith("diff --git ")) return true;
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) return true;
  }
  return false;
}

/** Convert a Codex file-change payload into a standard per-file patch. */
export function changeToPatchText(change: VibeFileChange): string {
  const raw = change.diff ?? "";
  if (changeKind(change.kind) === "add") {
    const body = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    const lines = body.length ? body.split("\n") : [];
    if (lines.length === 0) return `--- /dev/null\n+++ b/${change.path}\n`;
    return (
      `--- /dev/null\n+++ b/${change.path}\n@@ -0,0 +1,${lines.length} @@\n` +
      lines.map((line) => `+${line}`).join("\n") +
      "\n"
    );
  }
  if (!hasFileHeader(raw)) {
    return `--- a/${change.path}\n+++ b/${change.path}\n${raw}`;
  }
  return raw;
}
