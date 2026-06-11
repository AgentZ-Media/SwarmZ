import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import { useSwarm } from "@/store";
import { Tip } from "./ui/tooltip";
import { cn } from "@/lib/utils";
import {
  cancelTranscription,
  getDictationAnalyser,
  selectDictationReady,
  stopDictation,
  toggleDictation,
} from "@/lib/dictation";

/**
 * Mic button for pane / floating-terminal headers. Hidden until dictation is
 * usable (Settings → Voice: a working OpenRouter key, or the local model
 * downloaded when the engine is "local"); recording shows a pulsing red
 * icon, transcription a spinner. One dictation runs at a time, so the button
 * disables while another pane records.
 */
export function DictationButton({
  targetId,
  className,
}: {
  targetId: string;
  className?: string;
}) {
  const ready = useSwarm(selectDictationReady);
  const phase = useSwarm((s) =>
    s.dictation?.targetId === targetId ? s.dictation.phase : null,
  );
  const busyElsewhere = useSwarm(
    (s) => !!s.dictation && s.dictation.targetId !== targetId,
  );
  const hotkeyHint = useSwarm((s) =>
    (s.settings.dictationHotkeyMode ?? "hold") === "hold"
      ? "hold ⌘"
      : "⌘⇧M",
  );
  if (!ready) return null;

  const recording = phase === "recording";
  return (
    <Tip
      label={
        recording
          ? "Stop dictation"
          : phase === "transcribing"
            ? "Transcribing… (click to cancel)"
            : `Dictate (${hotkeyHint})`
      }
    >
      <button
        className={cn(
          "no-drag flex h-6 w-6 items-center justify-center rounded-md",
          recording
            ? "bg-destructive/15 text-destructive"
            : "text-faint hover:bg-accent hover:text-foreground",
          busyElsewhere && "cursor-not-allowed opacity-40",
          className,
        )}
        disabled={busyElsewhere}
        onClick={(e) => {
          e.stopPropagation();
          toggleDictation(targetId);
        }}
      >
        {phase === "transcribing" ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Mic size={13} className={recording ? "animate-pulse" : ""} />
        )}
      </button>
    </Tip>
  );
}

/**
 * Floating pill above the recording pane's terminal: live waveform + elapsed
 * time while recording (click stops), a spinner while transcribing, and the
 * error message when something failed. Rendered inside the terminal
 * container of the dictation target (agent pane or floating terminal).
 */
export function DictationOverlay({ targetId }: { targetId: string }) {
  const d = useSwarm((s) =>
    s.dictation?.targetId === targetId ? s.dictation : null,
  );
  if (!d) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
      {d.phase === "recording" ? (
        <button
          className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-border bg-popover/95 py-1.5 pl-3 pr-3.5 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.7)] backdrop-blur transition-colors hover:border-destructive/50"
          onClick={() => void stopDictation()}
          title="Stop & transcribe"
        >
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-50" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive" />
          </span>
          <Waveform />
          <Elapsed startedAt={d.startedAt} />
          <Square size={9} className="shrink-0 fill-current text-faint" />
        </button>
      ) : (
        <div
          className={cn(
            "pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-popover/95 px-3.5 py-1.5 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.7)] backdrop-blur",
            d.phase === "error" && "border-destructive/50",
          )}
        >
          {d.phase === "transcribing" ? (
            <>
              <Loader2 size={12} className="animate-spin text-ring" />
              <span className="text-xs text-muted-foreground">
                Transcribing…
              </span>
              <button
                className="text-xs text-faint hover:text-foreground"
                onClick={() => cancelTranscription()}
                title="Cancel transcription"
              >
                Cancel
              </button>
            </>
          ) : (
            <span className="max-w-72 truncate text-xs text-destructive">
              {d.error ?? "Dictation failed"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const BAR_COUNT = 28;
const WAVE_W = 88;
const WAVE_H = 18;

/** Scrolling level bars fed from the live AnalyserNode (lib/dictation.ts). */
function Waveform() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = WAVE_W * dpr;
    canvas.height = WAVE_H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    // canvas can't use CSS vars directly — resolve the inherited text color
    const color = getComputedStyle(canvas).color;

    const bars: number[] = [];
    const data = new Uint8Array(512);
    let last = 0;
    let raf = 0;

    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      const analyser = getDictationAnalyser();
      if (!analyser) return;
      if (t - last >= 50) {
        last = t;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        bars.push(Math.min(1, Math.sqrt(sum / data.length) * 4));
        if (bars.length > BAR_COUNT) bars.shift();
      }
      ctx.clearRect(0, 0, WAVE_W, WAVE_H);
      ctx.fillStyle = color;
      const step = WAVE_W / BAR_COUNT;
      for (let i = 0; i < bars.length; i++) {
        const h = Math.max(2, bars[i] * WAVE_H);
        const x = (BAR_COUNT - bars.length + i) * step;
        ctx.beginPath();
        ctx.roundRect(x, (WAVE_H - h) / 2, step - 1.5, h, 1);
        ctx.fill();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={ref}
      className="shrink-0 text-ring"
      style={{ width: WAVE_W, height: WAVE_H }}
    />
  );
}

function Elapsed({ startedAt }: { startedAt: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  return (
    <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
      {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
      <span className="text-faint"> / 5:00</span>
    </span>
  );
}
