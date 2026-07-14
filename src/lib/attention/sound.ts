// A small generated cue for the one moment that deserves an interruption:
// an agent has newly entered a human-attention state. No media asset, network
// request or native permission is involved. The shared AudioContext is primed
// from a real gesture to satisfy WebKit/browser autoplay policy.

let audioContext: AudioContext | null = null;

function context(): AudioContext | null {
  if (audioContext && audioContext.state !== "closed") return audioContext;
  const AudioContextClass = window.AudioContext;
  if (!AudioContextClass) return null;
  audioContext = new AudioContextClass({ latencyHint: "interactive" });
  return audioContext;
}

/**
 * Prime or resume Web Audio inside a pointer/key gesture. Calling this is
 * harmless when Web Audio is unavailable or the context is already running.
 */
export async function primeAttentionSound(): Promise<boolean> {
  try {
    const audio = context();
    if (!audio) return false;
    if (audio.state === "suspended") await audio.resume();
    return audio.state === "running";
  } catch {
    return false;
  }
}

/** Register the smallest possible autoplay unlock boundary. */
export function installAttentionSoundUnlock(): () => void {
  let active = true;
  const remove = () => {
    if (!active) return;
    active = false;
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
  };
  const unlock = () => {
    void primeAttentionSound();
    remove();
  };
  window.addEventListener("pointerdown", unlock, { capture: true, once: true });
  window.addEventListener("keydown", unlock, { capture: true, once: true });
  return remove;
}

/**
 * Play a quiet, compact two-note cue. A fresh gain envelope for every note
 * prevents clicks; the shared context keeps repeated notifications cheap.
 */
export async function playAttentionSound(): Promise<boolean> {
  if (!(await primeAttentionSound())) return false;
  const audio = context();
  if (!audio) return false;

  try {
    const start = audio.currentTime + 0.01;
    const notes = [
      { frequency: 587.33, offset: 0, duration: 0.16 },
      { frequency: 783.99, offset: 0.13, duration: 0.24 },
    ];
    for (const note of notes) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const noteStart = start + note.offset;
      const noteEnd = noteStart + note.duration;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(note.frequency, noteStart);
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(0.075, noteStart + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteEnd + 0.01);
    }
    return true;
  } catch {
    return false;
  }
}

/** Pure edge detector used by the app watcher and its regression tests. */
export function newlyWaitingSessions(
  previous: ReadonlySet<string>,
  current: ReadonlySet<string>,
): string[] {
  return [...current].filter((sessionId) => !previous.has(sessionId));
}
