// Voice dictation manager — lives outside React like term-host.ts. Records
// the mic in the webview (getUserMedia + MediaRecorder), transcribes via
// OpenRouter or the local Parakeet model (both Rust side, per
// settings.dictationEngine) and pastes the transcript into the target
// terminal. For the local engine the compressed recording is decoded and
// resampled to 16 kHz mono PCM here in the webview (OfflineAudioContext) —
// the Rust side only ever sees raw samples.
//
// The transcription endpoint takes complete uploads only and recommends ≤60s
// per request, so long dictations are recorded as rotating ~50s segments
// (a fresh MediaRecorder per segment — each blob is independently decodable)
// and transcribed sequentially after stop. Hard cap: 5 minutes.
import { useSwarm } from "@/store";
import { ptyWrite } from "./transport";
import { getTerm } from "./term-registry";
import {
  DEFAULT_CLEANUP_MODEL,
  DEFAULT_CLEANUP_PROMPT,
  DEFAULT_STT_MODEL,
  cleanupTranscript,
  transcribeAudio,
} from "./openrouter";
import { transcribeAudioLocal } from "./local-stt";

const MAX_MS = 5 * 60_000;
const SEGMENT_MS = 50_000;
/** plain-⌘ push-to-talk only opens the mic once ⌘ was held alone this long —
 * ordinary ⌘-shortcuts never trigger a recording (or the menu-bar mic dot) */
const ARM_DELAY_MS = 250;
/** discard recordings shorter than this instead of transcribing — OpenRouter
 * rejects near-empty audio, and accidental ⌘ taps shouldn't error */
const MIN_RECORD_MS = 1000;

let stream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let recorder: MediaRecorder | null = null;
/** chunks of the recorder currently running (one segment) */
let parts: Blob[] = [];
/** finished ≤50s segments, transcribed in order after stop */
let segments: Blob[] = [];
let mime = "";
let rotateTimer: ReturnType<typeof setInterval> | null = null;
let capTimer: ReturnType<typeof setTimeout> | null = null;
let stopping = false;
/** recording was started by the held push-to-talk key — only then do key
 * releases stop it (button/toggle recordings ignore them) */
let heldByHotkey = false;
/** pending plain-⌘ arm delay (see ARM_DELAY_MS) */
let armTimer: ReturnType<typeof setTimeout> | null = null;
/** generation of the current push-to-talk hold — bumped on every release/
 * cancel, so a startDictation still awaiting getUserMedia can detect that ⌘
 * was let go in the meantime and must not start recording (the mic would
 * stay hot for up to 5 minutes otherwise) */
let holdGen = 0;
/** in-flight 50s segment rotation — stopDictation awaits it so the rotating
 * segment can't be pushed into an already-discarded array */
let rotating: Promise<void> | null = null;
/** generation of the running transcription — bumped by cancelTranscription
 * (and by every new transcription), so an abandoned loop's awaits can detect
 * they're stale at every bail point. A plain boolean would be un-cancelled
 * by the next dictation and paste the discarded transcript after all. */
let transcribeGen = 0;

/** Live analyser of the running recording — the waveform pill reads it per frame. */
export function getDictationAnalyser(): AnalyserNode | null {
  return analyser;
}

/**
 * Plain ⌘ went down (hold mode): start push-to-talk once it stays held alone
 * for ARM_DELAY_MS. The delay keeps ordinary ⌘-shortcuts from ever opening
 * the mic; any other keydown disarms via cancelHoldDictation().
 */
export function armHoldDictation(getTarget: () => string | null): void {
  if (armTimer || useSwarm.getState().dictation || !dictationReady()) return;
  const gen = holdGen;
  armTimer = setTimeout(() => {
    armTimer = null;
    const target = getTarget();
    if (target) void startDictation(target, { viaHotkey: true, holdGen: gen });
  }, ARM_DELAY_MS);
}

/** A second key while armed/recording = a shortcut, not speech — abort silently. */
export function cancelHoldDictation(): void {
  holdGen++;
  if (armTimer) {
    clearTimeout(armTimer);
    armTimer = null;
  }
  if (heldByHotkey) void stopDictation(true);
}

/** ⌘ released (or the window blurred): transcribe what was held down. */
export function finishHoldDictation(): void {
  holdGen++;
  if (armTimer) {
    clearTimeout(armTimer);
    armTimer = null;
  }
  if (heldByHotkey) void stopDictation();
}

/**
 * Dictation is usable: local engine → model installed; OpenRouter engine →
 * key present and not explicitly rejected (unverified counts as usable).
 * Mirrored as a store selector by selectDictationReady (mic-button UI).
 */
