// Orchestrator tool executors (Phase 2) — one async function per tool in the
// Rust registry (src-tauri/src/orchestrator/registry.rs, the single source
// of names/schemas). They run in the webview because that's where the
// Zustand store lives; the bus (bus.ts) dispatches `orchestrator://tool-
// request` events here and reports results back to Rust.
//
// Args arrive pre-validated by the Rust registry (required props + basic
// types) — executors still throw clear errors for everything semantic
// (unknown pane ids, non-repo worktree requests, …). A thrown error becomes
// the tool call's error message.

import { defaultStartupForRuntime, useSwarm } from "@/store";
import type { Agent, NoteItem, PresetLayoutNode } from "@/types";
import { fetchGitInfo, getHome } from "@/lib/transport";
import { insertCommandText } from "@/lib/insert-command";
import { pushFleetEvent } from "@/lib/events";
import { addWorktree, generateBranchName } from "@/lib/worktree";
import { runtimeFromStartup } from "@/lib/utils";
import { useVibe, type VibeSessionEntry } from "@/lib/vibe/session-store";
import {
  sendMessage as vibeSendMessage,
  startSession as startVibeSession,
} from "@/lib/vibe/controller";
import { renderSessionTranscript } from "@/lib/vibe/transcript";
import {
  buildArrangement,
  collectPanes,
  combineLayouts,
  findPaneByAgent,
  removePaneByAgent,
  splitPane,
  type Arrangement,
} from "@/lib/layout";
import { useOrchestrator } from "./chat-store";
import {
  crowdingNote,
  fleetSnapshot,
  fleetSummaryLine,
  sessionSnapshot,
  type LayoutDims,
} from "./snapshot";
import {
  MIN_PANE,
  planPlacement,
  type PlanSpec,
  type WsMeta,
} from "./placement";
import { discoverProjects, projectDocs, readTranscript } from "./native";
import { appendMemory } from "./memory";
import { agentListForModel } from "./agents";
import { listAgents, writeAgentCompiled } from "@/lib/agents/api";
import { injectAgentIntoStartup } from "@/lib/agents/startup";
import type { AgentSummary } from "@/lib/agents/types";
import type {
  CreatePaneResult,
  CreatePaneSpec,
  CreatePanesResult,
  OrchestratorToolName,
  PromptPaneResult,
  ToolNoteItem,
} from "./types";

/**
 * Per-call context the bus passes alongside the args. `chatId` is the STORE
 * chat id of the orchestrator chat whose turn triggered the call (the bus
 * resolves the backend id) — null for dev-hook calls (`__orch.tool`), which
 * therefore never track touched panes.
 */
export interface ToolCallContext {
  chatId: string | null;
}

export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx: ToolCallContext,
) => Promise<unknown>;

// ---- Phase-5 write guards + touched-pane tracking ----

/** Two orchestrator prompts into the SAME pane within this window error. */
export const DOUBLE_PROMPT_WINDOW_MS = 2_000;

/**
 * Last orchestrator prompt delivery per pane id — across ALL chats and
 * including create_panes startup prompts (in-memory; the guard is about
 * accidental duplicates within seconds, not restarts).
 */
const lastPromptDelivery = new Map<string, number>();

/**
 * Double-prompt protection + the Phase-6 busy policy — the single choke
 * point for every orchestrator write into a pane. With
 * `orchestratorBusyPolicy: "refuse"` a busy pane rejects the prompt outright
 * (the default "deliver" keeps the queue-with-warning behavior).
 */
function assertPromptAllowed(agent: Agent): void {
  const last = lastPromptDelivery.get(agent.id);
  if (last !== undefined && Date.now() - last < DOUBLE_PROMPT_WINDOW_MS) {
    throw new Error(
      `pane "${agent.name}" (${agent.id}) already received an orchestrator prompt ${Date.now() - last} ms ago — this looks like a duplicate call; wait a moment and re-send only if it was intentional`,
    );
  }
  const busyPolicy =
    useSwarm.getState().settings.orchestratorBusyPolicy ?? "deliver";
  if (busyPolicy === "refuse" && agent.activity === "busy") {
    throw new Error(
      `pane "${agent.name}" (${agent.id}) is busy and the user's busy policy is "refuse" — wait until it finishes, then prompt it (or tell the user it is still working)`,
    );
  }
}

/**
 * Phase-6 global auto-submit gate: `orchestratorAutoSubmit: false` = review
 * mode — orchestrator prompts (prompt_pane AND create_panes startup prompts)
 * paste but never submit; the user presses Enter themselves.
 */
function reviewModeActive(): boolean {
  return useSwarm.getState().settings.orchestratorAutoSubmit === false;
}

/**
 * The session variant of the write choke point (Phase 5): the same
 * double-prompt guard, but a busy session is always REFUSED (a native session
 * runs one turn at a time — the backend rejects a second turn — so there is no
 * "queue into the input" like a terminal pane). Review mode does not apply:
 * a session turn is a single atomic submit, not a paste the user can inspect.
 */
