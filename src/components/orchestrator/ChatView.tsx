// Shared orchestrator chat rendering — the message list, message rows,
// tool/system chips, session jump chips and the chat switcher. Rendered by
// the Conductor sidebar (the app's one orchestrator surface).

import {
  Fragment,
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  ClipboardCheck,
  Cpu,
  FileText,
  FolderGit2,
  FolderSearch,
  GitBranch,
  MessageSquare,
  Radar,
  ScrollText,
  SearchCheck,
  Settings2,
  Sparkles,
  StickyNote,
  Timer,
  TriangleAlert,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useVibe } from "@/lib/vibe/session-store";
import { focusSession } from "@/lib/vibe/controller";
import {
  activeChatIdFor,
  DEFAULT_CHAT_TITLE,
  useOrchestrator,
} from "@/lib/orchestrator/chat-store";
import { compactChat, removeChat, sendMessage } from "@/lib/orchestrator/controller";
import {
  activityCountLabel,
  groupChatMessages,
  isSingleStepActivity,
  systemPingKind,
  toolActivityLabel,
} from "@/lib/orchestrator/tool-labels";
import { recentCodexModels } from "@/lib/orchestrator/models";
import {
  VIBE_CTX_WARN,
  agentRuntimeLabel,
  contextTokens,
} from "@/lib/vibe/ui";
import { OrchestratorMarkdown } from "../OrchestratorMarkdown";
import { ModelEffortPicker } from "./ModelEffortPicker";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Tip } from "../ui/tooltip";
import { cn, prettyModel } from "@/lib/utils";
import type {
  OrchestratorChatMessage,
  OrchestratorPaneRef,
} from "@/types";

/** Reading-width cap for the message column (t3code max-w-3xl ≈ 768px; a touch
 * tighter for our smaller UI). The composer sits flush beneath it. */
export const CHAT_MAX_W = "max-w-[46rem]";

type ToolMessage = Extract<OrchestratorChatMessage, { role: "tool" }>;

const EMPTY_MESSAGES: OrchestratorChatMessage[] = [];

export function MessageList({ chatId }: { chatId: string }) {
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

  if (messages.length === 0) return <EmptyChat />;

  const last = messages[messages.length - 1];
  // feedback between send and the first delta — unless a streaming message
  // (caret) or a pending tool chip (its own …) already shows activity
  const showThinking =
    isBusy &&
    !(last.role === "assistant" && last.streaming) &&
    !(last.role === "tool" && last.ok === undefined);

  const groups = groupChatMessages(messages);
  // per-group timestamp dividers (>5 min gap), tracked across the folded groups
  let lastAt = 0;

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-5"
    >
      <div className={cn("mx-auto flex w-full flex-col gap-3", CHAT_MAX_W)}>
        {groups.map((g) => {
          const at = g.kind === "message" ? g.msg.at : g.tools[0].at;
          const showT = lastAt === 0 || at - lastAt > 5 * 60_000;
          lastAt =
            g.kind === "message" ? g.msg.at : g.tools[g.tools.length - 1].at;
          return (
            <Fragment key={g.kind === "message" ? g.msg.id : g.id}>
              {showT && <TimeDivider at={at} />}
              {g.kind === "message" ? (
                <MessageRow msg={g.msg} chatId={chatId} />
              ) : (
                <ActivityBlock tools={g.tools} />
              )}
            </Fragment>
          );
        })}
        {showThinking && (
          <div className="ml-6 font-mono text-12 leading-relaxed text-fnt">
            <span className="animate-zcaret">…</span>
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
    <div className="py-0.5 text-center font-mono text-10 font-medium uppercase tracking-[.08em] text-fnt">
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
        <div className="flex justify-end">
          <div className="max-w-[85%] select-text whitespace-pre-wrap break-words rounded-xl rounded-br-[4px] border border-line2 bg-pop px-3.5 py-2.5 text-13 leading-relaxed text-txt">
            {msg.text}
          </div>
        </div>
      );
    case "assistant":
      // the Conductor speaks under its orb (reference: 15px hex orb + prose)
      return (
        <div className="animate-zfadeup flex gap-2">
          <span
            aria-hidden
            className="hex-mark hex-mark-orb mt-[3px] h-[15px] w-[15px] shrink-0"
          />
          <div className="min-w-0 select-text break-words text-13 leading-relaxed text-txt/90">
            <OrchestratorMarkdown text={msg.text} />
            {msg.streaming && (
              <span className="animate-zcaret ml-0.5 inline-block h-[13px] w-[6px] translate-y-[2px] rounded-[1px] bg-acc-hot" />
            )}
          </div>
        </div>
      );
    case "tool":
      // tool messages are folded into ActivityBlock by groupChatMessages;
      // a stray one (shouldn't happen) renders as a single-item block
      return <ActivityBlock tools={[msg]} />;
    case "warning":
      // routed through the shared quiet line so failures share the exact
      // aesthetic of activity steps + status pings (⚠ warning tone)
      return <QuietLine status="failed" tone="warning" text={msg.text} />;
    case "system":
      return <SystemRow msg={msg} chatId={chatId} />;
  }
});