export function dictationReady(): boolean {
  return selectDictationReady(useSwarm.getState());
}

export function selectDictationReady(s: {
  settings: { dictationEngine?: "openrouter" | "local" };
  openrouterStatus: { present: boolean; valid: boolean | null } | null;
  localSttStatus: { installed: boolean } | null;
}): boolean {
  if ((s.settings.dictationEngine ?? "openrouter") === "local")
    return !!s.localSttStatus?.installed;
  return !!s.openrouterStatus?.present && s.openrouterStatus.valid !== false;
}

function pickMime(): string {
  // WKWebView's MediaRecorder produces AAC-in-MP4 ("m4a" for the API);
  // opus/webm is preferred where available
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function apiFormat(m: string): string {
  return m.includes("webm") ? "webm" : "m4a";
}

function startRecorder() {
  if (!stream) return;
  parts = [];
  recorder = mime
    ? new MediaRecorder(stream, { mimeType: mime })
    : new MediaRecorder(stream);
  if (!mime) mime = recorder.mimeType || "audio/mp4";
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) parts.push(e.data);
  };
  recorder.start();
}

/** Stop the running recorder and resolve with its finished segment blob. */
function finishRecorder(): Promise<Blob | null> {
  return new Promise((resolve) => {
    const r = recorder;
    recorder = null;
    if (!r || r.state === "inactive") return resolve(null);
    r.onstop = () =>
      resolve(parts.length ? new Blob(parts, { type: mime }) : null);
    r.stop();
  });
}

async function rotateSegment() {
  if (stopping) return;
  const seg = await finishRecorder();
  if (seg) segments.push(seg);
  if (!stopping && stream) startRecorder();
}

function teardownAudio() {
  if (rotateTimer) clearInterval(rotateTimer);
  if (capTimer) clearTimeout(capTimer);
  rotateTimer = capTimer = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  void audioCtx?.close().catch(() => {});
  audioCtx = null;
  analyser = null;
  recorder = null;
  heldByHotkey = false;
}