function assertSessionPromptAllowed(sessionId: string, name: string): void {
  const last = lastPromptDelivery.get(sessionId);
  if (last !== undefined && Date.now() - last < DOUBLE_PROMPT_WINDOW_MS) {
    throw new Error(
      `session "${name}" (${sessionId}) already received an orchestrator prompt ${Date.now() - last} ms ago — this looks like a duplicate call; wait a moment and re-send only if it was intentional`,
    );
  }
  if (useVibe.getState().busy[sessionId]) {
    throw new Error(
      `session "${name}" (${sessionId}) is busy — wait for it to finish, then prompt it (or tell the user it is still working)`,
    );
  }
}

/**
 * Record a delivered prompt: feeds the double-prompt guard, and — when the
 * call carries a chat context — the chat's touchedPanes (the Phase-5
 * activity watcher only pings panes recorded here). Every delivery also
 * lands in the Deck's fleet event feed (`▸ orch → pane`).
 */
function notePromptDelivered(
  paneId: string,
  paneName: string,
  ctx: ToolCallContext,
): void {
  lastPromptDelivery.set(paneId, Date.now());
  if (ctx.chatId)
    useOrchestrator.getState().recordTouchedPane(ctx.chatId, paneId, paneName);
  pushFleetEvent({
    kind: "orch_prompt",
    paneId,
    paneName,
    workspaceId: useSwarm.getState().agents[paneId]?.workspaceId ?? "",
  });
}

/** Resolve a pane_id to its agent, or fail listing every valid pane id. */
function requireAgent(paneId: unknown): Agent {
  const s = useSwarm.getState();
  const agent = typeof paneId === "string" ? s.agents[paneId] : undefined;
  if (agent) return agent;
  const valid = s.order
    .map((id) => {
      const a = s.agents[id];
      return a ? `${id} ("${a.name}")` : null;
    })
    .filter(Boolean)
    .join(", ");
  throw new Error(
    `unknown pane_id ${JSON.stringify(String(paneId))} — valid pane ids: ${valid || "(no panes open)"}`,
  );
}

/** Ordered native Vibe session entries (newest first, matching the rail). */
function orderedSessions(): VibeSessionEntry[] {
  const v = useVibe.getState();
  return v.order
    .map((id) => v.sessions[id])
    .filter((e): e is VibeSessionEntry => !!e);
}

/** The native-session snapshot section shared by fleet_snapshot + the summary. */
export function fleetSessions() {
  const v = useVibe.getState();
  return sessionSnapshot({ sessions: orderedSessions(), busy: v.busy });
}

/**
 * Real DOM measurement of one workspace's grid container. All grids stay
 * mounted (inactive ones are `visibility:hidden`), and `clientWidth/Height`
 * are LAYOUT boxes — unaffected by the fleet view's CSS scale transform — so
 * this reports the true size a workspace renders at. Null for empty
 * workspaces (no grid container) or a zero-size box.
 */
function gridDims(wsId: string): LayoutDims | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector(
    `[data-ws-grid="${wsId}"]`,
  ) as HTMLElement | null;
  if (!el) return null;
  const w = el.clientWidth;
  const h = el.clientHeight;
  return w > 0 && h > 0 ? { w, h } : null;
}

/** Measure every workspace's grid container (workspaceId → dims | null). */
function gatherGridDims(order: string[]): Record<string, LayoutDims | null> {
  const out: Record<string, LayoutDims | null> = {};
  for (const id of order) out[id] = gridDims(id);
  return out;
}

/**
 * A prompt/read target is either an agent pane or a native Vibe session — the
 * write/read tools accept either id (panes checked first, then sessions).
 */
type Target =
  | { kind: "pane"; agent: Agent }
  | { kind: "session"; entry: VibeSessionEntry };

function resolveTarget(paneId: unknown): Target | null {
  if (typeof paneId !== "string") return null;
  const agent = useSwarm.getState().agents[paneId];
  if (agent) return { kind: "pane", agent };
  const entry = useVibe.getState().sessions[paneId];
  if (entry) return { kind: "session", entry };
  return null;
}

/** Resolve a pane_id to a pane or a session, or fail listing all valid ids. */
function requireTarget(paneId: unknown): Target {
  const target = resolveTarget(paneId);
  if (target) return target;
  const s = useSwarm.getState();
  const panes = s.order
    .map((id) => (s.agents[id] ? `${id} ("${s.agents[id].name}")` : null))
    .filter(Boolean);
  const sessions = orderedSessions().map(
    (e) => `${e.session.id} ("${e.session.name}", native session)`,
  );
  const valid = [...panes, ...sessions].join(", ");
  throw new Error(
    `unknown pane_id ${JSON.stringify(String(paneId))} — valid ids: ${valid || "(no panes or sessions open)"}`,
  );
}

function stripNotes(items: NoteItem[]): ToolNoteItem[] {
  return items.map((n) => ({ text: n.text, done: n.done }));
}

/** All pane templates of a preset layout tree, in layout order. */
function presetPanes(node: PresetLayoutNode): Extract<PresetLayoutNode, { type: "pane" }>[] {
  if (node.type === "pane") return [node];
  return node.children.flatMap(presetPanes);
}

