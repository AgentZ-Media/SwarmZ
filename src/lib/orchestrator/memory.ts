// Typed wrappers around the curated-memory Tauri commands (native-only direct
// invoke, like lib/worktree.ts). The file itself lives next to swarmz.json in
// the app data dir (orchestrator-memory.md); Rust owns the caps + FIFO. Used
// by the `remember` executor and the Settings memory-management UI.

import { invoke } from "@tauri-apps/api/core";
import type {
  OrchestratorMemoryAppend,
  OrchestratorMemoryEntry,
} from "./types";

/** Read the curated memory entries (newest last, as stored). */
export function readMemory(): Promise<OrchestratorMemoryEntry[]> {
  return invoke<OrchestratorMemoryEntry[]>("orchestrator_memory_read");
}

/** Append one fact; Rust enforces the caps and reports any FIFO drop. */
export function appendMemory(text: string): Promise<OrchestratorMemoryAppend> {
  return invoke<OrchestratorMemoryAppend>("orchestrator_memory_append", {
    text,
  });
}

/** Remove one entry by its index in the read order; returns the remaining. */
export function removeMemory(
  index: number,
): Promise<OrchestratorMemoryEntry[]> {
  return invoke<OrchestratorMemoryEntry[]>("orchestrator_memory_remove", {
    index,
  });
}