function fail(targetId: string, startedAt: number, error: string) {
  const s = useSwarm.getState();
  const state = { targetId, phase: "error" as const, startedAt, error };
  s.setDictation(state);
  setTimeout(() => {
    // only clear if this exact error is still showing
    if (useSwarm.getState().dictation === state) s.setDictation(null);
  }, 5000);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    // data URL = "data:<mime>;base64,<payload>" — the API wants raw base64
    r.onload = () => resolve((r.result as string).split(",", 2)[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * Decode a recorded segment (webm/opus or mp4/aac) and resample it to what
 * the local Parakeet model expects: 16 kHz mono 16-bit PCM, base64-encoded
 * without a WAV header. Decoding at the native rate first and rendering
 * through an OfflineAudioContext is the resample path that works in WebKit.
 */
async function blobToPcm16k(blob: Blob): Promise<string> {
  const RATE = 16000;
  const probe = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await probe.decodeAudioData(await blob.arrayBuffer());
  } finally {
    void probe.close().catch(() => {});
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * RATE));
  const off = new OfflineAudioContext(1, frames, RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const mono = (await off.startRendering()).getChannelData(0);
  const pcm = new Int16Array(mono.length);
  for (let i = 0; i < mono.length; i++) {
    const v = Math.max(-1, Math.min(1, mono[i]));
    pcm[i] = Math.round(v < 0 ? v * 32768 : v * 32767);
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = "";
  // String.fromCharCode in bounded chunks — one call over minutes of audio
  // would blow the argument limit
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * Paste the transcript like the insert picker does: bracketed paste (claude
 * treats it as input, not keystrokes) plus a SEPARATE `\r` for auto-submit —
 * inside the paste it would only be a literal newline in claude's input box.
 */
function deliver(targetId: string, text: string, submit: boolean) {
  const term = getTerm(targetId);
  if (term) {
    term.paste(text);
    term.focus();
    if (submit) setTimeout(() => void ptyWrite(targetId, "\r"), 20);
  } else {
    void ptyWrite(targetId, submit ? text + "\r" : text);
  }
  const s = useSwarm.getState();
  if (s.agents[targetId]) s.focusAgent(targetId);
  else if (s.floatingTerminals[targetId]) s.raiseFloatingTerminal(targetId);
}

export async function startDictation(
  targetId: string,
  opts?: { viaHotkey?: boolean; holdGen?: number },
): Promise<void> {
  const s = useSwarm.getState();
  if (s.dictation || !dictationReady()) return;
  let mic: MediaStream;
  try {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    fail(targetId, Date.now(), "Microphone access denied");
    return;
  }
  // a second start may have won the race while we awaited the permission
  if (useSwarm.getState().dictation) {
    mic.getTracks().forEach((t) => t.stop());
    return;
  }
  // push-to-talk: ⌘ may have been released while getUserMedia resolved
  // (slow permission prompt) — starting now would leave the mic hot with
  // nothing left to stop it
  if (opts?.viaHotkey && opts.holdGen !== holdGen) {
    mic.getTracks().forEach((t) => t.stop());
    return;
  }
  stream = mic;
  stopping = false;
  heldByHotkey = !!opts?.viaHotkey;
  segments = [];
  mime = pickMime();
  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  audioCtx.createMediaStreamSource(stream).connect(analyser);
  startRecorder();
  rotateTimer = setInterval(() => {
    rotating = rotateSegment().finally(() => {
      rotating = null;
    });
  }, SEGMENT_MS);
  capTimer = setTimeout(() => void stopDictation(), MAX_MS);
  useSwarm
    .getState()
    .setDictation({ targetId, phase: "recording", startedAt: Date.now() });
}

export async function stopDictation(cancel = false): Promise<void> {
  const d = useSwarm.getState().dictation;
  if (!d || d.phase !== "recording" || stopping) return;
  stopping = true;
  // a segment rotation may be mid-flight at the 50s boundary — wait for it,
  // or its segment would be pushed into the discarded array below
  if (rotating) await rotating.catch(() => {});
  const last = await finishRecorder();
  if (last) segments.push(last);
  teardownAudio();
  const segs = segments;
  segments = [];
  // too short to contain speech (accidental ⌘ tap / instant release) —
  // discard instead of sending near-empty audio OpenRouter would reject
  const tooShort = Date.now() - d.startedAt < MIN_RECORD_MS;
  if (cancel || tooShort || segs.length === 0) {
    useSwarm.getState().setDictation(null);
    return;
  }
  useSwarm.getState().setDictation({ ...d, phase: "transcribing" });
  const gen = ++transcribeGen;
  try {
    const state = useSwarm.getState();
    const settings = state.settings;
    const local = (settings.dictationEngine ?? "openrouter") === "local";
    const fmt = apiFormat(mime);
    const sttModel = settings.dictationSttModel?.trim() || DEFAULT_STT_MODEL;
    const texts: string[] = [];
    for (const seg of segs) {
      // a long dictation transcribes minutes of segments sequentially —
      // the user can bail out instead of being locked out of the mic
      if (gen !== transcribeGen) return;
      const r = local
        ? await transcribeAudioLocal(await blobToPcm16k(seg))
        : await transcribeAudio(await blobToBase64(seg), fmt, sttModel);
      if (r.text.trim()) texts.push(r.text.trim());
    }
    let text = texts.join(" ").trim();
    // the cleanup pass always runs through OpenRouter — with the local
    // engine it only applies when a usable key happens to be stored too
    const cleanupUsable =
      !local ||
      (!!state.openrouterStatus?.present && state.openrouterStatus.valid !== false);
    if (text && settings.dictationCleanup && cleanupUsable) {
      try {
        text = await cleanupTranscript(
          text,
          settings.dictationCleanupModel?.trim() || DEFAULT_CLEANUP_MODEL,
          settings.dictationCleanupPrompt?.trim() || DEFAULT_CLEANUP_PROMPT,
        );
      } catch (e) {
        // the raw transcript is still useful — paste it instead, but leave
        // a trace (a silently skipped cleanup is near-impossible to debug)
        console.warn("dictation cleanup failed, pasting raw transcript:", e);
      }
    }
    if (gen !== transcribeGen) return;
    if (text) deliver(d.targetId, text, !!settings.dictationAutoSubmit);
    useSwarm.getState().setDictation(null);
  } catch (e) {
    if (gen === transcribeGen) fail(d.targetId, d.startedAt, String(e));
  }
}

/** Abandon an in-flight transcription — the transcript is discarded. */
export function cancelTranscription(): void {
  const d = useSwarm.getState().dictation;
  if (d?.phase !== "transcribing") return;
  transcribeGen++;
  useSwarm.getState().setDictation(null);
}

/** Mic-button click: start for this pane, stop the recording it owns, or
 * cancel a transcription that's taking too long. */
export function toggleDictation(targetId: string): void {
  const s = useSwarm.getState();
  const d = s.dictation;
  if (d?.phase === "error") {
    // a lingering error pill shouldn't block the next attempt
    s.setDictation(null);
    void startDictation(targetId);
  } else if (!d) {
    void startDictation(targetId);
  } else if (d.phase === "recording" && d.targetId === targetId) {
    void stopDictation();
  } else if (d.phase === "transcribing" && d.targetId === targetId) {
    cancelTranscription();
  }
}
