// The Conductor stage (Phase 5) — the orchestrator chat rendered IN the Vibe
// FocusStage (Orchestrator-first). It reuses the shared chat view + switcher
// from components/orchestrator/ChatView, so this stage and the ⌘⇧O panel show
// the SAME chat store, never a duplicate. The composer sends to the
// orchestrator — unless the message starts with `@session`, which routes the
// text directly to that native session instead.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowUp, Plus, Square } from "lucide-react";
import { useOrchestrator } from "@/lib/orchestrator/chat-store";
import {
  createChat,
  interrupt,
  sendMessage as orchestratorSend,
} from "@/lib/orchestrator/controller";
import { useVibe } from "@/lib/vibe/session-store";
import { sendMessage as vibeSend } from "@/lib/vibe/controller";
import {
  mentionQuery,
  parseSessionMention,
  type MentionCandidate,
} from "@/lib/vibe/mention";
import {
  CHAT_MAX_W,
  ChatMeta,
  ChatSwitcher,
  MessageList,
} from "@/components/orchestrator/ChatView";
import { useSwarm } from "@/store";
import { effectivePersona } from "@/lib/orchestrator/persona";
import { cn } from "@/lib/utils";

const MAX_ROWS_PX = 168; // ~6 lines

export function ConductorStage() {
  const activeChatId = useOrchestrator((s) => s.activeChatId);

  // the stage always shows a chat; createChat reuses a leftover empty one
  useEffect(() => {
    if (!activeChatId) createChat();
  }, [activeChatId]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <ConductorHeader chatId={activeChatId} />
      {activeChatId ? (
        <MessageList chatId={activeChatId} />
      ) : (
        <div className="flex-1" />
      )}
      <ConductorComposer chatId={activeChatId} />
    </div>
  );
}

function ConductorHeader({ chatId }: { chatId: string | null }) {
  const busy = useOrchestrator((s) => (chatId ? !!s.busy[chatId] : false));
  const persona = useSwarm((s) => effectivePersona(s.settings.orchestratorPersona));
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-4 py-2.5">
      {persona.emoji ? (
        <span className="shrink-0 text-[13px] leading-none">{persona.emoji}</span>
      ) : (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ring" />
      )}
      <span className="text-[13px] font-semibold text-foreground">
        {persona.name}
      </span>
      <ChatSwitcher />
      <button
        onClick={() => createChat()}
        title="New chat"
        className="focus-ring flex h-6 w-6 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground"
      >
        <Plus size={13} />
      </button>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {chatId && <ChatMeta chatId={chatId} />}
        {busy && chatId && (
          <button
            onClick={() => interrupt(chatId)}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 font-mono text-[10px] text-muted-foreground hover:bg-accent"
            title="Stop the running turn"
          >
            <Square size={10} className="fill-current" /> Stop
          </button>
        )}
      </div>
    </div>
  );
}

function ConductorComposer({ chatId }: { chatId: string | null }) {
  const busy = useOrchestrator((s) => (chatId ? !!s.busy[chatId] : false));
  const personaName = useSwarm(
    (s) => effectivePersona(s.settings.orchestratorPersona).name,
  );
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  // stable session-order ref (only changes on create/drop) → build the mention
  // candidates without a fresh-array selector (the useSyncExternalStore rule)
  const order = useVibe((s) => s.order);
  const candidates: MentionCandidate[] = useMemo(() => {
    const v = useVibe.getState();
    return order.map((id) => ({
      id,
      name: v.sessions[id]?.session.name ?? id,
    }));
  }, [order]);

  // auto-grow up to ~6 lines
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_ROWS_PX)}px`;
  }, [text]);

  const query = mentionQuery(text);
  const suggestions =
    query === null
      ? []
      : candidates
          .filter(
            (c) =>
              !query ||
              c.name.toLowerCase().startsWith(query.toLowerCase()) ||
              c.id.toLowerCase().startsWith(query.toLowerCase()),
          )
          .slice(0, 6);

  const pickSuggestion = (c: MentionCandidate) => {
    setText(`@${c.name} `);
    taRef.current?.focus();
  };

  const send = () => {
    const t = text.trim();
    if (!t) return;
    // resolve against the LIVE session list (names may have changed since mount)
    const v = useVibe.getState();
    const live: MentionCandidate[] = v.order.map((id) => ({
      id,
      name: v.sessions[id]?.session.name ?? id,
    }));
    const mention = parseSessionMention(t, live);
    if (mention) {
      // a bare "@session" with no body: keep typing, don't send an empty turn
      if (!mention.body.trim()) return;
      void vibeSend(mention.sessionId, mention.body);
      setText("");
      return;
    }
    const id = chatId ?? createChat();
    void orchestratorSend(id, t);
    setText("");
  };

  return (
    <div className={cn("relative mx-auto mb-4 w-full px-4", CHAT_MAX_W)}>
      {suggestions.length > 0 && (
        <div className="absolute bottom-full left-0 z-20 mb-1.5 w-64 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-lg">
          <div className="px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
            Message a session
          </div>
          {suggestions.map((c) => (
            <button
              key={c.id}
              onMouseDown={(e) => {
                // mousedown (not click) so the textarea keeps focus
                e.preventDefault();
                pickSuggestion(c);
              }}
              className="focus-ring flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs text-foreground hover:bg-accent"
            >
              <span className="text-ring">@</span>
              <span className="min-w-0 truncate">{c.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 rounded-[10px] border border-input bg-card px-3 py-2.5 focus-within:border-ring/60">
        <textarea
          ref={taRef}
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={`Message ${personaName} — or @session to talk to a session directly…`}
          className="min-h-[20px] flex-1 resize-none bg-transparent text-xs leading-relaxed text-foreground placeholder:text-faint focus:outline-none select-text"
        />
        {busy && chatId ? (
          <button
            onClick={() => interrupt(chatId)}
            title="Stop the running turn"
            className="focus-ring flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 font-mono text-[10px] text-muted-foreground hover:bg-accent"
          >
            <Square size={11} className="fill-current" /> Stop
          </button>
        ) : (
          <button
            onClick={send}
            disabled={!text.trim()}
            title="Send (↵)"
            className={cn(
              "focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-40",
            )}
          >
            <ArrowUp size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