/**
 * Phase-5 status ping ("«api» finished"): rendered through the SAME quiet line
 * as an activity step — ✓ ephemeral-green for a finish, ⚑ amber for waiting
 * (signal triad) — plus the pane/session jump chip and a "Review" button that
 * sends a normal (visible) user turn asking for a transcript summary. Disabled
 * while the chat is busy. The finished/waiting split is read purely from the
 * text (systemPingKind) so the message format stays controller-owned.
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
  const kind = systemPingKind(msg.text);
  const status: QuietStatus =
    kind === "waiting" ? "waiting" : kind === "finished" ? "ok" : "info";
  return (
    <QuietLine
      status={status}
      text={msg.text}
      tooltip={new Date(msg.at).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      })}
    >
      {msg.autonomous && (
        // Phase 5: an autonomous-turn marker — the Conductor woke itself
        // (finish/approval/timer/idle trigger), no human sent this. Accent-
        // washed chip, deliberately NOT a user bubble; the trigger kind
        // rides in the tooltip.
        <span
          title={`Autonomous turn — the Orchestrator acted on its own (trigger: ${msg.trigger ?? "event"})`}
          className="shrink-0 rounded-sm border border-acc/40 bg-acc/10 px-1.5 py-px font-mono text-10 font-medium text-acc"
        >
          ⚡ autonomous
        </span>
      )}
      {msg.paneRefs?.map((p) => <PaneChip key={p.id} pane={p} />)}
      {pane && (
        <button
          disabled={isBusy}
          onClick={() =>
            void sendMessage(
              chatId,
              `Read the transcript tail of «${pane.name}» (${pane.id}) and summarize briefly: what got done, were there problems, and what do you suggest as the next step?`,
            )
          }
          title={`Summarize what "${pane.name}" produced`}
          className="focus-ring flex shrink-0 items-center rounded-sm border border-line px-2 py-px font-mono text-11 text-acc transition-colors hover:border-acc/55 hover:bg-acc/10 disabled:pointer-events-none disabled:opacity-40"
        >
          Review
        </button>
      )}
    </QuietLine>
  );
}

// ---- the one quiet line for EVERYTHING non-prose in the chat ----
// Every tool step, status ping and warning renders through QuietLine so the
// whole feed shares one aesthetic and iconography, regardless of what the
// tool/ping is now or in the future (unknown tools fall back via
// toolActivityLabel → "Used a tool"; unknown pings via systemPingKind → info).

type QuietStatus = "running" | "ok" | "failed" | "waiting" | "info";

/** The single status glyph for a quiet line — triad-coloured (✓ success,
 * ⚠ warning, ⚑ attention) or a neutral marker while running / for info. */
