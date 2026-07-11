// Dev-only smoke-test surface for the orchestrator (sensing + tool bus +
// app-server brain). Loaded from App.tsx via a DEV-guarded dynamic import,
// so production builds tree-shake the whole module. In the devtools console:
//
//   __orch.snapshot()                              // session snapshot
//   __orch.summary()                               // "3 sessions · 1 working · …"
//   await __orch.discoverProjects([])              // merged project list
//   await __orch.projectDocs("/path/to/repo")      // README/AGENTS/CLAUDE.md
//   await __orch.readTranscript({ sessionId })
//
//   await __orch.tools()                           // { instructions, tools }
//   await __orch.tool("fleet_snapshot", {})        // FULL roundtrip:
//     Rust validate → event → webview executor → response command → Rust
//
//   await __orch.chatStatus()                      // spawn + version + account
//   const { chat_id } = await __orch.chatStart()   // new brain chat
//   await __orch.chatSend(chat_id, "Welche Sessions laufen?")
//     // streamed events log as `[orch chat-1] tool_call …` while it runs
//   await __orch.chatInterrupt(chat_id)            // stop the running turn

import { invoke } from "@tauri-apps/api/core";
import { fleetSummaryLine } from "./snapshot";
import { fleetSessions } from "./executors";
import { discoverProjects, projectDocs, readTranscript } from "./native";
import {
  chatInterrupt,
  chatResume,
  chatSend,
  chatStart,
  chatStatus,
  onChatEvent,
} from "./chat";
import type { OrchestratorToolsResponse } from "./types";

declare global {
  interface Window {
    __orch?: {
      snapshot: () => ReturnType<typeof fleetSessions>;
      summary: () => string;
      readTranscript: typeof readTranscript;
      projectDocs: typeof projectDocs;
      discoverProjects: typeof discoverProjects;
      /** instructions + tool catalog straight from the Rust registry */
      tools: () => Promise<OrchestratorToolsResponse>;
      /** run one tool through the full Rust→webview→Rust roundtrip */
      tool: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
      /** Codex app-server brain */
      chatStart: typeof chatStart;
      chatSend: typeof chatSend;
      chatInterrupt: typeof chatInterrupt;
      chatResume: typeof chatResume;
      chatStatus: typeof chatStatus;
    };
  }
}

if (import.meta.env.DEV) {
  // log every streamed chat event, prefixed with its chat id — registered
  // lazily so the listener only exists once a chat API was actually used
  let logging = false;
  const ensureEventLog = () => {
    if (logging) return;
    logging = true;
    onChatEvent((e) => {
      console.log(`[orch ${e.chat_id}] ${e.kind}`, e.data);
    });
  };

  window.__orch = {
    snapshot: () => fleetSessions(),
    // session-aware, like the fleet-summary Rust prepends to every turn
    summary: () => fleetSummaryLine(fleetSessions()),
    readTranscript,
    projectDocs,
    discoverProjects,
    tools: () => invoke<OrchestratorToolsResponse>("orchestrator_tools"),
    tool: (name, args = {}) =>
      invoke("orchestrator_run_tool", { tool: name, args }),
    chatStart: (project) => {
      ensureEventLog();
      return chatStart(project);
    },
    chatSend: (chatId, text) => {
      ensureEventLog();
      return chatSend(chatId, text);
    },
    chatInterrupt,
    chatResume: (threadId, project) => {
      ensureEventLog();
      return chatResume(threadId, project);
    },
    chatStatus,
  };
}
