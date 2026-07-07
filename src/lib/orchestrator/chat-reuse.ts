// Pure predicate for the "reuse an empty chat instead of stacking a new one"
// rule (chat-store `newChat`, hydrate → createChat). Extracted Tauri-free so it
// stays unit-testable without pulling the store/transport module graph.

import type { OrchestratorChatMessage } from "@/types";

/** The only field the reuse rule cares about. */
type RoleOnly = { role: OrchestratorChatMessage["role"] };

/**
 * A chat is "reusable-empty" — the + button and per-launch createChat reuse it
 * rather than stacking a fresh one — when the user never actually engaged it:
 * NO `user` and NO `assistant` messages. Status pings (role `system`) and
 * warnings (role `warning`) arrive on chats the user never touched (a startup
 * prompt, an app-server hiccup), so they must NOT make a chat count as used —
 * otherwise every launch would stack a new empty chat behind the noise.
 *
 * A reusable-empty chat also never has a backend thread yet (ensureBackendChat
 * runs on the first send), so re-stamping its provider/model on reuse is safe.
 */
export function isReusableEmptyChat(chat: { messages: RoleOnly[] }): boolean {
  return !chat.messages.some(
    (m) => m.role === "user" || m.role === "assistant",
  );
}

/**
 * Collapse a chat list to AT MOST ONE reusable-empty chat, keeping the active
 * one if it's empty (else the first/newest empty) and dropping the rest. This
 * is what stops empties from stacking across reloads: the mount-time
 * `createChat()` races the async hydrate and can create an empty on the
 * still-empty store, which the hydrate merge would otherwise place next to
 * yesterday's persisted empties. Running this after every merge makes "at most
 * one empty chat" an invariant regardless of the race — and self-heals a state
 * already polluted by the old bug. Repoints `activeId` if it named a dropped
 * chat. Pure, so it's unit-tested without the store.
 */
export function collapseEmptyChats<T extends { id: string; messages: RoleOnly[] }>(
  chats: T[],
  activeId: string | null,
): { chats: T[]; activeId: string | null } {
  const empties = chats.filter(isReusableEmptyChat);
  if (empties.length <= 1) return { chats, activeId };
  const keep =
    (activeId ? empties.find((c) => c.id === activeId) : undefined) ??
    empties[0];
  const drop = new Set(empties.filter((c) => c.id !== keep.id).map((c) => c.id));
  return {
    chats: chats.filter((c) => !drop.has(c.id)),
    activeId: activeId && drop.has(activeId) ? keep.id : activeId,
  };
}
