// The Conductor stage (Phase 5, project-scoped since Phase 3) — the
// Conductor chat of the ACTIVE PROJECT rendered IN the Vibe FocusStage
// (Orchestrator-first). It reuses the shared chat view + switcher from
// components/orchestrator/ChatView (both filtered to the project), so every
// surface shows the SAME chat store, never a duplicate. The composer sends
// to the Conductor — unless the message starts with `@session`, which routes
// the text directly to that native session instead.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowUp, Plus, Square } from "lucide-react";
import {
  activeChatIdFor,
  useOrchestrator,
} from "@/lib/orchestrator/chat-store";
import {
  createChat,
  ensureFreshProjectChat,
  interrupt,
  sendMessage as orchestratorSend,
} from "@/lib/orchestrator/controller";
import { useProjects } from "@/lib/projects/store";
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
  const projectId = useProjects((s) => s.activeProjectId);
  const activeChatId = useOrchestrator((s) =>
    projectId ? activeChatIdFor(s, projectId) : null,
  );

  // the stage always shows a chat of THIS project: the first visit per app
  // run gets a fresh (or reused-empty) chat — yesterday's context must not
  // absorb today's first order; later visits restore the remembered one
  useEffect(() => {
    if (projectId) ensureFreshProjectChat(projectId);
  }, [projectId]);
  useEffect(() => {
    if (projectId && !activeChatId) createChat(projectId);
  }, [projectId, activeChatId]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <ConductorHeader chatId={activeChatId} projectId={projectId} />
      {activeChatId ? (
        <MessageList chatId={activeChatId} />
      ) : (
        <NoProjectNotice hasProject={!!projectId} />
      )}
      <ConductorComposer chatId={activeChatId} projectId={projectId} />
    </div>
  );
}

function NoProjectNotice({ hasProject }: { hasProject: boolean }) {
  if (hasProject) return <div className="flex-1" />;
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <p className="max-w-64 text-center text-xs leading-relaxed text-muted-foreground">
        Open a project to talk to its Conductor — every project tab has its
        own.
      </p>
    </div>
  );
}

function ConductorHeader({
  chatId,
  projectId,
}: {
  chatId: string | null;
  projectId: string | null;
}) {
  const busy = useOrchestrator((s) => (chatId ? !!s.busy[chatId] : false));
  const persona = useSwarm((s) => effectivePersona(s.settings.orchestratorPersona));
  const projectName = useProjects((s) =>
    projectId ? (s.projects[projectId]?.name ?? "") : "",
  );
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
      {projectName && (
        <span className="min-w-0 truncate font-mono text-[10px] text-faint">
          {projectName}
        </span>
      )}
      <ChatSwitcher projectId={projectId} />
      <button
        onClick={() => projectId && createChat(projectId)}
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

function ConductorComposer({
  chatId,
  projectId,
}: {
  chatId: string | null;
  projectId: string | null;
}) {
  const busy = useOrchestrator((s) => (chatId ? !!s.busy[chatId] : false));
  const personaName = useSwarm(
    (s) => effectivePersona(s.settings.orchestratorPersona).name,
  );
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  // primitive signature (joined scoped ids) → build the mention candidates in
  // useMemo without a fresh-array selector (the useSyncExternalStore rule);
  // @mentions target THIS project's sessions only
  const idsSig = useVibe((s) =>
    (projectId
      ? s.order.filter((id) => s.sessions[id]?.session.projectId === projectId)
      : s.order
    ).join("|"),
  );
  const candidates: MentionCandidate[] = useMemo(() => {
    const v = useVibe.getState();
    return (idsSig ? idsSig.split("|") : []).map((id) => ({
      id,
      name: v.sessions[id]?.session.name ?? id,
    }));
  }, [idsSig]);

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
    // resolve against the LIVE session list of THIS project (names may have
    // changed since mount)
    const v = useVibe.getState();
    const live: MentionCandidate[] = v.order
      .filter(
        (id) => !projectId || v.sessions[id]?.session.projectId === projectId,
      )
      .map((id) => ({
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
    const id = chatId ?? createChat(projectId ?? undefined);
    if (!id) return; // no project open — nothing to send to
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