/**
 * Wait until the pane's PTY reports running, then give the agent CLI a short
 * grace period to boot before pasting. There is no readiness signal from the
 * CLIs today (OSC 9;4 only fires once they DO something, Codex activity only
 * on task start), so this is deliberately a bounded poll + fixed settle
 * delay: pasting into the not-yet-started CLI would feed the shell instead.
 * Review mode (orchestratorAutoSubmit off) pastes without submitting and
 * says so in the note; failures come back as `delivered: false` + note.
 */
async function deliverStartupPrompt(
  agentId: string,
  prompt: string,
): Promise<{ delivered: boolean; note?: string }> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const fail = (note: string) => ({ delivered: false, note });
  const deadline = Date.now() + 20_000;
  for (;;) {
    const agent = useSwarm.getState().agents[agentId];
    if (!agent) return fail("prompt not delivered: pane was closed");
    if (agent.status === "exited")
      return fail("prompt not delivered: pane exited before it became ready");
    if (agent.status === "running") break;
    if (Date.now() > deadline)
      return fail("prompt not delivered: pane never reached running state");
    await sleep(150);
  }
  const runtime = useSwarm.getState().agents[agentId]?.runtime ?? "claude";
  // shell prompts are ready almost immediately; agent CLIs get typed into a
  // login shell first and need a moment to take over stdin
  await sleep(runtime === "shell" ? 300 : 2_000);
  const agent = useSwarm.getState().agents[agentId];
  if (!agent || agent.status === "exited")
    return fail("prompt not delivered: pane exited while waiting for the CLI");
  const submit = !reviewModeActive();
  insertCommandText(agentId, prompt, submit);
  return {
    delivered: true,
    note: submit
      ? undefined
      : "review mode — startup prompt pasted but not submitted; the user presses Enter in the pane to run it",
  };
}

interface PendingPrompt {
  id: string;
  text: string;
  /** native session prompt (vibe turn) vs. terminal-pane startup prompt */
  native: boolean;
}

/**
 * A slug→agent index for one create_panes batch. Built once (a single
 * `agent_list`) when ANY pane names an `agent`, so an unknown slug can list the
 * valid ones; `null` when no pane uses an agent (skip the lookup entirely).
 */
type AgentIndex = Map<string, AgentSummary> | null;

async function buildAgentIndex(specs: CreatePaneSpec[]): Promise<AgentIndex> {
  const uses = specs.some((s) => typeof s.agent === "string" && s.agent.trim());
  if (!uses) return null;
  const all = await listAgents();
  return new Map(all.map((a) => [a.slug, a]));
}

/** Resolve a pane's `agent` slug to its card, or fail listing valid slugs. */
function requireAgentBySlug(slug: string, index: AgentIndex): AgentSummary {
  const found = index?.get(slug);
  if (found) return found;
  const valid = index ? [...index.keys()].join(", ") : "";
  throw new Error(
    `unknown agent ${JSON.stringify(slug)} — valid agent slugs: ${valid || "(no custom agents)"}`,
  );
}

/** A custom agent's suggested runtime, mapped to a terminal runtime (vibe = codex). */
function terminalRuntimeOf(runtime: string): "claude" | "codex" {
  return runtime === "claude" ? "claude" : "codex";
}

/** A native session's access from the agent's default (workspace | full), else workspace. */
function agentAccess(agent: AgentSummary | null): "workspace" | "full" {
  return agent?.defaultAccess === "full" ? "full" : "workspace";
}

/**
 * Create one native Vibe session (create_panes native:true). Worktree /
 * runtime / profile do not apply (V1) — cwd, model, reasoning→effort, name and
 * prompt do. Access defaults to workspace-write for orchestrator-created
 * sessions (the human still decides approvals).
 */
async function createOneNativeSession(
  spec: CreatePaneSpec,
  agentIndex: AgentIndex,
): Promise<{ result: CreatePaneResult; prompt?: PendingPrompt }> {
  const cwd = typeof spec.cwd === "string" ? spec.cwd.trim() : "";
  if (!cwd) throw new Error("cwd is required and must be a non-empty path");
  const slug = typeof spec.agent === "string" ? spec.agent.trim() : "";
  const agent = slug ? requireAgentBySlug(slug, agentIndex) : null;
  // the call may override the agent's defaults; otherwise they prefill
  const model = (
    typeof spec.model === "string" && spec.model.trim()
      ? spec.model.trim()
      : (agent?.defaultModel?.trim() ?? "")
  );
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/.test(model))
    throw new Error(`invalid model "${model}" — letters, digits and . _ : / - only`);
  const effort =
    typeof spec.reasoning === "string" ? spec.reasoning : agent?.defaultEffort;
  if (effort && !["minimal", "low", "medium", "high", "xhigh"].includes(effort))
    throw new Error(`invalid reasoning "${effort}"`);
  const id = await startVibeSession({
    name: typeof spec.name === "string" && spec.name.trim()
      ? spec.name.trim()
      : (agent?.name ?? "Session"),
    projectDir: cwd,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    // an agent session runs under the agent's default access (workspace | full)
    // — its own folder is added to the sandbox's writable roots by the backend,
    // so the specialist can maintain its memory.md approval-free (see
    // codex/sessions.rs). Non-agent orchestrator sessions stay workspace.
    access: agentAccess(agent),
    ...(agent ? { agentSlug: agent.slug } : {}),
  });
  const name = useVibe.getState().sessions[id]?.session.name ?? spec.name ?? null;
  return {
    result: { id, name, cwd, native: true },
    prompt:
      typeof spec.prompt === "string" && spec.prompt.trim()
        ? { id, text: spec.prompt, native: true }
        : undefined,
  };
}

