// Fleet toasts (Vibe v3) — transient event cards in the top-right corner,
// fed straight from the in-memory fleet event feed (lib/events.ts), which
// already dedupes waiting-flaps. Finished = ok, needs-approval = attn,
// created = accent spark; a click jumps to the agent. Auto-dismiss after 5 s.
// Deliberately DUMB: no store of its own beyond local state, initialized
// past the current feed so a mount never replays history.

import { useEffect, useRef, useState } from "react";
import { useFleetEvents, type FleetEvent } from "@/lib/events";
import { useVibe } from "@/lib/vibe/session-store";
import { focusSession } from "@/lib/vibe/controller";
import { cn } from "@/lib/utils";

const TOAST_TTL_MS = 5_000;
const MAX_VISIBLE = 3;

interface Toast {
  id: string;
  kind: FleetEvent["kind"];
  sessionId: string;
  title: string;
  sub: string;
}

const TOAST_STYLE: Partial<
  Record<FleetEvent["kind"], { glyph: string; cls: string; border: string }>
> = {
  finished: { glyph: "✓", cls: "text-ok", border: "border-ok/35" },
  waiting: { glyph: "⚑", cls: "text-attn", border: "border-attn/40" },
  created: { glyph: "✦", cls: "text-acc", border: "border-acc/40" },
};

function toToast(e: FleetEvent): Toast | null {
  switch (e.kind) {
    case "finished":
      return {
        id: e.id,
        kind: e.kind,
        sessionId: e.sessionId,
        title: `${e.sessionName} finished`,
        sub: "turn complete",
      };
    case "waiting":
      return {
        id: e.id,
        kind: e.kind,
        sessionId: e.sessionId,
        title: `${e.sessionName} needs you`,
        sub: "approval pending",
      };
    case "created":
      return {
        id: e.id,
        kind: e.kind,
        sessionId: e.sessionId,
        title: `${e.sessionName} started`,
        sub: "new agent",
      };
    default:
      // orch prompts and exits stay ticker-only — not toast-worthy
      return null;
  }
}

export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // never replay events that predate this mount
  const lastSeenRef = useRef<string | null>(null);
  // one auto-dismiss handle per visible toast — removed on fire/dismiss so
  // the map stays bounded over a long session
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const initial = useFleetEvents.getState().events;
    lastSeenRef.current = initial.length
      ? initial[initial.length - 1].id
      : null;
    const timers = timersRef.current;
    const unsub = useFleetEvents.subscribe((state) => {
      const events = state.events;
      // collect everything newer than the last seen id (usually 1)
      let startIdx = 0;
      if (lastSeenRef.current) {
        const idx = events.findIndex((e) => e.id === lastSeenRef.current);
        startIdx = idx === -1 ? Math.max(0, events.length - 1) : idx + 1;
      }
      const fresh = events
        .slice(startIdx)
        .map(toToast)
        .filter((t): t is Toast => t !== null);
      if (events.length) lastSeenRef.current = events[events.length - 1].id;
      if (fresh.length === 0) return;
      setToasts((prev) => [...prev, ...fresh].slice(-MAX_VISIBLE));
      for (const t of fresh) {
        timers.set(
          t.id,
          setTimeout(() => {
            timers.delete(t.id);
            setToasts((prev) => prev.filter((x) => x.id !== t.id));
          }, TOAST_TTL_MS),
        );
      }
    });
    return () => {
      unsub();
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  const dismiss = (id: string) => {
    const handle = timersRef.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((x) => x.id !== id));
  };

  if (toasts.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-3.5 top-[60px] z-[70] flex flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: () => void;
}) {
  const live = useVibe((s) => !!s.sessions[toast.sessionId]);
  const style = TOAST_STYLE[toast.kind];
  if (!style) return null;
  return (
    <button
      onClick={() => {
        onDismiss();
        if (live) focusSession(toast.sessionId);
      }}
      className={cn(
        "animate-ztoast pointer-events-auto flex items-center gap-2.5 rounded-xl border bg-pop px-3 py-2.5 text-left shadow-toast",
        style.border,
      )}
    >
      <span aria-hidden className={cn("shrink-0 font-mono text-13", style.cls)}>
        {style.glyph}
      </span>
      <span className="flex min-w-0 flex-col gap-px">
        <span className="truncate text-12 font-semibold text-txt">
          {toast.title}
        </span>
        <span className="truncate font-mono text-11 text-fnt">{toast.sub}</span>
      </span>
    </button>
  );
}
