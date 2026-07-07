// Orchestrator brain, provider B (Phase 6): a tool-calling loop over the
// OpenRouter chat-completions API — the SAME tool registry (fetched from
// Rust, single source) and the SAME chat UI as the Codex path. The loop
// lives HERE (webview) because the tool executors do: tool calls execute
// DIRECTLY against executors.ts (with the chat context, so touched-pane
// tracking works) — no Rust roundtrip. Only the streamed completion call
// itself runs in Rust (src-tauri/src/orchestrator/openrouter.rs), which
// owns the keychain key and emits content tokens as the same
// `orchestrator://chat-event` deltas the app-server client emits.
//
// Wire history: OpenAI-format messages persisted per chat (chat.wire,
// capped at MAX_WIRE_MESSAGES — old context simply drops off, like any long
// chat). The system message is rebuilt fresh each turn: instructions + a
// current fleet-status line, mirroring what Rust chat_send prepends for
// codex.
//
// Interrupt: `interruptOpenRouterTurn` flips a per-chat abort flag (checked
// between loop iterations and between tool calls) AND cancels the in-flight
// Rust stream (`openrouter_chat_cancel`) — so a stop lands within one chunk
// or one tool call, whichever is running.

import { invoke } from "@tauri-apps/api/core";
import { useSwarm } from "@/store";
import type {
  OrchestratorWireMessage,
  OrchestratorWireToolCall,
} from "@/types";
import { useOrchestrator } from "./chat-store";
import { executors, type ToolExecutor } from "./executors";
import { fleetSummaryLine } from "./snapshot";
import type { OrchestratorChatEventKind } from "./chat";
import type { OrchestratorToolsResponse } from "./types";

/** Default model for OpenRouter orchestrator chats (Settings placeholder). */
export const DEFAULT_ORCHESTRATOR_MODEL = "google/gemini-3.5-flash";
/** Max model↔tool iterations per turn — then the turn stops with a warning. */
const MAX_ITERATIONS = 15;
/** Tool results are JSON-stringified and truncated to roughly this size. */
const MAX_TOOL_RESULT_CHARS = 8_000;
/** One-line args summary cap — mirrors protocol.rs summarize_args. */
const ARGS_SUMMARY_MAX = 160;

/** The assembled assistant message `openrouter_chat_completion` resolves with. */
interface AssembledAssistant {
  content: string | null;
  tool_calls: OrchestratorWireToolCall[] | null;
  /** "stop" | "tool_calls" | "cancelled" | … */
  finish_reason: string | null;
}

// instructions + registry are static per app run — fetch once, share
let catalogPromise: Promise<OrchestratorToolsResponse> | null = null;
function fetchToolCatalog(): Promise<OrchestratorToolsResponse> {
  catalogPromise ??= invoke<OrchestratorToolsResponse>("orchestrator_tools");
  return catalogPromise;
}

/** Per-chat abort flags for the running turn (in-memory). */
const aborts = new Map<string, { aborted: boolean }>();

/**
 * Stop the chat's running OpenRouter turn: abort flag (loop boundaries) +
 * Rust-side stream cancel (chunk boundaries). Streamed partial text stays.
 */
export function interruptOpenRouterTurn(chatId: string): void {
  const flag = aborts.get(chatId);
  if (flag) flag.aborted = true;
  void invoke("openrouter_chat_cancel", { chatId }).catch(() => {});
}

/** Drop the chat's loop state (chat deleted). */
export function dropOpenRouterChat(chatId: string): void {
  interruptOpenRouterTurn(chatId);
  aborts.delete(chatId);
}

function summarizeArgs(argumentsJson: string): string {
  const s = argumentsJson.replace(/\s+/g, " ").trim() || "{}";
  return s.length > ARGS_SUMMARY_MAX ? `${s.slice(0, ARGS_SUMMARY_MAX)}…` : s;
}

function appendWire(chatId: string, messages: OrchestratorWireMessage[]): void {
  useOrchestrator.getState().appendWireMessages(chatId, messages);
}

function currentWire(chatId: string): OrchestratorWireMessage[] {
  return (
    useOrchestrator.getState().chats.find((c) => c.id === chatId)?.wire ?? []
  );
}

export interface OpenRouterTurnOpts {
  /**
   * The controller's chat-event router — the loop feeds it synthesized
   * events (turn_started, tool_call/tool_done, message, turn_completed, …)
   * so tool chips, pane-ref diffs and stream finalization behave EXACTLY
   * like the codex path. Passed in (instead of imported) to keep
   * controller ↔ loop free of an import cycle.
   */
  emit: (kind: OrchestratorChatEventKind, data: Record<string, unknown>) => void;
}