function StatusIcon({ status }: { status: QuietStatus }) {
  switch (status) {
    case "running":
      return (
        <span className="animate-zcaret shrink-0 font-mono text-fnt">…</span>
      );
    case "ok":
      return <Check size={12} className="shrink-0 text-ok" />;
    case "failed":
      return <TriangleAlert size={12} className="shrink-0 text-warn" />;
    case "waiting":
      return (
        <span
          aria-hidden
          className="animate-zattn shrink-0 font-mono text-11 font-semibold leading-none text-attn"
        >
          ⚑
        </span>
      );
    case "info":
      return (
        <span aria-hidden className="shrink-0 font-mono text-fnt">
          ·
        </span>
      );
  }
}

/** A calm one-line row: status glyph + human text (+ optional tooltip) + any
 * trailing chips/buttons. The shared shape for single steps, pings, warnings.
 * Indented under the assistant orb column (ml-6) so prose keeps the lead. */
function QuietLine({
  status,
  text,
  tooltip,
  tone = "muted",
  children,
}: {
  status: QuietStatus;
  text: ReactNode;
  tooltip?: string;
  /** warning tone brightens the text itself (genuine failures); default recedes */
  tone?: "muted" | "warning";
  children?: ReactNode;
}) {
  return (
    <div className="ml-6 flex select-text flex-wrap items-center gap-x-1.5 gap-y-1 text-12 leading-5">
      <StatusIcon status={status} />
      <span
        title={tooltip}
        className={cn(
          "min-w-0 break-words",
          tone === "warning" ? "text-warn" : "text-mut",
        )}
      >
        {text}
      </span>
      {children}
    </div>
  );
}

// ---- activity block (folded consecutive tool calls) ----
// A quiet, human-readable activity summary that recedes optically (faint, mono
// header) and expands to the per-step list. Failed steps stay visible while
// collapsed (⚠ line); jump chips stay first-class (a union row under the
// header). Raw tool name + args live only in the step's tooltip.

const STEP_ICON: Record<string, LucideIcon> = {
  fleet_snapshot: Radar,
  read_agent: ScrollText,
  read_project_docs: BookOpen,
  read_notes: StickyNote,
  git_status: GitBranch,
  list_projects: FolderSearch,
  list_models: Cpu,
  prompt_agent: MessageSquare,
  spawn_agents: Sparkles,
  interrupt_agent: CircleStop,
  close_agent: X,
  set_agent_config: Settings2,
  review_agent: SearchCheck,
  decide_approval: ClipboardCheck,
  create_worktree: FolderGit2,
  assign_worktree: FolderGit2,
  worktree_status: FolderGit2,
  cleanup_worktree: FolderGit2,
  set_timer: Timer,
  list_timers: Timer,
  cancel_timer: Timer,
  write_plan: FileText,
  list_plans: FileText,
  read_plan: FileText,
  remember: Brain,
};

function stepLabel(t: ToolMessage): string {
  return toolActivityLabel(t.tool, {
    names: t.paneRefs?.map((p) => p.name),
    count: t.paneRefs?.length,
  });
}

/** Dedup jump refs across a whole block (by id). */
function unionRefs(tools: ToolMessage[]): OrchestratorPaneRef[] {
  const seen = new Set<string>();
  const out: OrchestratorPaneRef[] = [];
  for (const t of tools)
    for (const p of t.paneRefs ?? [])
      if (!seen.has(p.id)) {
        seen.add(p.id);
        out.push(p);
      }
  return out;
}

/**
 * A run of consecutive tool calls. A lone step renders as a single quiet line
 * (the same shape as a status ping) — no bulky "Worked · 1 step" disclosure;
 * multiple steps fold into the collapsible group. Decision is the pure,
 * unit-tested `isSingleStepActivity`.
 */
