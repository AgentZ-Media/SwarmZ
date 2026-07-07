// Dev-only smoke-test surface for the orchestrator (Phase 1 sensing +
// Phase 2 tool bus + Phase 3 app-server brain). Loaded from App.tsx via a
// DEV-guarded dynamic import, so production builds tree-shake the whole
// module. In the devtools console:
//
//   __orch.snapshot()                              // fleet snapshot
//   __orch.summary()                               // "8 panes · 3 busy · …"
//   await __orch.discoverProjects([])              // merged project list
//   await __orch.projectDocs("/path/to/repo")      // README/AGENTS/CLAUDE.md
//   await __orch.readTranscript({ cwd, sessionId, runtime: "claude" })
//
//   await __orch.tools()                           // { instructions, tools }
//   await __orch.tool("fleet_snapshot", {})        // FULL roundtrip:
//     Rust validate → event → webview executor → response command → Rust
//
//   await __orch.chatStatus()                      // spawn + version + account
//   const { chat_id } = await __orch.chatStart()   // new brain chat
//   await __orch.chatSend(chat_id, "Welche Panes sind offen?")
//     // streamed events log as `[orch chat-1] tool_call …` while it runs
//   await __orch.chatInterrupt(chat_id)            // stop the running turn

import { invoke } from "@tauri-apps/api/core";
import { useSwarm } from "@/store";
import { fleetSnapshot, fleetSummaryLine } from "./snapshot";
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
      snapshot: () => ReturnType<typeof fleetSnapshot>;
      summary: () => string;
      readTranscript: typeof readTranscript;
      projectDocs: typeof projectDocs;
      discoverProjects: typeof discoverProjects;
      /** instructions + tool catalog straight from the Rust registry */
      tools: () => Promise<OrchestratorToolsResponse>;
      /** run one tool through the full Rust→webview→Rust roundtrip */
      tool: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
      /** Phase 3 — Codex app-server brain */
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
    snapshot: () => fleetSnapshot(useSwarm.getState()),
    summary: () => fleetSummaryLine(useSwarm.getState()),
    readTranscript,
    projectDocs,
    discoverProjects,
    tools: () => invoke<OrchestratorToolsResponse>("orchestrator_tools"),
    tool: (name, args = {}) =>
      invoke("orchestrator_run_tool", { tool: name, args }),
    chatStart: () => {
      ensureEventLog();
      return chatStart();
    },
    chatSend: (chatId, text) => {
      ensureEventLog();
      return chatSend(chatId, text);
    },
    chatInterrupt,
    chatResume: (threadId) => {
      ensureEventLog();
      return chatResume(threadId);
    },
    chatStatus,
  };
}
