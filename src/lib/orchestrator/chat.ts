// Orchestrator chat plumbing (Phase 3) — typed wrappers around the five
// `orchestrator_chat_*` commands (Codex app-server brain, see
// src-tauri/src/orchestrator/appserver.rs) plus the chat-event listener.
// Native-only: direct `invoke`, like lib/worktree.ts. No UI here — the
// chat sidebar arrives in Phase 4; until then dev.ts drives this.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSwarm } from "@/store";
import { currentPersonaWire, type PersonaWire } from "./persona";

/** Identifies one chat: the in-process id + the persistent thread id. */
export interface OrchestratorChatRef {
  chat_id: string;
  /** app-server thread id — survives restarts, reopen via chatResume */
  thread_id: string;
}

export type OrchestratorChatEventKind =
  | "turn_started"
  | "delta"
  | "message"
  | "tool_call"
  | "tool_done"
  | "token_usage"
  | "turn_completed"
  | "turn_failed"
  | "compacted"
  | "warning";

/** Payload of the `orchestrator://chat-event` stream. */
export interface OrchestratorChatEvent {
  chat_id: string;
  kind: OrchestratorChatEventKind;
  /**
   * kind-specific, kept small: delta/message `{text}` · tool_call
   * `{tool, args_summary}` · tool_done `{tool, ok}` · turn_started
   * `{turn_id}` · token_usage `{total, last, modelContextWindow}` ·
   * turn_completed `{status}` · turn_failed `{error}` · warning `{message}`
   */
  data: Record<string, unknown>;
}

/** Resolved value of chatSend once the turn is over (never "failed"). */
export interface OrchestratorChatSendResult {
  status: "completed" | "interrupted";
  /** the turn's final assistant message */
  text: string;
}

export interface OrchestratorChatStatus {
  running: boolean;
  /** initialize userAgent — carries the codex version */
  version: string | null;
  account: {
    logged_in?: boolean;
    type?: string | null;
    plan?: string | null;
    email?: string | null;
    error?: string;
  } | null;
  /** set when the app-server could not be started */
  error?: string;
}

/** The wire shape of a chat's project context (Rust `ProjectContext`). */
export interface ProjectContextWire {
  id: string;
  dir: string;
  name: string;
}

/** The Settings codex-binary override, passed to every process-touching call. */
function codexPath(): string {
  return useSwarm.getState().settings.codexPath ?? "";
}

/** The current persona (voice) reduced to the wire shape Rust compiles. */
function persona(): PersonaWire {
  return currentPersonaWire(useSwarm.getState().settings.orchestratorPersona);
}

/**
 * Start a fresh Conductor chat on one project's instance (spawns that
 * project's app-server lazily; the thread cwd is the project dir).
 */
export function chatStart(
  project: ProjectContextWire,
): Promise<OrchestratorChatRef> {
  return invoke<OrchestratorChatRef>("orchestrator_chat_start", {
    codexPath: codexPath(),
    persona: persona(),
    project,
  });
}

/**
 * Send one user message. Resolves with the final assistant text when the
 * turn completes; progress streams via onChatEvent meanwhile. Rejects when
 * the turn fails (or another turn is already running in this chat).
 */
export function chatSend(
  chatId: string,
  text: string,
  /** per-turn overrides (codex chats) — omitted = the user's default config */
  model?: string,
  effort?: string,
): Promise<OrchestratorChatSendResult> {
  return invoke<OrchestratorChatSendResult>("orchestrator_chat_send", {
    chatId,
    text,
    model: model ?? null,
    effort: effort ?? null,
  });
}

/** Interrupt the chat's running turn (chatSend resolves as "interrupted"). */
export function chatInterrupt(chatId: string): Promise<void> {
  return invoke("orchestrator_chat_interrupt", { chatId });
}

/** Compact the chat's thread (thread/compact/start) — summarizes the
 * model-visible history without touching the UI transcript. Blocks until the
 * compaction turn completes. */
export function chatCompact(chatId: string): Promise<{ status: string }> {
  return invoke("orchestrator_chat_compact", { chatId });
}

/** Reopen a persisted app-server thread as a chat (across app restarts) on
 * its project's instance. */
export function chatResume(
  threadId: string,
  project: ProjectContextWire,
): Promise<OrchestratorChatRef> {
  return invoke<OrchestratorChatRef>("orchestrator_chat_resume", {
    threadId,
    persona: persona(),
    project,
  });
}

/** Liveness + codex version + account summary. Never rejects for a dead
 * process — that comes back as `{ running: false, error }`. Reuses any alive
 * Conductor process; else spawns the given project's instance. */
export function chatStatus(
  project?: ProjectContextWire,
): Promise<OrchestratorChatStatus> {
  return invoke<OrchestratorChatStatus>("orchestrator_chat_status", {
    codexPath: codexPath(),
    project: project ?? null,
  });
}

/**
 * Subscribe to the chat-event stream (all chats — filter by chat_id).
 * Returns a stop function.
 */
export function onChatEvent(
  cb: (event: OrchestratorChatEvent) => void,
): () => void {
  const unlistenP = listen<OrchestratorChatEvent>(
    "orchestrator://chat-event",
    (event) => cb(event.payload),
  );
  return () => {
    void unlistenP.then((u) => u());
  };
}