function ActivityBlock({ tools }: { tools: ToolMessage[] }) {
  if (isSingleStepActivity(tools)) return <ActivityLine tool={tools[0]} />;
  return <ActivityGroup tools={tools} />;
}

/** The quiet single-liner for a lone tool step: status glyph + human verb,
 * raw tool name + args in the tooltip, jump chips trailing. */
function ActivityLine({ tool }: { tool: ToolMessage }) {
  const status: QuietStatus =
    tool.ok === undefined ? "running" : tool.ok === false ? "failed" : "ok";
  return (
    <QuietLine
      status={status}
      text={stepLabel(tool)}
      tooltip={
        tool.argsSummary ? `${tool.tool} — ${tool.argsSummary}` : tool.tool
      }
      tone={status === "failed" ? "warning" : "muted"}
    >
      {tool.paneRefs?.map((p) => <PaneChip key={p.id} pane={p} />)}
    </QuietLine>
  );
}

function ActivityGroup({ tools }: { tools: ToolMessage[] }) {
  const [open, setOpen] = useState(false);
  const running = tools.some((t) => t.ok === undefined);
  const failed = tools.filter((t) => t.ok === false);
  const refs = unionRefs(tools);

  return (
    <div className="ml-6 text-12 leading-5">
      <button
        onClick={() => setOpen((o) => !o)}
        className="focus-ring group flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-left hover:bg-card"
      >
        <ChevronRight
          size={11}
          className={cn(
            "shrink-0 text-fnt transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="font-mono text-11 text-mut">
          {running ? "Working" : "Worked"} · {activityCountLabel(tools.length)}
        </span>
        {running ? (
          <span className="animate-zcaret font-mono text-fnt">…</span>
        ) : failed.length ? (
          <TriangleAlert size={11} className="shrink-0 text-warn" />
        ) : (
          <Check size={12} className="shrink-0 text-ok" />
        )}
      </button>

      {/* jump chips stay first-class even collapsed */}
      {!open && refs.length > 0 && (
        <div className="ml-5 mt-1 flex flex-wrap items-center gap-1.5">
          {refs.map((p) => (
            <PaneChip key={p.id} pane={p} />
          ))}
        </div>
      )}

      {/* failed steps stay visible collapsed */}
      {!open && failed.length > 0 && (
        <div className="ml-5 mt-1 flex flex-col gap-0.5">
          {failed.map((t) => (
            <StepRow key={t.id} tool={t} />
          ))}
        </div>
      )}

      {open && (
        <div className="ml-[13px] mt-1.5 flex flex-col gap-1 border-l border-line2 pl-3">
          {tools.map((t) => (
            <StepRow key={t.id} tool={t} withChips />
          ))}
        </div>
      )}
    </div>
  );
}

function StepRow({
  tool,
  withChips,
}: {
  tool: ToolMessage;
  withChips?: boolean;
}) {
  const Icon = STEP_ICON[tool.tool] ?? Wrench;
  const failed = tool.ok === false;
  const running = tool.ok === undefined;
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <Icon size={12} className="shrink-0 text-fnt" />
      <span
        title={tool.argsSummary ? `${tool.tool} — ${tool.argsSummary}` : tool.tool}
        className={cn("min-w-0 truncate", failed ? "text-warn" : "text-mut")}
      >
        {stepLabel(tool)}
      </span>
      {withChips && tool.paneRefs?.map((p) => <PaneChip key={p.id} pane={p} />)}
      {running ? (
        <span className="animate-zcaret text-fnt">…</span>
      ) : failed ? (
        <TriangleAlert size={10} className="shrink-0 text-warn" />
      ) : (
        <Check size={11} className="shrink-0 text-ok" />
      )}
    </div>
  );
}

/**
 * "→ name" jump chip: a native session (focusSession selects it). Resolves
 * live and hides once the target is gone. Carries the session's live status
 * dot (accent while working, amber while it needs the human).
 */
function PaneChip({ pane }: { pane: OrchestratorPaneRef }) {
  const name = useVibe((s) => s.sessions[pane.id]?.session.name);
  const busy = useVibe((s) => !!s.busy[pane.id]);
  const liveModel = useVibe((s) => s.sessions[pane.id]?.session.model);
  const liveEffort = useVibe((s) => s.sessions[pane.id]?.session.effort);
  // Live config wins while the agent exists (set_agent_config can retune it);
  // the immutable spawn snapshot keeps the audit trail after it is closed.
  const runtime = name
    ? { model: liveModel ?? null, effort: liveEffort ?? null }
    : (pane.runtime ?? { model: null, effort: null });
  const runtimeLabel = agentRuntimeLabel(runtime.model, runtime.effort);
  const displayName = name ?? pane.name;
  const content = (
    <>
      <span
        aria-hidden
        className={cn(
          "h-[5px] w-[5px] rounded-full",
          busy ? "bg-acc" : "bg-fnt",
        )}
      />
      <span>→ {displayName}</span>
      <span className="max-w-40 truncate text-10 text-fnt">
        {runtimeLabel}
      </span>
    </>
  );
  if (!name) {
    if (!pane.runtime) return null;
    return (
      <span
        title={`Closed worker — started with ${runtimeLabel}`}
        className="flex shrink-0 items-center gap-1.5 rounded-sm border border-line bg-card px-2 py-px font-mono text-11 text-fnt"
      >
        {content}
      </span>
    );
  }
  return (
    <button
      onClick={() => focusSession(pane.id)}
      title={`Jump to worker "${name}" — ${runtimeLabel}`}
      className="focus-ring flex shrink-0 items-center gap-1.5 rounded-sm border border-line bg-card px-2 py-px font-mono text-11 text-mut transition-colors hover:border-acc/55 hover:text-txt"
    >
      {content}
    </button>
  );
}

function EmptyChat() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="max-w-64 text-center">
        <span
          aria-hidden
          className="hex-mark hex-mark-orb mx-auto block h-7 w-7 opacity-80"
        />
        <p className="mt-3 text-12 leading-normal text-mut">
          Give the Orchestrator a goal — it decomposes the work, staffs workers
          and reports back.
        </p>
        <p className="mt-1.5 text-11 leading-normal text-fnt">
          It reads transcripts and git, starts and steers workers, manages
          worktrees, sets follow-up timers and decides routine approvals.
        </p>
      </div>
    </div>
  );
}