async function createOnePane(
  spec: CreatePaneSpec,
  gitBin: string | undefined,
  agentIndex: AgentIndex,
): Promise<{ result: CreatePaneResult; prompt?: PendingPrompt }> {
  if (spec.native) return createOneNativeSession(spec, agentIndex);
  const cwd = typeof spec.cwd === "string" ? spec.cwd.trim() : "";
  if (!cwd) throw new Error("cwd is required and must be a non-empty path");
  const state = useSwarm.getState();

  // resolve a custom agent and let its defaults prefill runtime/model/reasoning
  // (an explicit call value always wins). "vibe" agents run as codex terminals.
  const slug = typeof spec.agent === "string" ? spec.agent.trim() : "";
  const agent = slug ? requireAgentBySlug(slug, agentIndex) : null;
  const eff: CreatePaneSpec = agent
    ? {
        ...spec,
        runtime: spec.runtime ?? terminalRuntimeOf(agent.defaultRuntime),
        model: spec.model ?? agent.defaultModel,
        reasoning:
          spec.reasoning ??
          (agent.defaultEffort as CreatePaneSpec["reasoning"] | undefined),
      }
    : spec;

  const profile = eff.profile_id
    ? state.profiles.find((p) => p.id === eff.profile_id)
    : undefined;
  if (eff.profile_id && !profile) {
    const valid = state.profiles.map((p) => `${p.id} ("${p.name}")`).join(", ");
    throw new Error(
      `unknown profile_id "${spec.profile_id}" — valid profiles: ${valid || "(none)"}`,
    );
  }
  // an explicit runtime without a profile pins the matching startup command —
  // otherwise createAgent would fall back to the settings default, which may
  // belong to a different runtime
  let startup =
    !profile && eff.runtime ? defaultStartupForRuntime(eff.runtime) : undefined;

  // Optional model override ("open an Opus pane"): appended as a CLI flag to
  // the pane's effective startup. Strictly validated — the startup line runs
  // in a shell, so the model id must never carry shell metacharacters.
  const model = typeof eff.model === "string" ? eff.model.trim() : "";
  const reasoning = typeof eff.reasoning === "string" ? eff.reasoning : "";
  if (model || reasoning) {
    if (model && !/^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/.test(model))
      throw new Error(
        `invalid model "${model}" — letters, digits and . _ : / - only`,
      );
    if (reasoning && !["minimal", "low", "medium", "high", "xhigh"].includes(reasoning))
      throw new Error(`invalid reasoning "${reasoning}"`);
    const base =
      profile?.startup ??
      startup ??
      state.settings.defaultStartup?.trim() ??
      defaultStartupForRuntime(state.settings.defaultRuntime ?? "codex");
    const effRuntime =
      eff.runtime ?? profile?.runtime ?? runtimeFromStartup(base);
    if (effRuntime === "shell")
      throw new Error(
        "model/reasoning need an agent runtime (claude or codex) — this pane would be a plain shell",
      );
    if (effRuntime === "claude" && reasoning)
      throw new Error('reasoning is codex-only — omit it for claude panes');
    // note: appended to the END of the startup line — fine for the simple
    // single-command startups profiles/defaults use; compound custom commands
    // would need smarter splicing (not a supported orchestrator path today)
    startup =
      base +
      (model ? (effRuntime === "claude" ? ` --model ${model}` : ` -m ${model}`) : "") +
      (reasoning ? ` -c model_reasoning_effort="${reasoning}"` : "");
  }

  // Custom agent: compile + write .compiled.md and inject the persona flag onto
  // the pane's startup (the Phase-B mechanic, exactly like NewAgentDialog). A
  // shell never carries a persona; an agent implies a coding runtime, so the
  // effective runtime resolves to claude/codex here.
  let agentSlug: string | undefined;
  if (agent) {
    const base =
      startup ??
      profile?.startup ??
      state.settings.defaultStartup?.trim() ??
      defaultStartupForRuntime(eff.runtime ?? "codex");
    const effRuntime = eff.runtime ?? profile?.runtime ?? runtimeFromStartup(base);
    if (effRuntime === "claude" || effRuntime === "codex") {
      const compiledPath = await writeAgentCompiled(agent.slug);
      startup = injectAgentIntoStartup(base, effRuntime, compiledPath);
      agentSlug = agent.slug;
    }
  }

  let worktree: { root: string; branch: string } | undefined;
  let paneCwd = cwd;
  if (eff.worktree) {
    // worktree FIRST, exactly like NewAgentDialog: repo check, generated
    // branch, `.worktrees/<slug>` + env copy via the native flow. A non-repo
    // folder is an ERROR — never a silent downgrade to a plain pane.
    const info = await fetchGitInfo(cwd, gitBin).catch(() => null);
    if (!info?.repo)
      throw new Error(
        `worktree requested but "${cwd}" is not inside a git repository`,
      );
    const branch = eff.branch?.trim() || generateBranchName(info.repo);
    const wt = await addWorktree({ cwd, branch, copyEnv: true, gitBin });
    worktree = { root: wt.root, branch: wt.branch };
    paneCwd = wt.path;
  }

  const id = useSwarm.getState().createAgent(
    {
      name: eff.name,
      runtime: eff.runtime,
      cwd: paneCwd,
      startup,
      profileId: profile?.id,
      worktree,
      agentSlug,
    },
    "row",
  );
  const created = useSwarm.getState().agents[id];
  return {
    result: {
      id,
      name: created?.name ?? eff.name ?? null,
      cwd: paneCwd,
      worktree: worktree ?? null,
    },
    prompt:
      typeof eff.prompt === "string" && eff.prompt.trim()
        ? { id, text: eff.prompt, native: false }
        : undefined,
  };
}

