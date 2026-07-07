import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowUp,
  Bot,
  ChevronDown,
  Cog,
  Plus,
  RotateCw,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import { useSwarm } from "@/store";
import {
  DEFAULT_CHAT_TITLE,
  useOrchestrator,
} from "@/lib/orchestrator/chat-store";
import {
  createChat,
  interrupt,
  refreshStatus,
  removeChat,
  sendMessage,
} from "@/lib/orchestrator/controller";
import { DEFAULT_ORCHESTRATOR_MODEL } from "@/lib/orchestrator/openrouter-loop";
import type { OrchestratorChatStatus } from "@/lib/orchestrator/chat";
import { fetchKeyStatus } from "@/lib/openrouter";
import { focusTerm } from "@/lib/term-host";
import { Button } from "./ui/button";
import { Tip } from "./ui/tooltip";
import { OrchestratorMarkdown } from "./OrchestratorMarkdown";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { cn } from "@/lib/utils";
import type {
  OpenrouterKeyStatus,
  OrchestratorChatMessage,
  OrchestratorPaneRef,
} from "@/types";

/**
 * Orchestrator chat sidebar (⌘⇧O / title-bar bot button): a persistent,
 * resizable right panel where the user talks to the Codex-brained
 * orchestrator while watching the grid next to it. A real flex SIBLING of
 * the workspace area (see App.tsx) — opening it squeezes the grid and the
 * PTYs resize via the normal ResizeObserver path, unlike the overlay
 * drawers (notes/usage). Deliberately NOT a role="dialog": the panel stays
 * open during work and global shortcuts keep firing while it's up.
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
      <PanelHeader />
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

/**
 * Title + chat switcher (a popover list — chips don't fit 30 chats at
 * 300 px). Deliberately a Popover of sibling BUTTONS rather than a Radix
 * menu: each row pairs "switch to chat" with a delete action, and a nested
 * role="button" inside a menuitem is unreachable by keyboard — as real
 * siblings both are plain tab stops (delete reveals on row hover AND on
 * keyboard focus).
 */
