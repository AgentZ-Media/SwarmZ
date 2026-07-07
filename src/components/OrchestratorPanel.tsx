import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ArrowUp, Plus, RotateCw, Square, TriangleAlert, X } from "lucide-react";
import { useSwarm } from "@/store";
import { useOrchestrator } from "@/lib/orchestrator/chat-store";
import {
  createChat,
  interrupt,
  refreshStatus,
  sendMessage,
} from "@/lib/orchestrator/controller";
import type { OrchestratorChatStatus } from "@/lib/orchestrator/chat";
import { effectivePersona } from "@/lib/orchestrator/persona";
import { fetchKeyStatus } from "@/lib/openrouter";
import { Button } from "./ui/button";
import { Tip } from "./ui/tooltip";
import { ChatMeta, ChatSwitcher, MessageList } from "./orchestrator/ChatView";
import type { OpenrouterKeyStatus } from "@/types";

/**
 * Orchestrator chat sidebar (⌘⇧O / title-bar bot button): a persistent,
 * resizable right panel where the user talks to the Codex-brained
 * orchestrator while watching the grid next to it. A real flex SIBLING of
 * the workspace area (see App.tsx) — opening it squeezes the grid and the
 * PTYs resize via the normal ResizeObserver path, unlike the overlay
 * drawers (notes/usage). Deliberately NOT a role="dialog": the panel stays
 * open during work and global shortcuts keep firing while it's up.
 *
 * The message list + chat switcher are shared with the Vibe Conductor stage
 * (components/orchestrator/ChatView.tsx) — both render the same chat store.
 */
export function OrchestratorPanel() {
  const open = useOrchestrator((s) => s.panelOpen);
  const activeChatId = useOrchestrator((s) => s.activeChatId);
  const hasActive = useOrchestrator((s) => !!s.activeChatId);
  const width = useOrchestrator((s) => s.panelWidth);

  // provider of the ACTIVE chat — codex chats gate on the app-server check,
  // openrouter chats gate on the stored key instead (see InputArea)
  const activeProvider = useOrchestrator((s) => {
    const chat = s.chats.find((c) => c.id === s.activeChatId);
    return chat?.provider ?? "codex";
  });

  // codex availability — checked once per app run, on the first open with a
  // codex chat active, so a dead or logged-out codex shows a quiet notice
  // instead of the input erroring. Never spawns the app-server for a pure
  // OpenRouter setup.
  const checkedRef = useRef(false);
  useEffect(() => {
    if (!open || checkedRef.current || activeProvider !== "codex") return;
    checkedRef.current = true;
    void refreshStatus();
  }, [open, activeProvider]);

  // the open panel always shows a chat (also after deleting the last one);
  // createChat stamps the provider/model from the current settings
  useEffect(() => {
    if (open && !hasActive) createChat();
  }, [open, hasActive]);

  if (!open) return null;
  return (
    <aside
      aria-label="Orchestrator"
      style={{ width }}
      className="relative flex h-full min-h-0 shrink-0 flex-col border-l border-border bg-background"
    >
      <ResizeHandle />
      <PanelHeader chatId={activeChatId} />
      {activeChatId ? (
        <Fragment key={activeChatId}>
          <MessageList chatId={activeChatId} />
          <InputArea chatId={activeChatId} />
        </Fragment>
      ) : (
        <div className="flex-1" />
      )}
    </aside>
  );
}

/**
 * Left-edge resize handle: pointer capture, live width updates (the grid —
 * and its terminals — resize along, which is expected here), clamped in the
 * store; the debounced persist after the last move covers "on release".
 */
function ResizeHandle() {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = useOrchestrator.getState().panelWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => {
      // dragging left grows the panel; setPanelWidth clamps
      useOrchestrator.getState().setPanelWidth(startWidth + (startX - ev.clientX));
    };
    const onUp = (ev: PointerEvent) => {
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        /* already released */
      }
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  };
  return (
    <div
      onPointerDown={onPointerDown}
      className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-ring/40 active:bg-ring/60"
    />
  );
}

