// Pure chat-lifecycle logic for the project-scoped chat store (Phase 3):
// the "reuse an empty chat instead of stacking a new one" rule (per project),
// the per-project empty-collapse, and the chat → project hydrate migration.
// Extracted Tauri-free so it stays unit-testable without pulling the
// store/transport module graph.

import type { OrchestratorChatMessage } from "@/types";

/** The only fields the reuse rules care about. */
type RoleOnly = { role: OrchestratorChatMessage["role"] };
type CollapsibleChat = { id: string; projectId: string; messages: RoleOnly[] };

/**
 * A chat is "reusable-empty" — the + button and per-launch createChat reuse it
 * rather than stacking a fresh one — when the user never actually engaged it:
 * NO `user` and NO `assistant` messages. Status pings (role `system`) and
 * warnings (role `warning`) arrive on chats the user never touched (a startup
 * prompt, an app-server hiccup), so they must NOT make a chat count as used —
 * otherwise every launch would stack a new empty chat behind the noise.
 *
 * A reusable-empty chat also never has a backend thread yet (ensureBackendChat
 * runs on the first send), so re-stamping its model/effort on reuse is safe.
 */
export function isReusableEmptyChat(chat: { messages: RoleOnly[] }): boolean {
  return !chat.messages.some(
    (m) => m.role === "user" || m.role === "assistant",
  );
}

/**
 * Collapse a chat list to AT MOST ONE reusable-empty chat PER PROJECT,
 * keeping the project's active one if it's empty (else the first/newest
 * empty) and dropping the rest. This is what stops empties from stacking
 * across reloads: the mount-time `createChat()` races the async hydrate and
 * can create an empty on the still-empty store, which the hydrate merge would
 * otherwise place next to yesterday's persisted empties. Running this after
 * every merge makes "at most one empty chat per project" an invariant
 * regardless of the race — and self-heals a state already polluted by the old
 * bug. Repoints `activeByProject` entries that named a dropped chat. Pure, so
 * it's unit-tested without the store.
 */
export function collapseEmptyChats<T extends CollapsibleChat>(
  chats: T[],
  activeByProject: Record<string, string>,
): { chats: T[]; activeByProject: Record<string, string> } {
  const drop = new Set<string>();
  const keepByProject = new Map<string, string>();
  const byProject = new Map<string, T[]>();
  for (const c of chats) {
    if (!isReusableEmptyChat(c)) continue;
    const list = byProject.get(c.projectId) ?? [];
    list.push(c);
    byProject.set(c.projectId, list);
  }
  for (const [projectId, empties] of byProject) {
    if (empties.length <= 1) continue;
    const active = activeByProject[projectId];
    const keep =
      (active ? empties.find((c) => c.id === active) : undefined) ?? empties[0];
    keepByProject.set(projectId, keep.id);
    for (const c of empties) if (c.id !== keep.id) drop.add(c.id);
  }
  if (drop.size === 0) return { chats, activeByProject };
  const nextActive: Record<string, string> = {};
  for (const [projectId, id] of Object.entries(activeByProject)) {
    nextActive[projectId] = drop.has(id)
      ? (keepByProject.get(projectId) ?? id)
      : id;
  }
  return {
    chats: chats.filter((c) => !drop.has(c.id)),
    activeByProject: nextActive,
  };
}

/**
 * Enforce the total chat cap, dropping from the END (oldest) — but NEVER an
 * unassigned (`projectId: ""`) chat: those are merely invisible until a later
 * heal re-attaches them to a project; letting the cap evict them first would
 * silently destroy exactly the chats that are already in a degraded state.
 * Pure; returns the input array when nothing needs to drop.
 */
export function capChats<T extends { projectId: string }>(
  chats: T[],
  max: number,
): T[] {
  let over = chats.length - max;
  if (over <= 0) return chats;
  const drop = new Set<number>();
  for (let i = chats.length - 1; i >= 0 && over > 0; i--) {
    if (chats[i].projectId) {
      drop.add(i);
      over--;
    }
  }
  return drop.size ? chats.filter((_, i) => !drop.has(i)) : chats;
}

// ---- chat → project hydrate migration (Phase 3) ----

/** The slice of a chat the migration needs. */
export interface MigratableChat {
  id: string;
  /** null/"" = pre-Phase-3 chat without a project */
  projectId: string | null;
  /** sessions the chat prompted: session id → last prompt time */
  touched: Record<string, number>;
}

/**
 * Assign every chat to a project (the Phase-3 hydrate migration). The rule,
 * in order:
 *
 * 1. a chat whose `projectId` names an existing project keeps it;
 * 2. otherwise the chat goes to the project of the session it touched MOST
 *    RECENTLY (via `sessionProject`, the live session store — sessions
 *    already carry projectIds since schema v2);
 * 3. otherwise it goes to `fallbackProjectId` (the last active project at
 *    hydrate time);
 * 4. with no fallback either (no projects exist at all) it keeps "" — it
 *    stays invisible until the store self-heals on a later hydrate.
 *
 * Pure: the session→project resolver and the fallback are injected.
 */
/**
 * Apply a migration's assignments to a chat list — with the DOWNGRADE GUARD:
 * an existing non-empty `projectId` is never overwritten with "" (the project
 * record may be missing only transiently; wiping the link would be permanent
 * once persisted). Identity-preserving: untouched chats keep their object
 * reference; `changed` says whether anything moved at all.
 */
export function applyChatAssignments<
  T extends { id: string; projectId: string },
>(
  chats: T[],
  assignments: Record<string, string>,
): { chats: T[]; changed: boolean } {
  let changed = false;
  const next = chats.map((chat) => {
    const assigned = assignments[chat.id];
    if (assigned === undefined || chat.projectId === assigned) return chat;
    // never DOWNGRADE an existing assignment to ""
    if (assigned === "" && chat.projectId) return chat;
    changed = true;
    return { ...chat, projectId: assigned };
  });
  return changed ? { chats: next, changed } : { chats, changed };
}

export function assignChatsToProjects(
  chats: MigratableChat[],
  validProjectIds: ReadonlySet<string>,
  sessionProject: (sessionId: string) => string | null,
  fallbackProjectId: string | null,
): Record<string, string> {
  const assignments: Record<string, string> = {};
  for (const chat of chats) {
    if (chat.projectId && validProjectIds.has(chat.projectId)) {
      assignments[chat.id] = chat.projectId;
      continue;
    }
    // most recently touched session whose project still exists
    let best: { projectId: string; at: number } | null = null;
    for (const [sessionId, at] of Object.entries(chat.touched)) {
      const projectId = sessionProject(sessionId);
      if (!projectId || !validProjectIds.has(projectId)) continue;
      if (!best || at > best.at) best = { projectId, at };
    }
    if (best) {
      assignments[chat.id] = best.projectId;
      continue;
    }
    assignments[chat.id] =
      fallbackProjectId && validProjectIds.has(fallbackProjectId)
        ? fallbackProjectId
        : "";
  }
  return assignments;
}
