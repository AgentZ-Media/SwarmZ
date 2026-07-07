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
import { useOrchestrator } from "./chat-store";
import { fleetSnapshot, fleetSummaryLine } from "./snapshot";
import { discoverProjects, projectDocs, readTranscript } from "./native";
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

async function createOnePane(
  spec: CreatePaneSpec,
  gitBin: string | undefined,
): Promise<{ result: CreatePaneResult; prompt?: { id: string; text: string } }> {
  const cwd = typeof spec.cwd === "string" ? spec.cwd.trim() : "";
  if (!cwd) throw new Error("cwd is required and must be a non-empty path");
  const state = useSwarm.getState();

  const profile = spec.profile_id
    ? state.profiles.find((p) => p.id === spec.profile_id)
    : undefined;
  if (spec.profile_id && !profile) {
    const valid = state.profiles.map((p) => `${p.id} ("${p.name}")`).join(", ");
    throw new Error(
      `unknown profile_id "${spec.profile_id}" — valid profiles: ${valid || "(none)"}`,
    );
  }
  // an explicit runtime without a profile pins the matching startup command —
  // otherwise createAgent would fall back to the settings default, which may
  // belong to a different runtime
  let startup =
    !profile && spec.runtime ? defaultStartupForRuntime(spec.runtime) : undefined;

  // Optional model override ("open an Opus pane"): appended as a CLI flag to
  // the pane's effective startup. Strictly validated — the startup line runs
  // in a shell, so the model id must never carry shell metacharacters.
  const model = typeof spec.model === "string" ? spec.model.trim() : "";
  const reasoning = typeof spec.reasoning === "string" ? spec.reasoning : "";
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
      spec.runtime ?? profile?.runtime ?? runtimeFromStartup(base);
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

  let worktree: { root: string; branch: string } | undefined;
  let paneCwd = cwd;
  if (spec.worktree) {
    // worktree FIRST, exactly like NewAgentDialog: repo check, generated
    // branch, `.worktrees/<slug>` + env copy via the native flow. A non-repo
    // folder is an ERROR — never a silent downgrade to a plain pane.
    const info = await fetchGitInfo(cwd, gitBin).catch(() => null);
    if (!info?.repo)
      throw new Error(
        `worktree requested but "${cwd}" is not inside a git repository`,
      );
    const branch = spec.branch?.trim() || generateBranchName(info.repo);
    const wt = await addWorktree({ cwd, branch, copyEnv: true, gitBin });
    worktree = { root: wt.root, branch: wt.branch };
    paneCwd = wt.path;
  }

  const id = useSwarm.getState().createAgent(
    {
      name: spec.name,
      runtime: spec.runtime,
      cwd: paneCwd,
      startup,
      profileId: profile?.id,
      worktree,
    },
    "row",
  );
  const agent = useSwarm.getState().agents[id];
  return {
    result: {
      id,
      name: agent?.name ?? spec.name ?? null,
      cwd: paneCwd,
      worktree: worktree ?? null,
    },
    prompt:
      typeof spec.prompt === "string" && spec.prompt.trim()
        ? { id, text: spec.prompt }
        : undefined,
  };
}

export const executors: Record<OrchestratorToolName, ToolExecutor> = {
  // ---- read tools ----

  fleet_snapshot: async () => {
    const s = useSwarm.getState();
    return { summary: fleetSummaryLine(s), workspaces: fleetSnapshot(s) };
  },

  read_transcript: async (args) => {
    const agent = requireAgent(args.pane_id);
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
      const agent = requireAgent(args.pane_id);
      const paneRoot = agent.worktree?.root ?? agent.cwd;
      if (!paneRoot)
        throw new Error(
          `pane "${agent.name}" has no working directory (home) — pass "path" instead`,
        );
      root = paneRoot;
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

  // ---- write tools ----

  prompt_pane: async (args, ctx) => {
    const agent = requireAgent(args.pane_id);
    if (agent.status === "exited")
      throw new Error(
        `pane "${agent.name}" (${agent.id}) has exited — cannot deliver text`,
      );
    const text = String(args.text ?? "");
    if (!text) throw new Error("text must not be empty");
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
    const s0 = useSwarm.getState();
    const wsId =
      typeof args.workspace_id === "string" && args.workspace_id
        ? args.workspace_id
        : s0.activeWorkspaceId;
    if (!s0.workspaces[wsId]) {
      const valid = s0.workspaceOrder
        .map((id) => `${id} ("${s0.workspaces[id]?.name}")`)
        .join(", ");
      throw new Error(`unknown workspace_id "${wsId}" — valid workspaces: ${valid}`);
    }
    const specs = args.panes as CreatePaneSpec[];
    if (!Array.isArray(specs) || specs.length < 1 || specs.length > 8)
      throw new Error("panes must contain 1–8 entries");
    // createAgent inserts into the ACTIVE workspace — activate the target
    // first (a visible side effect, and the pane becomes visible immediately,
    // consistent with every other create path)
    if (wsId !== s0.activeWorkspaceId) s0.setActiveWorkspace(wsId);
    const gitBin = s0.settings.gitPath?.trim() || undefined;

    // sequential on purpose: parallel `git worktree add` against the same
    // repo can race on git's lock files
    const results: CreatePaneResult[] = [];
    const prompts: { index: number; id: string; text: string }[] = [];
    for (const spec of specs) {
      try {
        const { result, prompt } = await createOnePane(spec, gitBin);
        results.push(result);
        if (prompt) prompts.push({ index: results.length - 1, ...prompt });
      } catch (e) {
        results.push({
          error: e instanceof Error ? e.message : String(e),
          cwd: typeof spec?.cwd === "string" ? spec.cwd : null,
          name: typeof spec?.name === "string" ? spec.name : null,
        });
      }
    }
    // startup prompts in parallel once all panes exist (each waits for its
    // own CLI — see deliverStartupPrompt for the readiness heuristic)
    await Promise.all(
      prompts.map(async ({ index, id, text }) => {
        const { delivered, note } = await deliverStartupPrompt(id, text);
        if (note) results[index].warning = note;
        // delivered startup prompts count as orchestrator prompts too
        // (submitted or not): guard window + touched-pane tracking for the
        // activity pings
        if (delivered)
          notePromptDelivered(
            id,
            useSwarm.getState().agents[id]?.name ?? results[index].name ?? id,
            ctx,
          );
      }),
    );
    const out: CreatePanesResult = { workspace_id: wsId, panes: results };
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
};