/**
 * Header meta for a chat: the model/effort chip (opens the shared picker) +
 * the context gauge. The gauge appears once the token_usage event feeds
 * `tokenUsage` — defensive until then (renders nothing).
 */
export function ChatMeta({
  chatId,
  compact = false,
}: {
  chatId: string;
  compact?: boolean;
}) {
  const model = useOrchestrator(
    (s) => s.chats.find((c) => c.id === chatId)?.model,
  );
  const effort = useOrchestrator(
    (s) => s.chats.find((c) => c.id === chatId)?.effort,
  );
  const setChatModelEffort = useOrchestrator((s) => s.setChatModelEffort);
  const models = useMemo(() => recentCodexModels(), []);
  const label = model ? prettyModel(model) : "default model";

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <ModelEffortPicker
        model={model}
        effort={effort}
        models={models}
        showEffort
        onApply={(next) => setChatModelEffort(chatId, next)}
      >
        <button
          title="Model & reasoning effort — applies from the next turn"
          aria-label={`${label}${effort ? ` · ${effort}` : ""} — change model and reasoning effort`}
          className={cn(
            "focus-ring flex h-6 shrink-0 items-center justify-center gap-1 rounded-sm font-mono text-11 text-fnt transition-colors hover:bg-card hover:text-mut",
            compact ? "w-6" : "px-2",
          )}
        >
          {compact ? (
            <Cpu size={11} />
          ) : (
            <>
              <span className="max-w-28 truncate">{label}</span>
              {effort && <span>· {effort}</span>}
              <ChevronDown size={9} />
            </>
          )}
        </button>
      </ModelEffortPicker>
      {!compact && <ChatContextGauge chatId={chatId} />}
    </div>
  );
}

