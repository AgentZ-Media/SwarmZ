// The Conductor SIDEBAR (Vibe v3) — the persistent left column that hosts the
// ACTIVE PROJECT's Conductor chat. Collapsible (⌘B / the title-bar toggle),
// resizable via the drag handle on its right edge. It reuses the shared chat
// view + switcher from components/orchestrator/ChatView (both filtered to the
// project), so every surface shows the SAME chat store, never a duplicate.
// The composer sends to the Conductor — unless the message starts with
// `@session`, which routes the text directly to that native session instead.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
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
import {
  autonomyTripped,
  subscribeAutonomy,
} from "@/lib/orchestrator/autonomy";
import { useProjects } from "@/lib/projects/store";
import { useVibe } from "@/lib/vibe/session-store";
import { sendMessage as vibeSend } from "@/lib/vibe/controller";
import {
  mentionQuery,
  parseSessionMention,
  type MentionCandidate,
} from "@/lib/vibe/mention";
import {
  ChatMeta,
  ChatSwitcher,
  MessageList,
} from "@/components/orchestrator/ChatView";
import { useSwarm } from "@/store";
import { effectivePersona } from "@/lib/orchestrator/persona";
import { useVibeUi } from "@/lib/vibe/ui-store";
import { cn } from "@/lib/utils";

const MAX_ROWS_PX = 168; // ~6 lines

export function ConductorSidebar() {
  const open = useVibeUi((s) => s.conductorOpen);
  const width = useVibeUi((s) => s.conductorWidth);
  const setWidth = useVibeUi((s) => s.setConductorWidth);
  const projectId = useProjects((s) => s.activeProjectId);
  const activeChatId = useOrchestrator((s) =>
    projectId ? activeChatIdFor(s, projectId) : null,
  );

  // the sidebar always shows a chat of THIS project: the first visit per app
  // run gets a fresh (or reused-empty) chat — yesterday's context must not
  // absorb today's first order; later visits restore the remembered one
  useEffect(() => {
    if (projectId) ensureFreshProjectChat(projectId);
  }, [projectId]);
  useEffect(() => {
    if (open && projectId && !activeChatId) createChat(projectId);
  }, [open, projectId, activeChatId]);

  // drag-to-resize: window listeners for the duration of one drag. Cleanup is
  // CENTRALIZED and re-entrant — mouseup, window blur (⌘-tab mid-drag) and
  // unmount all end the drag, so no listener or body cursor/userSelect ever
  // hangs when the drag is interrupted.
  const endDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => endDragRef.current?.(), []);
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    endDragRef.current?.();
    const startX = e.clientX;
    const startW = width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => setWidth(startW + ev.clientX - startX);
    const endDrag = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", endDrag);
      window.removeEventListener("blur", endDrag);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      endDragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", endDrag);
    window.addEventListener("blur", endDrag);
    endDragRef.current = endDrag;
  };

  if (!open) return null;

  return (
    <>
      <div
        className="relative flex shrink-0 flex-col overflow-hidden border-r border-line bg-panel"
        style={{ width }}
      >
        {/* decorative accent halo above the header */}
        <div className="conductor-glow pointer-events-none absolute -top-[70px] left-1/2 h-[180px] w-[380px] -translate-x-1/2" />

        <ConductorHeader chatId={activeChatId} projectId={projectId} />
        {activeChatId ? (
          <MessageList chatId={activeChatId} />
        ) : (
          <NoProjectNotice hasProject={!!projectId} />
        )}
        <BreakerNotice projectId={projectId} />
        <ConductorComposer chatId={activeChatId} projectId={projectId} />
      </div>
      {/* resize handle (straddles the border) */}
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        className="relative z-20 -mx-[3px] w-[7px] shrink-0 cursor-col-resize hover:bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--acc)_30%,transparent),transparent)]"
      />
    </>
  );
}

function NoProjectNotice({ hasProject }: { hasProject: boolean }) {
  if (hasProject) return <div className="flex-1" />;
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <p className="max-w-64 text-center text-12 leading-normal text-mut">
        Open a project to talk to its Conductor — every project tab has its
        own.
      </p>
    </div>
  );
}

/** Visible only while the ACTIVE project's autonomy circuit breaker is
 * latched — the human's next message re-arms it (AGENTS.md invariant). */
