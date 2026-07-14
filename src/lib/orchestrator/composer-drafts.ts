// Conductor composer drafts are scoped to the destination they will reach.
// The sidebar stays mounted while project tabs and chats change, so one
// shared React state value could otherwise send Project A's text to Project B.

const drafts = new Map<string, string>();

export function conductorDraftKey(
  projectId: string | null,
  chatId: string | null,
): string {
  return `${projectId ?? "no-project"}:${chatId ?? "new-chat"}`;
}

export function readConductorDraft(key: string): string {
  return drafts.get(key) ?? "";
}

export function writeConductorDraft(key: string, text: string): void {
  if (text) drafts.set(key, text);
  else drafts.delete(key);
}

/** Test/app-reset seam; drafts are intentionally process-local UI state. */
export function clearConductorDrafts(): void {
  drafts.clear();
}
