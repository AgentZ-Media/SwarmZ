// OpenRouter voice-dictation API — native-only, so this skips the backend
// interface and invokes the Rust commands directly (like lib/dnd.ts). The
// API key never touches the JS context: it lives in the macOS Keychain and
// every request is made from Rust (src-tauri/src/openrouter.rs).
import { invoke } from "@tauri-apps/api/core";
import { IS_TAURI } from "./transport";
import type {
  OpenrouterKeyStatus,
  OpenrouterModel,
  TranscriptionResult,
} from "@/types";

export const DEFAULT_STT_MODEL = "microsoft/mai-transcribe-1.5";
export const DEFAULT_CLEANUP_MODEL = "google/gemini-3.5-flash";

/**
 * Default system prompt of the cleanup pass. Dictation must work in every
 * language — the prompt's job is polish, never translation.
 */
export const DEFAULT_CLEANUP_PROMPT = `You clean up dictated voice transcripts before they are pasted into a terminal as a prompt for a coding agent.
- Remove filler words, stutters and false starts ("uh", "um", "äh", accidental repetitions).
- Fix punctuation, casing and obvious transcription glitches.
- Keep technical terms, file paths, identifiers and commands exactly as spoken.
- CRITICAL: keep the text in its ORIGINAL language — never translate.
- Do not answer, comment on or extend the content. Output only the cleaned transcript.`;

export async function fetchKeyStatus(): Promise<OpenrouterKeyStatus> {
  if (!IS_TAURI) return { present: false, valid: false };
  return invoke<OpenrouterKeyStatus>("openrouter_key_status");
}

/** Store the key in the Keychain and return its (re-)validated status. */
export function setOpenrouterKey(key: string): Promise<OpenrouterKeyStatus> {
  return invoke<OpenrouterKeyStatus>("openrouter_set_key", { key });
}

export function clearOpenrouterKey(): Promise<void> {
  return invoke<void>("openrouter_clear_key");
}

/** Text→text chat models from the public catalog (cleanup-model picker). */
export function fetchOpenrouterModels(): Promise<OpenrouterModel[]> {
  return invoke<OpenrouterModel[]>("openrouter_models");
}

/** Transcribe one ≤60s audio segment (base64-encoded bytes). */
export function transcribeAudio(
  audio: string,
  format: string,
  model: string,
): Promise<TranscriptionResult> {
  return invoke<TranscriptionResult>("openrouter_transcribe", {
    audio,
    format,
    model,
  });
}

/** LLM cleanup pass over a raw transcript (structured output in Rust). */
export function cleanupTranscript(
  text: string,
  model: string,
  prompt: string,
): Promise<string> {
  return invoke<string>("openrouter_cleanup", { text, model, prompt });
}
