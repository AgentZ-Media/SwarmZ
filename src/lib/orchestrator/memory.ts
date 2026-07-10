// Typed wrappers around the curated-memory Tauri commands (native-only direct
// invoke, like lib/worktree.ts). The files live under `orchestrator-memory/`
// next to swarmz.json in the app data dir — `global.md` plus one
// `<project_id>.md` per project; Rust owns the caps + FIFO and the one-time
// legacy migration (`orchestrator-memory.md` → `global.md`). Used by the
// `remember` executor and the Settings memory-management UI.

import { invoke } from "@tauri-apps/api/core";
import type {
  OrchestratorMemoryAppend,
  OrchestratorMemoryEntry,
} from "./types";

export type MemoryScope = "global" | "project";

/** Read one scope's entries (newest last, as stored). Scope "project" needs
 * the project id. */
export function readMemory(
  scope: MemoryScope,
  projectId?: string,
): Promise<OrchestratorMemoryEntry[]> {
  return invoke<OrchestratorMemoryEntry[]>("orchestrator_memory_read", {
    scope,
    projectId: projectId ?? null,
  });
}

/** Append one fact to a scope; Rust enforces the caps and reports any FIFO drop. */
export function appendMemory(
  text: string,
  scope: MemoryScope,
  projectId?: string,
): Promise<OrchestratorMemoryAppend> {
  return invoke<OrchestratorMemoryAppend>("orchestrator_memory_append", {
    text,
    scope,
    projectId: projectId ?? null,
  });
}

/** Remove one entry by its index in the read order; returns the remaining. */
export function removeMemory(
  index: number,
  scope: MemoryScope,
  projectId?: string,
): Promise<OrchestratorMemoryEntry[]> {
  return invoke<OrchestratorMemoryEntry[]>("orchestrator_memory_remove", {
    index,
    scope,
    projectId: projectId ?? null,
  });
}
