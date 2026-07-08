import { useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Square, X } from "lucide-react";
import { useVibe } from "@/lib/vibe/session-store";
import { closeSession, interrupt } from "@/lib/vibe/controller";
import { useAgents } from "@/lib/agents/store";
import { deleteAgent, readAgent } from "@/lib/agents/api";
import { prettyModel } from "@/lib/utils";
import { ItemFeed } from "../vibe/ItemFeed";
import { Composer } from "../vibe/Composer";

/**
 * The Agent Builder's own focused MODAL. The Builder runs the same native
 * codex-app-server session as before (cwd = the agent's folder, workspace
 * access, the Builder guide as developer instructions) — only its PRESENTATION
 * moved here, out of the Vibe stage. A wide work-modal (dialog physics per
 * DESIGN.md, but ~80vh with its own scroll region) that stays open until the
 * user finishes: header · chat transcript (ItemFeed, diff cards included) ·
 * composer. The open session id lives in the agents store (`builderSessionId`).
 *
 * It deliberately does NOT dismiss on Escape or an outside click — a stray key
 * must never kill an in-progress build; the user closes via Finish / the ✕.
 */
export function BuilderModal() {
  const sessionId = useAgents((s) => s.builderSessionId);
  if (!sessionId) return null;
  return <BuilderModalInner key={sessionId} sessionId={sessionId} />;
}

function BuilderModalInner({ sessionId }: { sessionId: string }) {
  const exists = useVibe((s) => !!s.sessions[sessionId]);
  const name = useVibe((s) => s.sessions[sessionId]?.session.name ?? "");
  const slug = useVibe((s) => s.sessions[sessionId]?.session.builderForSlug ?? "");
  const model = useVibe((s) => s.sessions[sessionId]?.session.model);
  const effort = useVibe((s) => s.sessions[sessionId]?.session.effort);
  const busy = useVibe((s) => !!s.busy[sessionId]);

  const closeBuilderModal = useAgents((s) => s.closeBuilderModal);
  const refreshAgents = useAgents((s) => s.refreshAgents);

  // "no soul yet → offer Keep / Discard" state; otherwise close is immediate
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const [closing, setClosing] = useState(false);

  // the session vanished under us (e.g. quit choreography) → just close the modal
  useEffect(() => {
    if (!exists) closeBuilderModal();
  }, [exists, closeBuilderModal]);
  if (!exists) return null;

  /** End the codex session, re-scan the library, close the modal. Keeps files. */
  const finish = async () => {
    if (closing) return;
    setClosing(true);
    await closeSession(sessionId);
    await refreshAgents();
    closeBuilderModal();
  };

  /** Discard: end the session AND delete the (empty) draft folder. */
  const discard = async () => {
    if (closing) return;
    setClosing(true);
    await closeSession(sessionId);
    if (slug) {
      try {
        await deleteAgent(slug);
      } catch {
        /* best effort — a locked folder still leaves the modal closing */
      }
    }
    await refreshAgents();
    closeBuilderModal();
  };

  /** ✕ / outside intent: keep a real agent, but confirm before losing a blank
   * draft (no soul.md written yet). */
  const requestClose = async () => {
    if (closing || discardPrompt) return;
    if (slug) {
      try {
        const detail = await readAgent(slug);
        if (!detail.soul.trim()) {
          setDiscardPrompt(true);
          return;
        }
      } catch {
        /* can't read it → treat as a keepable close */
      }
    }
    void finish();
  };

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(o) => {
        if (!o) void requestClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] data-[state=open]:animate-in" />
        <DialogPrimitive.Content
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex h-[80vh] w-full max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-[0_16px_48px_-12px_rgba(0,0,0,0.7)] data-[state=open]:animate-dialog-in"
        >
          {/* header */}
          <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-4 py-3">
            <span aria-hidden className="shrink-0 text-base leading-none">
              🛠
            </span>
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight text-foreground">
              {name || "Building agent"}
            </DialogPrimitive.Title>

            <span className="flex shrink-0 items-center rounded-full border border-border bg-secondary px-2 py-0.5 font-mono text-[9px] text-muted-foreground">
              <span className="max-w-28 truncate">
                {model ? prettyModel(model) : "default model"}
              </span>
              {effort && <span className="text-faint"> · {effort}</span>}
            </span>

            {busy && (
              <button
                onClick={() => interrupt(sessionId)}
                title="Stop the running turn"
                className="focus-ring flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 font-mono text-[10px] text-muted-foreground hover:bg-accent"
              >
                <Square size={10} className="fill-current" /> Stop
              </button>
            )}
            <button
              onClick={() => void finish()}
              disabled={closing}
              className="focus-ring shrink-0 rounded-md border border-foreground bg-foreground px-3 py-1 text-[11px] font-semibold text-background hover:bg-foreground/90 disabled:opacity-50"
            >
              Finish
            </button>
            <button
              onClick={() => void requestClose()}
              disabled={closing}
              title="Close the Builder"
              className="focus-ring shrink-0 rounded p-1 text-faint transition-colors hover:text-foreground disabled:opacity-50"
            >
              <X size={16} />
            </button>
          </div>

          {/* transcript (diff cards for written files show here) */}
          <ItemFeed sessionId={sessionId} />

          {/* discard confirm for a blank draft, else the composer */}
          {discardPrompt ? (
            <DiscardBar
              onKeep={() => void finish()}
              onDiscard={() => void discard()}
              disabled={closing}
            />
          ) : (
            <Composer sessionId={sessionId} />
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function DiscardBar({
  onKeep,
  onDiscard,
  disabled,
}: {
  onKeep: () => void;
  onDiscard: () => void;
  disabled: boolean;
}) {
  return (
    <div className="mx-auto mb-4 flex w-full max-w-[46rem] items-center gap-2 rounded-[10px] border border-border bg-card px-3 py-2.5">
      <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground">
        Nothing was written yet. Keep the empty draft, or discard it?
      </span>
      <button
        onClick={onDiscard}
        disabled={disabled}
        className="focus-ring shrink-0 rounded-md border border-destructive/50 px-3 py-1 font-mono text-[10px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
      >
        Discard
      </button>
      <button
        onClick={onKeep}
        disabled={disabled}
        className="focus-ring shrink-0 rounded-md border border-border px-3 py-1 font-mono text-[10px] text-muted-foreground hover:bg-accent disabled:opacity-50"
      >
        Keep draft
      </button>
    </div>
  );
}
