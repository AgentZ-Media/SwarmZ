// Webview half of the orchestrator tool bus. Rust validates a tool call
// against the registry, emits `orchestrator://tool-request` and awaits our
// `orchestrator_tool_response` command (see src-tauri/src/orchestrator/).
// We look up the executor, run it, and ALWAYS respond — an unanswered
// request would burn its full timeout on the Rust side.
//
// Registered once from App.tsx, same pattern as lib/quit.ts.

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { IS_TAURI } from "@/lib/transport";
import { chatIdForBackend } from "./controller";
import { executors, type ToolExecutor } from "./executors";
import type { OrchestratorToolRequest } from "./types";

let started = false;

async function handleRequest(req: OrchestratorToolRequest): Promise<void> {
  let ok = false;
  let payload: unknown;
  try {
    const exec: ToolExecutor | undefined = (
      executors as Record<string, ToolExecutor>
    )[req.tool];
    // Rust rejects unknown names before emitting — this is a safety net for
    // a registry/executor drift, answered instead of timing out
    if (!exec)
      throw new Error(
        `no executor registered for tool "${req.tool}" (registry/executor drift?)`,
      );
    // req.chat_id is the BACKEND chat id (None for dev-hook calls) — resolve
    // it to the store chat so executors can track touched panes (Phase 5);
    // req.project_id is the Conductor instance's project (Phase 3) — the
    // executors scope session resolution + fleet_snapshot on it. `""` is NOT
    // a scope (Rust normalizes it away too): `|| null` keeps a legacy
    // empty-string project id unscoped instead of filtering the fleet down
    // to the nonexistent project "".
    payload =
      (await exec(req.args ?? {}, {
        chatId: chatIdForBackend(req.chat_id),
        projectId: req.project_id || null,
      })) ?? null;
    ok = true;
  } catch (e) {
    // error payloads are plain message strings (bus.rs expects that shape)
    payload = e instanceof Error ? e.message : String(e);
  }
  try {
    await invoke("orchestrator_tool_response", { id: req.id, ok, payload });
  } catch (e) {
    console.error("[orchestrator] failed to deliver tool response", e);
  }
}

/**
 * Start listening for tool requests. Returns a stop function. Guarded
 * against double registration (StrictMode remounts, HMR).
 */
export function startOrchestratorBus(): () => void {
  if (!IS_TAURI || started) return () => {};
  started = true;
  const unlistenP = listen<OrchestratorToolRequest>(
    "orchestrator://tool-request",
    (event) => void handleRequest(event.payload),
  );
  return () => {
    started = false;
    void unlistenP.then((u) => u());
  };
}