/** Title + shared chat switcher + model/effort + context + new/close actions. */
function PanelHeader({ chatId }: { chatId: string | null }) {
  const setPanelOpen = useOrchestrator((s) => s.setPanelOpen);
  const persona = useSwarm((s) => effectivePersona(s.settings.orchestratorPersona));
  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border pl-3 pr-1.5">
      <h2 className="flex shrink-0 items-center gap-1 text-xs font-semibold tracking-tight">
        {persona.emoji && <span>{persona.emoji}</span>}
        {persona.name}
      </h2>
      <ChatSwitcher />
      <div className="ml-auto flex min-w-0 shrink items-center gap-1">
        {chatId && <ChatMeta chatId={chatId} />}
        <Tip label="New chat">
          <Button size="xs" variant="ghost" onClick={() => createChat()}>
            <Plus size={13} />
          </Button>
        </Tip>
        <Tip label="Close (⌘⇧O)">
          <Button size="xs" variant="ghost" onClick={() => setPanelOpen(false)}>
            <X size={13} />
          </Button>
        </Tip>
      </div>
    </div>
  );
}

function availabilityProblem(status: OrchestratorChatStatus | null): string | null {
  if (!status) return null;
  if (!status.running)
    return status.error
      ? `Codex isn't available: ${status.error}`
      : "The codex app-server isn't running.";
  if (status.account && status.account.logged_in === false)
    return "Codex isn't logged in — run `codex login` in a terminal, then check again.";
  return null;
}

/**
 * OpenRouter chats gate on the stored key instead of the codex app-server.
 * `null` (not fetched yet) and unverifiable keys don't block — a real send
 * error is clearer than a false negative.
 */
function openrouterProblem(status: OpenrouterKeyStatus | null): string | null {
  if (!status) return null;
  if (!status.present)
    return "No OpenRouter API key stored — see Settings → Orchestrator, then check again.";
  if (status.valid === false)
    return "OpenRouter rejected the stored API key — see Settings → Orchestrator.";
  return null;
}

/** 6 rows of leading-5 (20 px). */
const MAX_INPUT_HEIGHT = 120;

function InputArea({ chatId }: { chatId: string }) {
  const isBusy = useOrchestrator((s) => !!s.busy[chatId]);
  const status = useOrchestrator((s) => s.status);
  const personaName = useSwarm(
    (s) => effectivePersona(s.settings.orchestratorPersona).name,
  );
  const provider = useOrchestrator(
    (s) => s.chats.find((c) => c.id === chatId)?.provider ?? "codex",
  );
  const keyStatus = useSwarm((s) => s.openrouterStatus);
  const [draft, setDraft] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  // opening the panel (and switching chats — keyed remount) puts the cursor
  // straight into the input
  useEffect(() => {
    taRef.current?.focus();
  }, []);

  // auto-grow 1–6 rows
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "0";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [draft]);

  const send = () => {
    const text = draft.trim();
    if (!text || isBusy) return;
    setDraft("");
    void sendMessage(chatId, text);
  };

  const problem =
    provider === "openrouter"
      ? openrouterProblem(keyStatus)
      : availabilityProblem(status);
  const recheck = () => {
    if (provider === "openrouter")
      void fetchKeyStatus().then(
        (st) => useSwarm.getState().setOpenrouterStatus(st),
        () => {},
      );
    else void refreshStatus();
  };
  if (problem) {
    return (
      <div className="shrink-0 border-t border-border px-3 py-2.5">
        <div className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <TriangleAlert size={11} className="mt-0.5 shrink-0 text-warning" />
          <span className="min-w-0 flex-1 break-words">{problem}</span>
          <Tip label="Check again">
            <button
              onClick={recheck}
              className="focus-ring flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint hover:bg-accent hover:text-foreground"
            >
              <RotateCw size={11} />
            </button>
          </Tip>
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-border p-2.5">
      <div className="flex items-end gap-1.5 rounded-md border border-border bg-secondary/60 py-1.5 pl-2.5 pr-1.5 transition-colors focus-within:border-ring/60">
        <textarea
          ref={taRef}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            } else if (e.key === "Escape") {
              // blur only — Escape must NOT close the panel
              e.stopPropagation();
              e.currentTarget.blur();
            }
          }}
          placeholder={`Message ${personaName}…`}
          className="max-h-[120px] min-w-0 flex-1 resize-none bg-transparent text-xs leading-5 text-foreground outline-none placeholder:text-faint select-text"
        />
        {isBusy ? (
          <Tip label="Stop the running turn">
            <Button size="xs" variant="secondary" onClick={() => interrupt(chatId)}>
              <Square size={9} fill="currentColor" />
            </Button>
          </Tip>
        ) : (
          <Button
            size="xs"
            disabled={!draft.trim()}
            onClick={send}
            title="Send (Enter)"
          >
            <ArrowUp size={13} />
          </Button>
        )}
      </div>
    </div>
  );
}