/** Grouping key for placement: the pane's project (cwd folder basename). */
function projectBasename(cwd: unknown): string | null {
  if (typeof cwd !== "string" || !cwd.trim()) return null;
  const parts = cwd.trim().replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || null;
}

/** Container aspect ratio (w/h), with a sensible fallback when unmeasured. */
function aspectOf(dims: LayoutDims | null): number {
  return dims && dims.h > 0 ? dims.w / dims.h : 1.6;
}

/** Honest, human-readable account of where the batch's panes landed. */
function buildPlacementSummary(results: CreatePaneResult[]): string {
  const byWs = new Map<string, { name: string; count: number }>();
  let created = 0;
  let failed = 0;
  let native = 0;
  for (const r of results) {
    if (r.error) {
      failed++;
      continue;
    }
    if (r.native) {
      native++;
      continue;
    }
    if (r.id) {
      created++;
      const key = r.workspace_id ?? "?";
      const e = byWs.get(key) ?? { name: r.workspace_name ?? "workspace", count: 0 };
      e.count++;
      byWs.set(key, e);
    }
  }
  const segs = [...byWs.values()].map((e) => `${e.count} in «${e.name}»`);
  let summary =
    created > 0
      ? `created ${created} pane${created === 1 ? "" : "s"}: ${segs.join("; ")}`
      : "created 0 panes";
  if (byWs.size > 1)
    summary += " — overflowed into a new workspace to keep panes readable";
  if (native)
    summary += `; ${native} native session${native === 1 ? "" : "s"}`;
  if (failed) summary += `; ${failed} failed`;
  return summary;
}

