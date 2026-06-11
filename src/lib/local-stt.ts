// Local speech-to-text (Parakeet TDT 0.6b v3 int8, src-tauri/src/localstt.rs)
// — native-only, so this skips the backend interface and invokes the Rust
// commands directly (like lib/openrouter.ts). The model runs fully on-device
// via ONNX Runtime: no Python, no network after the one-time ~670 MB download.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { IS_TAURI } from "./transport";
import type { LocalSttStatus, TranscriptionResult } from "@/types";

/** Shown in Settings next to the download — community-reported footprint. */
export const LOCAL_STT_MODEL_NAME = "Parakeet TDT 0.6b v3 (int8)";
export const LOCAL_STT_MODEL_URL =
  "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3";
export const LOCAL_STT_DOWNLOAD_MB = 671;
export const LOCAL_STT_RAM_GB = "1.5–2";

export async function fetchLocalSttStatus(): Promise<LocalSttStatus | null> {
  if (!IS_TAURI) return null;
  return invoke<LocalSttStatus>("local_stt_status");
}

/** Resolves when all model files are on disk (or rejects on error/cancel). */
export function downloadLocalSttModel(): Promise<void> {
  return invoke<void>("local_stt_download");
}

export function cancelLocalSttDownload(): Promise<void> {
  return invoke<void>("local_stt_cancel_download");
}

/** Delete the model from disk (and RAM, if loaded). */
export function removeLocalSttModel(): Promise<void> {
  return invoke<void>("local_stt_remove");
}

/** Drop the resident model (~2 GB) — next local dictation reloads it. */
export function unloadLocalSttModel(): Promise<void> {
  return invoke<void>("local_stt_unload");
}

/**
 * Transcribe one segment of 16 kHz mono 16-bit PCM (base64, no WAV header).
 * The first call after launch loads the model (a few seconds); it then stays
 * resident for fast follow-up dictations.
 */
export function transcribeAudioLocal(audio: string): Promise<TranscriptionResult> {
  return invoke<TranscriptionResult>("local_stt_transcribe", { audio });
}

/** Aggregate download progress across all model files. */
export function onLocalSttProgress(
  cb: (p: { downloaded: number; total: number }) => void,
): Promise<UnlistenFn> {
  return listen<{ downloaded: number; total: number }>(
    "localstt://progress",
    (e) => cb(e.payload),
  );
}