/**
 * Execute one streamed tool call directly against the local executors.
 * Returns the tool-result wire content (JSON string, truncated; errors as
 * `ERROR: …` so the model can react — same convention as the codex bridge).
 */
async function executeToolCall(
  chatId: string,
  call: OrchestratorWireToolCall,
  opts: OpenRouterTurnOpts,
): Promise<string> {
  opts.emit("tool_call", {
    tool: call.name,
    args_summary: summarizeArgs(call.arguments_json),
  });
  let ok = false;
  let payload: string;
  try {
    const exec = (executors as Record<string, ToolExecutor>)[call.name];
    if (!exec)
      throw new Error(
        `unknown tool "${call.name}" — only the declared SwarmZ tools exist`,
      );
    let args: Record<string, unknown> = {};
    if (call.arguments_json.trim()) {
      const parsed: unknown = JSON.parse(call.arguments_json); // throws → ERROR result
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        args = parsed as Record<string, unknown>;
      else if (parsed !== null)
        throw new Error("tool arguments must be a JSON object");
    }
    const result = (await exec(args, { chatId })) ?? null;
    payload = typeof result === "string" ? result : JSON.stringify(result);
    ok = true;
  } catch (e) {
    payload = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }
  opts.emit("tool_done", { tool: call.name, ok });
  if (payload.length > MAX_TOOL_RESULT_CHARS)
    payload = `${payload.slice(0, MAX_TOOL_RESULT_CHARS)} …[truncated]`;
  return payload;
}

/**
 * Run one full OpenRouter turn: append the user wire message, then loop
 * completion → tool calls → tool results until the model answers without
 * tool calls (or MAX_ITERATIONS / an interrupt stops it). Content tokens
 * stream as `delta` events from Rust (under the STORE chat id — the
 * controller self-links it); everything else is synthesized through
 * `opts.emit`. Fatal errors resolve into a `turn_failed` event (the shared
 * handler adds the warning message) — this function never rejects.
 */
export async function runOpenRouterTurn(
  chatId: string,
  wireText: string,
  opts: OpenRouterTurnOpts,
): Promise<void> {
  const chat = useOrchestrator.getState().chats.find((c) => c.id === chatId);
  if (!chat) return;
  const model =
    chat.model?.trim() ||
    useSwarm.getState().settings.orchestratorModel?.trim() ||
    DEFAULT_ORCHESTRATOR_MODEL;
  const flag = { aborted: false };
  aborts.set(chatId, flag);
  opts.emit("turn_started", {});
  try {
    const { instructions, tools } = await fetchToolCatalog();
    const wireTools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    // fresh each turn — mirrors the fleet line Rust chat_send prepends for
    // codex; the persisted wire history deliberately excludes it
    const system = `${instructions}\n\n[fleet status: ${fleetSummaryLine(useSwarm.getState())}]`;
    appendWire(chatId, [{ role: "user", content: wireText }]);

    for (let i = 0; ; i++) {
      if (flag.aborted) {
        opts.emit("turn_completed", { status: "interrupted" });
        return;
      }
      if (i >= MAX_ITERATIONS) {
        opts.emit("warning", {
          message: `stopped after ${MAX_ITERATIONS} tool iterations in one turn — send a follow-up to continue`,
        });
        opts.emit("turn_completed", { status: "completed" });
        return;
      }
      const messages = [
        { role: "system", content: system },
        ...currentWire(chatId),
      ];
      const res = await invoke<AssembledAssistant>("openrouter_chat_completion", {
        chatId,
        model,
        messages,
        tools: wireTools,
      });
      const toolCalls = res.tool_calls ?? [];
      appendWire(chatId, [
        {
          role: "assistant",
          content: res.content,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
      ]);
      if (res.finish_reason === "cancelled" || flag.aborted) {
        // partial text already streamed as deltas; turn end finalizes it
        opts.emit("turn_completed", { status: "interrupted" });
        return;
      }
      if (!toolCalls.length) {
        opts.emit("message", { text: res.content ?? "" });
        opts.emit("turn_completed", { status: "completed" });
        return;
      }
      // content alongside tool calls: close it out as its own message
      // (mirrors codex's completed agentMessage between tool batches)
      if (res.content) opts.emit("message", { text: res.content });
      for (const call of toolCalls) {
        // an interrupt between tool calls still answers the REMAINING calls
        // (the wire history must stay valid), just without executing them
        const content = flag.aborted
          ? "ERROR: turn was interrupted by the user before this call ran"
          : await executeToolCall(chatId, call, opts);
        appendWire(chatId, [
          { role: "tool", tool_call_id: call.id, content },
        ]);
      }
    }
  } catch (err) {
    opts.emit("turn_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (aborts.get(chatId) === flag) aborts.delete(chatId);
  }
}