function PanelHeader() {
  const chats = useOrchestrator((s) => s.chats);
  const activeChatId = useOrchestrator((s) => s.activeChatId);
  const busy = useOrchestrator((s) => s.busy);
  const setActiveChat = useOrchestrator((s) => s.setActiveChat);
  const setPanelOpen = useOrchestrator((s) => s.setPanelOpen);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const active = chats.find((c) => c.id === activeChatId);

  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border pl-3 pr-1.5">
      <h2 className="shrink-0 text-xs font-semibold tracking-tight">
        Orchestrator
      </h2>
      {chats.length > 0 && (
        <Popover open={switcherOpen} onOpenChange={setSwitcherOpen}>
          <PopoverTrigger asChild>
            <button className="focus-ring flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
              <span className="min-w-0 truncate">
                {active?.title ?? DEFAULT_CHAT_TITLE}
              </span>
              {chats.length > 1 && (
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-faint">
                  {chats.length}
                </span>
              )}
              <ChevronDown size={11} className="shrink-0 text-faint" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="max-h-72 w-64 overflow-y-auto">
            {chats.map((c) => (
              <div
                key={c.id}
                className="group/chat flex items-center gap-1 rounded-md pr-1 hover:bg-accent"
              >
                <button
                  onClick={() => {
                    setActiveChat(c.id);
                    setSwitcherOpen(false);
                  }}
                  className="focus-ring flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-xs text-foreground"
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      busy[c.id]
                        ? "bg-warning"
                        : c.id === activeChatId
                          ? "bg-ring"
                          : "bg-faint/50",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                </button>
                <button
                  onClick={() => removeChat(c.id)}
                  title="Delete chat"
                  className="focus-ring flex h-4 w-4 shrink-0 items-center justify-center rounded text-faint opacity-0 hover:bg-destructive/15 hover:text-destructive focus-visible:opacity-100 group-hover/chat:opacity-100"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </PopoverContent>
        </Popover>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
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

const EMPTY_MESSAGES: OrchestratorChatMessage[] = [];

/**
 * Tiny provider/model indicator (Phase 6) — a chat keeps its brain for
 * life, so this shows what THIS chat runs on ("codex" /
 * "openrouter · google/gemini-3.5-flash"), not the current setting.
 */
function ProviderBadge({ chatId }: { chatId: string }) {
  const label = useOrchestrator((s) => {
    const chat = s.chats.find((c) => c.id === chatId);
    return (chat?.provider ?? "codex") === "openrouter"
      ? `openrouter · ${chat?.model || DEFAULT_ORCHESTRATOR_MODEL}`
      : "codex";
  });
  return (
    <div className="truncate pb-1 text-center font-mono text-[9px] tracking-wide text-faint">
      {label}
    </div>
  );
}

/** True when a subtle timestamp divider belongs above message `i`. */
function showTimestamp(messages: OrchestratorChatMessage[], i: number): boolean {
  if (i === 0) return true;
  return messages[i].at - messages[i - 1].at > 5 * 60_000;
}

function MessageList({ chatId }: { chatId: string }) {
  const messages = useOrchestrator(
    (s) => s.chats.find((c) => c.id === chatId)?.messages ?? EMPTY_MESSAGES,
  );
  const isBusy = useOrchestrator((s) => !!s.busy[chatId]);
  const ref = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // auto-stick to the bottom unless the user scrolled up (48 px tolerance)
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, isBusy]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  if (messages.length === 0) return <EmptyChat chatId={chatId} />;

  const last = messages[messages.length - 1];
  // feedback between send and the first delta — unless a streaming message
  // (caret) or a pending tool chip (its own …) already shows activity
  const showThinking =
    isBusy &&
    !(last.role === "assistant" && last.streaming) &&
    !(last.role === "tool" && last.ok === undefined);

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3"
    >
      <ProviderBadge chatId={chatId} />
      <div className="flex flex-col gap-2">
        {messages.map((m, i) => (
          <Fragment key={m.id}>
            {showTimestamp(messages, i) && <TimeDivider at={m.at} />}
            <MessageRow msg={m} chatId={chatId} />
          </Fragment>
        ))}
        {showThinking && (
          <div className="font-mono text-[11px] leading-relaxed text-faint">
            <span className="streaming-caret">…</span>
          </div>
        )}
      </div>
    </div>
  );
}

function TimeDivider({ at }: { at: number }) {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const sameDay = new Date().toDateString() === d.toDateString();
  const day = sameDay
    ? ""
    : `${d.toLocaleDateString(undefined, { weekday: "short" })} `;
  return (
    <div className="py-0.5 text-center font-mono text-[9px] uppercase tracking-wider text-faint">
      {day}
      {time}
    </div>
  );
}

/** Memoized so only the streaming message re-renders during a turn. */
const MessageRow = memo(function MessageRow({
  msg,
  chatId,
}: {
  msg: OrchestratorChatMessage;
  /** stable per list — the memo still only re-renders on msg changes */
  chatId: string;
}) {
  switch (msg.role) {
    case "user":
      return (
        <div className="flex justify-end pl-8">
          <div className="max-w-full whitespace-pre-wrap break-words rounded-lg bg-secondary px-2.5 py-1.5 text-xs leading-relaxed text-foreground select-text">
            {msg.text}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="break-words text-xs leading-relaxed text-foreground select-text">
          <OrchestratorMarkdown text={msg.text} />
          {msg.streaming && (
            <span className="streaming-caret ml-0.5 inline-block h-3 w-[5px] translate-y-[2px] rounded-[1px] bg-foreground/60" />
          )}
        </div>
      );
    case "tool":
      return <ToolRow msg={msg} />;
    case "warning":
      return (
        <div className="flex items-start gap-1.5 text-[11px] leading-relaxed text-warning select-text">
          <TriangleAlert size={11} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{msg.text}</span>
        </div>
      );
    case "system":
      return <SystemRow msg={msg} chatId={chatId} />;
  }
});

/**
 * Phase-5 status ping ("«api» finished"): quiet system line + the pane's
 * jump chip + a "Review" button that sends a normal (visible) user turn
 * asking for a transcript summary. Disabled while the chat is busy.
 */
function SystemRow({
  msg,
  chatId,
}: {
  msg: Extract<OrchestratorChatMessage, { role: "system" }>;
  chatId: string;
}) {
  const isBusy = useOrchestrator((s) => !!s.busy[chatId]);
  const pane = msg.paneRefs?.[0];
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] leading-relaxed text-faint select-text">
      <span
        className="min-w-0 break-words"
        title={new Date(msg.at).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        })}
      >
        {msg.text}
      </span>
      {msg.paneRefs?.map((p) => <PaneChip key={p.id} pane={p} />)}
      {pane && (
        <button
          disabled={isBusy}
          onClick={() =>
            void sendMessage(
              chatId,
              `Read the transcript tail of pane «${pane.name}» (${pane.id}) and summarize briefly: what got done, were there problems, and what do you suggest as the next step?`,
            )
          }
          title={`Summarize what "${pane.name}" produced`}
          className="focus-ring flex shrink-0 items-center rounded border border-border bg-secondary/50 px-1.5 py-px font-mono text-[10px] text-muted-foreground transition-colors hover:border-ring/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          Review
        </button>
      )}
    </div>
  );
}

/** Compact mono one-liner: `⚙ prompt_pane → ok` plus pane jump chips. */
function ToolRow({
  msg,
}: {
  msg: Extract<OrchestratorChatMessage, { role: "tool" }>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-[11px] text-muted-foreground">
      <Cog size={11} className="shrink-0 text-faint" />
      <span title={msg.argsSummary || undefined}>{msg.tool}</span>
      {msg.ok === undefined ? (
        <span className="text-faint">…</span>
      ) : msg.ok ? (
        <span className="text-faint">→ ok</span>
      ) : (
        <span className="text-warning">→ failed</span>
      )}
      {msg.paneRefs?.map((p) => <PaneChip key={p.id} pane={p} />)}
    </div>
  );
}

/** "→ pane" jump chip — same jump semantics as the command palette. */
function PaneChip({ pane }: { pane: OrchestratorPaneRef }) {
  // live name; the chip disappears once the pane is gone
  const name = useSwarm((s) => s.agents[pane.id]?.name);
  if (!name) return null;
  return (
    <button
      onClick={() => {
        useSwarm.getState().focusAgent(pane.id);
        focusTerm(pane.id);
      }}
      title={`Jump to pane "${name}"`}
      className="focus-ring flex shrink-0 items-center rounded border border-border bg-secondary/50 px-1.5 py-px font-mono text-[10px] text-muted-foreground transition-colors hover:border-ring/60 hover:text-foreground"
    >
      → {name}
    </button>
  );
}

function EmptyChat({ chatId }: { chatId: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="max-w-60 text-center">
        <Bot size={18} className="mx-auto text-faint" />
        <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
          Talk to the orchestrator about your fleet.
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-faint">
          It can inspect panes and transcripts, check git status, prompt
          agents, and spin up new panes or workspaces.
        </p>
        <div className="mt-2.5">
          <ProviderBadge chatId={chatId} />
        </div>
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
          placeholder="Message the orchestrator…"
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