/** Context gauge for an orchestrator chat (mirrors the Vibe ContextGauge) —
 * click to compact when idle. */
function ChatContextGauge({ chatId }: { chatId: string }) {
  const usage = useOrchestrator((s) => s.tokenUsage[chatId] ?? null);
  const busy = useOrchestrator((s) => !!s.busy[chatId]);
  const total = contextTokens(usage?.last);
  const window = usage?.modelContextWindow ?? 0;
  if (!window || total <= 0) return null;
  const pct = Math.min(total / window, 1);
  const warn = pct >= VIBE_CTX_WARN;
  return (
    <Tip
      label={
        <span className="font-mono text-11">
          Context · {total.toLocaleString()} / {window.toLocaleString()} tokens
          {busy ? "" : " · click to compact"}
        </span>
      }
    >
      <button
        disabled={busy}
        onClick={() => void compactChat(chatId).catch(() => {})}
        className={cn(
          "focus-ring shrink-0 rounded-sm px-2 py-1 font-mono text-11 tabular-nums transition-colors disabled:opacity-60",
          warn ? "text-warn" : "text-fnt",
          !busy && "hover:bg-card hover:text-txt",
        )}
      >
        ctx {Math.round(pct * 100)}%
      </button>
    </Tip>
  );
}

/**
 * The chat switcher popover (title button + per-row switch/delete), scoped
 * to ONE project's chats (Phase 3 — every project has its own Conductor).
 * Deliberately sibling BUTTONS, not a Radix menu — a nested delete inside a
 * menuitem is keyboard-unreachable.
 */
export function ChatSwitcher({
  projectId,
  className,
}: {
  projectId: string | null;
  className?: string;
}) {
  const allChats = useOrchestrator((s) => s.chats);
  const activeChatId = useOrchestrator((s) =>
    projectId ? activeChatIdFor(s, projectId) : null,
  );
  const busy = useOrchestrator((s) => s.busy);
  const setActiveChat = useOrchestrator((s) => s.setActiveChat);
  const [open, setOpen] = useState(false);
  // filter in render (the store array reference is stable between changes)
  const chats = projectId
    ? allChats.filter((c) => c.projectId === projectId)
    : [];
  const active = chats.find((c) => c.id === activeChatId);
  if (chats.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className={cn("focus-ring flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 text-11 text-mut transition-colors hover:bg-card hover:text-txt", className)}>
          <span className="min-w-0 truncate">
            {active?.title ?? DEFAULT_CHAT_TITLE}
          </span>
          {chats.length > 1 && (
            <span className="shrink-0 font-mono text-10 tabular-nums text-fnt">
              {chats.length}
            </span>
          )}
          <ChevronDown size={11} className="shrink-0 text-fnt" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-72 w-64 overflow-y-auto">
        {chats.map((c) => (
          <div
            key={c.id}
            className="group/chat flex items-center gap-1 rounded-md pr-1 hover:bg-line"
          >
            <button
              onClick={() => {
                setActiveChat(c.id);
                setOpen(false);
              }}
              className="focus-ring flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-12 text-txt"
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  busy[c.id]
                    ? "animate-zpulse bg-acc"
                    : c.id === activeChatId
                      ? "bg-acc"
                      : "bg-fnt/50",
                )}
              />
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
            </button>
            <button
              onClick={() => removeChat(c.id)}
              title="Delete chat"
              className="focus-ring flex h-4 w-4 shrink-0 items-center justify-center rounded-xs text-fnt opacity-0 hover:bg-err/15 hover:text-err focus-visible:opacity-100 group-hover/chat:opacity-100"
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}