export const executors: Record<OrchestratorToolName, ToolExecutor> = {
  // ---- read tools ----

  fleet_snapshot: async () => {
    const s = useSwarm.getState();
    const sessions = fleetSessions();
    const dims = gatherGridDims(s.workspaceOrder);
    const workspaces = fleetSnapshot(s, dims);
    const crowd = crowdingNote(workspaces);
    const base = fleetSummaryLine(s, sessions);
    return {
      summary: crowd ? `${base} · ${crowd}` : base,
      ui_mode: s.settings.uiMode ?? "grid",
      workspaces,
      sessions,
    };
  },

  read_transcript: async (args) => {
    const target = requireTarget(args.pane_id);
    // native session: render its structured items compactly (pure fn)
    if (target.kind === "session") {
      const entry = target.entry;
      const items = entry.order
        .map((id) => entry.items[id])
        .filter((i): i is NonNullable<typeof i> => !!i);
      const tail =
        typeof args.tail_messages === "number" ? args.tail_messages : undefined;
      return {
        session: {
          id: entry.session.id,
          name: entry.session.name,
          cwd: entry.session.projectDir,
          model: entry.session.model ?? null,
          access: entry.session.access,
        },
        native: true,
        transcript: renderSessionTranscript(items, { tail }),
      };
    }
    const agent = target.agent;
    const runtime = agent.runtime ?? "claude";
    if (runtime === "shell")
      throw new Error("no transcript: shell pane (plain terminal, no agent session)");
    if (!agent.sessionId)
      throw new Error(
        "no transcript: the pane's agent session has not been discovered yet (it may not have done anything so far)",
      );
    const cwd = agent.cwd ?? (await getHome());
    const transcript = await readTranscript({
      cwd,
      sessionId: agent.sessionId,
      runtime,
      tailMessages:
        typeof args.tail_messages === "number" ? args.tail_messages : undefined,
      includeFirstUserMessage:
        typeof args.include_first_user_message === "boolean"
          ? args.include_first_user_message
          : undefined,
    });
    return {
      pane: { id: agent.id, name: agent.name, runtime, cwd: agent.cwd ?? null },
      transcript,
    };
  },

  read_project_docs: async (args) => {
    const hasPane = typeof args.pane_id === "string" && args.pane_id.trim();
    const hasPath = typeof args.path === "string" && args.path.trim();
    if (!!hasPane === !!hasPath)
      throw new Error('exactly one of "pane_id" or "path" is required');
    let root: string;
    if (hasPane) {
      // resolve panes first, then native Vibe sessions (their projectDir) —
      // same id semantics as prompt_pane / read_transcript
      const target = requireTarget(args.pane_id);
      const targetRoot =
        target.kind === "pane"
          ? target.agent.worktree?.root ?? target.agent.cwd
          : target.entry.session.projectDir;
      if (!targetRoot) {
        const label =
          target.kind === "pane" ? `pane "${target.agent.name}"` : `session "${target.entry.session.name}"`;
        throw new Error(
          `${label} has no working directory (home) — pass "path" instead`,
        );
      }
      root = targetRoot;
    } else {
      root = (args.path as string).trim();
    }
    return projectDocs(root);
  },

  read_notes: async () => {
    const { quickNotes } = useSwarm.getState();
    return {
      global: stripNotes(quickNotes.global),
      folders: Object.fromEntries(
        Object.entries(quickNotes.folders).map(([path, items]) => [
          path,
          stripNotes(items),
        ]),
      ),
    };
  },

  git_status: async (args) => {
    const agent = requireAgent(args.pane_id);
    const pane = { id: agent.id, name: agent.name, cwd: agent.cwd ?? null };
    if (agent.git === null)
      return { pane, git: null, note: `not a git repository: ${agent.cwd ?? "~"}` };
    if (!agent.git)
      return { pane, git: null, note: "git status not polled yet for this pane" };
    const g = agent.git;
    return {
      pane,
      git: {
        repo: g.repo,
        branch: g.branch,
        insertions: g.insertions,
        deletions: g.deletions,
        untracked: g.untracked,
        dirty: g.insertions + g.deletions + g.untracked > 0,
        remote_url: g.remote_url,
      },
      worktree: agent.worktree ?? null,
    };
  },

  list_projects: async (args) => {
    // no scan_roots from the model → the user's configured default folders
    // (Settings → Orchestrator) are scanned instead
    const scanRoots = Array.isArray(args.scan_roots)
      ? args.scan_roots.filter((r): r is string => typeof r === "string")
      : (useSwarm.getState().settings.orchestratorScanRoots ?? []);
    return discoverProjects(scanRoots);
  },

  list_blueprints: async () => {
    const s = useSwarm.getState();
    // "which models exist here" — honestly derived from real usage (open
    // panes + persisted usage history) instead of a hardcoded list that
    // would go stale. These ids are directly usable as create_panes.model.
    const recentModels: Record<"claude" | "codex", Set<string>> = {
      claude: new Set(),
      codex: new Set(),
    };
    const note = (runtime: string | undefined, model: string | undefined) => {
      if (!model) return;
      if (runtime === "codex") recentModels.codex.add(model);
      else if (runtime === "claude" || runtime === undefined)
        recentModels.claude.add(model);
    };
    for (const a of Object.values(s.agents)) {
      note(a.runtime, a.usage?.primary_model ?? undefined);
      for (const m of a.usage?.by_model ?? []) note(a.runtime, m.model);
    }
    const history = Object.values(s.usageHistory)
      .sort((a, b) => b.last_updated - a.last_updated)
      .slice(0, 120);
    for (const e of history) for (const m of e.by_model) note(e.runtime, m.model);
    return {
      default_runtime: s.settings.defaultRuntime ?? "codex",
      runtimes: {
        claude: {
          default_startup: defaultStartupForRuntime("claude"),
          recently_used_models: [...recentModels.claude].slice(0, 12),
        },
        codex: {
          default_startup: defaultStartupForRuntime("codex"),
          recently_used_models: [...recentModels.codex].slice(0, 12),
        },
      },
      profiles: s.profiles.map((p) => ({
        id: p.id,
        name: p.name,
        runtime: p.runtime ?? runtimeFromStartup(p.startup),
        startup: p.startup,
        defaultCwd: p.defaultCwd ?? null,
      })),
      workspace_presets: s.workspacePresets.map((preset) => {
        const panes = presetPanes(preset.layout);
        return {
          id: preset.id,
          name: preset.name,
          pane_count: panes.length,
          panes: panes.map((n) => ({
            runtime:
              n.runtime ??
              (n.startup !== undefined ? runtimeFromStartup(n.startup) : null),
            cwd: n.cwd ?? null,
            name: n.name ?? null,
          })),
        };
      }),
    };
  },

  list_agents: async () => {
    // the user's custom specialists — start one via create_panes `agent`
    const agents = await listAgents();
    return { agents: agentListForModel(agents) };
  },

  // ---- write tools ----

  prompt_pane: async (args, ctx) => {
    const target = requireTarget(args.pane_id);
    const text = String(args.text ?? "");
    if (!text) throw new Error("text must not be empty");

    // native Vibe session: submit one turn (busy sessions REFUSE — unlike
    // panes, which queue — because the backend rejects a second turn too)
    if (target.kind === "session") {
      const entry = target.entry;
      const id = entry.session.id;
      const name = entry.session.name;
      assertSessionPromptAllowed(id, name);
      await vibeSendMessage(id, text);
      notePromptDelivered(id, name, ctx);
      return {
        delivered: true,
        session: { id, name },
        submitted: true,
      };
    }

    const agent = target.agent;
    if (agent.status === "exited")
      throw new Error(
        `pane "${agent.name}" (${agent.id}) has exited — cannot deliver text`,
      );
    assertPromptAllowed(agent);
    // review mode (orchestratorAutoSubmit off) overrides the model's submit
    const reviewMode = reviewModeActive();
    const submit = !reviewMode && args.submit !== false;
    const activity = agent.activity ?? null;
    // LOAD-BEARING: delivery goes through insertCommandText (term.paste() =
    // bracketed paste + a SEPARATE \r on submit) — never raw ptyWrite
    insertCommandText(agent.id, text, submit);
    notePromptDelivered(agent.id, agent.name, ctx);
    const result: PromptPaneResult = {
      delivered: true,
      pane: { id: agent.id, name: agent.name, runtime: agent.runtime ?? "claude" },
      activity_at_send: activity,
      submitted: submit,
    };
    if (reviewMode && args.submit !== false)
      result.note =
        "review mode — the text was pasted but not submitted; the user presses Enter in the pane to run it";
    if (activity === "busy")
      result.warning = "pane was busy — text queued in its input";
    return result;
  },

  create_panes: async (args, ctx) => {
    const specs = args.panes as CreatePaneSpec[];
    if (!Array.isArray(specs) || specs.length < 1 || specs.length > 8)
      throw new Error("panes must contain 1–8 entries");
    const arrangement =
      typeof args.arrangement === "string" ? args.arrangement : "auto";
    if (!["auto", "rows", "columns", "grid"].includes(arrangement))
      throw new Error(
        `invalid arrangement "${arrangement}" — one of auto, rows, columns, grid`,
      );
    const gitBin =
      useSwarm.getState().settings.gitPath?.trim() || undefined;
    // one agent_list lookup for the whole batch (only when a pane names an agent)
    const agentIndex = await buildAgentIndex(specs);

    const results: (CreatePaneResult | undefined)[] = new Array(specs.length);
    const prompts: (PendingPrompt & { index: number })[] = [];
    const errResult = (i: number, e: unknown): CreatePaneResult => ({
      error: e instanceof Error ? e.message : String(e),
      cwd: typeof specs[i]?.cwd === "string" ? specs[i].cwd : null,
      name: typeof specs[i]?.name === "string" ? specs[i].name : null,
    });

    // Native sessions (native:true) are layout-agnostic — created up front,
    // ignoring workspace/arrangement/beside (documented in the schema).
    const nativeIdx: number[] = [];
    const termIdx: number[] = [];
    specs.forEach((sp, i) => (sp.native ? nativeIdx : termIdx).push(i));
    for (const i of nativeIdx) {
      try {
        const { result, prompt } = await createOneNativeSession(
          specs[i],
          agentIndex,
        );
        results[i] = result;
        if (prompt) prompts.push({ index: i, ...prompt });
      } catch (e) {
        results[i] = errResult(i, e);
      }
    }

    // ---- terminal panes: plan placement (capacity, overflow, grouping, beside)
    const s = useSwarm.getState();
    const dims = gatherGridDims(s.workspaceOrder);
    const activeDims =
      dims[s.activeWorkspaceId] ??
      s.workspaceOrder.map((id) => dims[id]).find((d): d is LayoutDims => !!d) ??
      null;

    // beside targets validated up front — an unknown target fails only its pane
    const planEntries: { origIndex: number; spec: PlanSpec }[] = [];
    for (const i of termIdx) {
      const b = specs[i].beside;
      const project = projectBasename(specs[i].cwd);
      if (b && typeof b.pane_id === "string") {
        if (!s.agents[b.pane_id]) {
          results[i] = errResult(
            i,
            new Error(`beside: unknown pane_id ${JSON.stringify(b.pane_id)}`),
          );
          continue;
        }
        planEntries.push({
          origIndex: i,
          spec: {
            project,
            beside: {
              paneId: b.pane_id,
              direction: b.direction === "below" ? "below" : "right",
            },
          },
        });
      } else {
        planEntries.push({ origIndex: i, spec: { project } });
      }
    }

    let primaryWsId: string | null = null;
    if (planEntries.length) {
      const workspaces: WsMeta[] = s.workspaceOrder.map((id) => ({
        id,
        name: s.workspaces[id]?.name ?? "",
        panes: collectPanes(s.layouts[id] ?? null).length,
        dims: dims[id] ?? null,
      }));
      const plan = planPlacement({
        workspace: typeof args.workspace === "string" ? args.workspace : undefined,
        workspaceId:
          typeof args.workspace_id === "string" ? args.workspace_id : undefined,
        arrangement: arrangement as Arrangement,
        activeWorkspaceId: s.activeWorkspaceId,
        workspaces,
        newWorkspaceDims: activeDims,
        specs: planEntries.map((e) => e.spec),
        min: MIN_PANE,
      });
      if (plan.error) throw new Error(plan.error);

      // A. auto buckets — create the panes, then apply a BALANCED equal-size
      // layout (fixes the "each new pane smaller than the last" cascade).
      // Sequential on purpose: parallel `git worktree add` races on git locks.
      for (let bi = 0; bi < plan.buckets.length; bi++) {
        const bucket = plan.buckets[bi];
        const wsId =
          bucket.ref.kind === "existing"
            ? bucket.ref.id
            : useSwarm.getState().createWorkspace({ name: bucket.ref.name });
        if (bi === 0) primaryWsId = wsId;
        if (useSwarm.getState().activeWorkspaceId !== wsId)
          useSwarm.getState().setActiveWorkspace(wsId);
        const wsName = useSwarm.getState().workspaces[wsId]?.name ?? "";
        const originalLayout = useSwarm.getState().layouts[wsId] ?? null;
        const createdIds: string[] = [];
        for (const planIdx of bucket.indices) {
          const i = planEntries[planIdx].origIndex;
          try {
            const { result, prompt } = await createOnePane(specs[i], gitBin, agentIndex);
            result.workspace_id = wsId;
            result.workspace_name = wsName;
            results[i] = result;
            if (result.id) createdIds.push(result.id);
            if (prompt) prompts.push({ index: i, ...prompt });
          } catch (e) {
            results[i] = errResult(i, e);
          }
        }
        const aspect = aspectOf(dims[wsId] ?? activeDims);
        const added = buildArrangement(createdIds, bucket.arrangement, aspect);
        if (added && createdIds.length) {
          const finalLayout = originalLayout
            ? combineLayouts(originalLayout, added, aspect)
            : added;
          useSwarm.getState().setWorkspaceLayout(wsId, finalLayout, createdIds[0]);
        }
      }

      // B. beside panes — create, then graft next to the target pane.
      for (const bp of plan.beside) {
        const i = planEntries[bp.index].origIndex;
        const targetAgent = useSwarm.getState().agents[bp.targetPaneId];
        if (!targetAgent) {
          results[i] = errResult(
            i,
            new Error(`beside: target pane ${bp.targetPaneId} is gone`),
          );
          continue;
        }
        const wsId = targetAgent.workspaceId;
        primaryWsId ??= wsId;
        if (useSwarm.getState().activeWorkspaceId !== wsId)
          useSwarm.getState().setActiveWorkspace(wsId);
        try {
          const { result, prompt } = await createOnePane(specs[i], gitBin, agentIndex);
          result.workspace_id = wsId;
          result.workspace_name =
            useSwarm.getState().workspaces[wsId]?.name ?? "";
          results[i] = result;
          if (result.id) {
            const cur = useSwarm.getState().layouts[wsId] ?? null;
            const base = removePaneByAgent(cur, result.id);
            const targetPane = base ? findPaneByAgent(base, bp.targetPaneId) : null;
            if (base && targetPane) {
              const grafted = splitPane(
                base,
                targetPane.id,
                result.id,
                bp.direction === "below" ? "column" : "row",
              );
              useSwarm.getState().setWorkspaceLayout(wsId, grafted, result.id);
            }
          }
          if (prompt) prompts.push({ index: i, ...prompt });
        } catch (e) {
          results[i] = errResult(i, e);
        }
      }
    }

    // land the user back on the primary target
    primaryWsId ??= useSwarm.getState().activeWorkspaceId;
    if (useSwarm.getState().activeWorkspaceId !== primaryWsId)
      useSwarm.getState().setActiveWorkspace(primaryWsId);

    // startup prompts in parallel once all panes/sessions exist. Native
    // sessions submit a turn straight away (the thread is live once started);
    // terminal panes wait for their CLI to boot (deliverStartupPrompt).
    await Promise.all(
      prompts.map(async ({ index, id, text, native }) => {
        if (native) {
          await vibeSendMessage(id, text);
          notePromptDelivered(
            id,
            useVibe.getState().sessions[id]?.session.name ??
              results[index]?.name ??
              id,
            ctx,
          );
          return;
        }
        const { delivered, note } = await deliverStartupPrompt(id, text);
        const r = results[index];
        if (note && r) r.warning = note;
        // delivered startup prompts count as orchestrator prompts too
        // (submitted or not): guard window + touched-pane tracking for the
        // activity pings
        if (delivered)
          notePromptDelivered(
            id,
            useSwarm.getState().agents[id]?.name ?? results[index]?.name ?? id,
            ctx,
          );
      }),
    );

    const finalResults: CreatePaneResult[] = results.map(
      (r) => r ?? { error: "not created" },
    );
    const out: CreatePanesResult = {
      workspace_id: primaryWsId,
      panes: finalResults,
      summary: buildPlacementSummary(finalResults),
    };
    return out;
  },

  create_workspace: async (args) => {
    const s = useSwarm.getState();
    const id = s.createWorkspace({
      name: typeof args.name === "string" ? args.name : undefined,
      defaultCwd:
        typeof args.default_cwd === "string" && args.default_cwd.trim()
          ? args.default_cwd.trim()
          : undefined,
    });
    const ws = useSwarm.getState().workspaces[id];
    return { id, name: ws?.name ?? "" };
  },

  // ---- memory tool ----

  remember: async (args) => {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) throw new Error("nothing to remember: text must not be empty");
    // Rust enforces the caps + FIFO and returns an honest note (e.g. dropped
    // the oldest entry). The remember chip shows in the chat via tool_call/done.
    const res = await appendMemory(text);
    return { remembered: text, ...res };
  },
};