function BreakerNotice({ projectId }: { projectId: string | null }) {
  const tripped = useSyncExternalStore(subscribeAutonomy, () =>
    projectId ? autonomyTripped(projectId) : false,
  );
  if (!tripped) return null;
  return (
    <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg border border-err/40 bg-err/10 px-3 py-2 font-mono text-11 text-err">
      <span aria-hidden>⏻</span>
      <span className="min-w-0">
        Autonomy paused — budget exhausted. Your next message re-arms it.
      </span>
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
  return (
    <div className="relative flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
      <span
        aria-hidden
        className={cn(
          "hex-mark hex-mark-orb h-[26px] w-[26px] shrink-0",
          busy && "animate-zglow",
        )}
      />
      <span aria-hidden className="font-mono text-12 text-acc">
        //
      </span>
      <span className="-ml-1 min-w-0 truncate text-14 font-semibold tracking-[-0.01em] text-txt">
        {persona.name}
      </span>
      {busy && (
        <span className="animate-zcaret shrink-0 font-mono text-10 text-acc">
          ▸ working…
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <ChatSwitcher projectId={projectId} />
        <button
          onClick={() => projectId && createChat(projectId)}
          title="New chat"
          className="focus-ring flex h-6 w-6 items-center justify-center rounded-md text-fnt hover:bg-card hover:text-txt"
        >
          <Plus size={13} />
        </button>
        {chatId && <ChatMeta chatId={chatId} />}
        {busy && chatId && (
          <button
            onClick={() => interrupt(chatId)}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-sm border border-line2 px-2.5 py-1 font-mono text-11 text-mut hover:text-txt"
            title="Stop the running turn"
          >
            <Square size={9} className="fill-current" /> Stop
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
  // transient composer feedback (e.g. "@agent is mid-turn") — cleared on edit
  const [notice, setNotice] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // primitive signature (joined scoped id:name pairs — the NAME is part of it
  // so a rename refreshes the popover, never offering a stale `@oldname` that
  // the live resolution at send time would miss) → build the mention
  // candidates in useMemo without a fresh-array selector (the
  // useSyncExternalStore rule); @mentions target THIS project's sessions only
  const idsSig = useVibe((s) =>
    (projectId
      ? s.order.filter((id) => s.sessions[id]?.session.projectId === projectId)
      : s.order
    )
      .map((id) => `${id}:${s.sessions[id]?.session.name ?? ""}`)
      .join("|"),
  );
  const candidates: MentionCandidate[] = useMemo(() => {
    const v = useVibe.getState();
    return (idsSig ? idsSig.split("|") : []).map((pair) => {
      const id = pair.slice(0, pair.indexOf(":"));
      return { id, name: v.sessions[id]?.session.name ?? id };
    });
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
      // the human composer waits while a turn runs (one turn at a time) — a
      // busy target keeps the text HERE instead of silently dropping it
      // (sendMessage would swallow the strict-path rejection), same guard as
      // the grid's mini composer
      if (useVibe.getState().busy[mention.sessionId]) {
        setNotice(`«${mention.matched}» is mid-turn — your message stays here; send again when the agent is idle.`);
        return;
      }
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
    <div className="relative shrink-0 px-4 pb-4">
      {suggestions.length > 0 && (
        // z-10: above the sidebar content, but strictly BELOW the wide
        // overlay (z-20) and all modal chrome (z-30+)
        <div className="animate-zfadeup absolute bottom-full left-3.5 z-10 mb-2 w-64 overflow-hidden rounded-xl border border-line2 bg-pop p-1.5 shadow-pop">
          <div className="px-2 py-1 font-mono text-10 font-medium uppercase tracking-[.08em] text-fnt">
            Message an agent directly
          </div>
          {suggestions.map((c) => (
            <button
              key={c.id}
              onMouseDown={(e) => {
                // mousedown (not click) so the textarea keeps focus
                e.preventDefault();
                pickSuggestion(c);
              }}
              className="focus-ring flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-12 text-txt hover:bg-line"
            >
              <span className="font-mono text-acc">@</span>
              <span className="min-w-0 truncate">{c.name}</span>
            </button>
          ))}
        </div>
      )}
      {notice && (
        <div className="animate-zfadeup mb-1.5 flex items-center gap-1.5 px-1 font-mono text-11 text-attn">
          <span aria-hidden className="shrink-0">
            ⚑
          </span>
          <span className="min-w-0">{notice}</span>
        </div>
      )}
      <div className="flex items-end gap-2 rounded-xl border border-line bg-card px-3 py-2.5 transition-colors focus-within:border-acc/55">
        <textarea
          ref={taRef}
          value={text}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            if (notice) setNotice(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={`Direct the fleet — message ${personaName}, or @agent for one directly…`}
          className="min-h-5 flex-1 select-text resize-none bg-transparent text-13 leading-relaxed text-txt placeholder:text-fnt focus:outline-none"
        />
        {busy && chatId ? (
          <button
            onClick={() => interrupt(chatId)}
            title="Stop the running turn"
            className="focus-ring flex h-[26px] shrink-0 items-center gap-1.5 rounded-sm border border-line2 px-2.5 font-mono text-11 text-mut hover:text-txt"
          >
            <Square size={10} className="fill-current" /> Stop
          </button>
        ) : (
          <button
            onClick={send}
            title="Send (↵)"
            className={cn(
              "focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-acc text-white hover:brightness-110",
              !text.trim() && "opacity-40",
            )}
          >
            <ArrowUp size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
