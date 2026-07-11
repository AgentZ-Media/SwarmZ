// Orchestrator tool executors — one async function per tool in the Rust
// registry (src-tauri/src/orchestrator/registry.rs, the single source of
// names/schemas). They run in the webview because that's where the Zustand
// stores live; the bus (bus.ts) dispatches `orchestrator://tool-request`
// events here and reports results back to Rust.
//
// Args arrive pre-validated by the Rust registry (required props + basic
// types) — executors still throw clear errors for everything semantic
// (unknown agent ids, non-repo git requests, gated cleanups, …). A thrown
// error becomes the tool call's error message.

import { invoke } from "@tauri-apps/api/core";
import { useSwarm } from "@/store";
import type { NoteItem, VibeAccess } from "@/types";
import { fetchGitInfo } from "@/lib/transport";
import { useProjects } from "@/lib/projects/store";
import { pushFleetEvent } from "@/lib/events";
import { useVibe, type VibeSessionEntry } from "@/lib/vibe/session-store";
import {
  // STRICT on purpose: the orchestrator must never report `delivered:true`
  // for a turn that never started (the UI path swallows failures — they are
  // already visible in the transcript as warning items)
  sendMessageStrict as vibeSendMessage,
  steerMessageStrict as vibeSteerMessage,
  startSession as startVibeSession,
  closeSession as closeVibeSession,
  interrupt as interruptVibeSession,
  // STRICT: the server-anchored Conductor path — Rust refuses anything not
  // classified "routine", the UI status commits only after Rust's ack
  respondApprovalStrict as respondVibeApproval,
  setAccess as setVibeAccess,
  setModelEffort as setVibeModelEffort,
  assignWorktreeToSession,
  reviewSession,
  waitForSessionIdle,
} from "@/lib/vibe/controller";
import { renderSessionTranscript } from "@/lib/vibe/transcript";
import { pickAgentName, branchSlugForAgent } from "@/lib/vibe/names";
import {
  addWorktree,
  listWorktrees,
  removeWorktree,
  worktreeStatus,
} from "@/lib/worktree";
import {
  fetchGhAuthStatus,
  fetchGhPrList,
  fetchGhPrView,
  ghCommentPr,
  ghCreatePr,
  ghReviewPr,
} from "@/lib/github/api";
import { unwrapGh } from "@/lib/github/core";
import { useGithub } from "@/lib/github/store";
import {
  refreshProjectGithub,
  unwatchPr,
  watchPr,
} from "@/lib/github/controller";
import { useOrchestrator } from "./chat-store";
import {
  AGENT_REPORT_SCHEMA,
  bindReportExpectation,
  clearReportExpectation,
  noteReportExpected,
  REPORT_PROMPT_SUFFIX,
} from "./report";
import {
  fleetSummaryLine,
  sessionSnapshot,
  worktreeOccupancy,
} from "./snapshot";
import { discoverProjects, projectDocs } from "./native";
import { appendMemory } from "./memory";
import {
  cancelTimer,
  createTimer,
  listTimers,
} from "./timers";
import { describeRemaining, resolveFireAt } from "./timers-core";
import type {
  ConductorPlanDocument,
  ConductorPlanInfo,
  OrchestratorToolName,
  PromptAgentResult,
  SpawnAgentResult,
  SpawnAgentSpec,
  SpawnAgentsResult,
  ToolNoteItem,
} from "./types";

/**
 * Per-call context the bus passes alongside the args. `chatId` is the STORE
 * chat id of the orchestrator chat whose turn triggered the call (the bus
 * resolves the backend id) — null for dev-hook calls (`__orch.tool`), which
 * therefore never track touched sessions. `projectId` is the Conductor
 * instance's project — session resolution, worktrees, timers and plans are
 * all scoped on it; null = unscoped (dev-hook).
 */
export interface ToolCallContext {
  chatId: string | null;
  projectId: string | null;
}

export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx: ToolCallContext,
) => Promise<unknown>;

// ---- write guards + touched-session tracking ----

/** Two orchestrator prompts into the SAME session within this window error. */
export const DOUBLE_PROMPT_WINDOW_MS = 2_000;

/**
 * Last orchestrator prompt delivery per session id — across ALL chats and
 * including spawn_agents startup tasks (in-memory; the guard is about
 * accidental duplicates within seconds, not restarts).
 */
const lastPromptDelivery = new Map<string, number>();

/**
 * The duplicate-delivery guard. Since Phase 4 a BUSY session no longer
 * refuses — prompt_agent steers the running turn instead — so this guard is
 * the only precondition left.
 */
function assertNoDoublePrompt(sessionId: string, name: string): void {
  const last = lastPromptDelivery.get(sessionId);
  if (last !== undefined && Date.now() - last < DOUBLE_PROMPT_WINDOW_MS) {
    throw new Error(
      `agent "${name}" (${sessionId}) already received an orchestrator prompt ${Date.now() - last} ms ago — this looks like a duplicate call; wait a moment and re-send only if it was intentional`,
    );
  }
}

/**
 * Record a delivered prompt: feeds the double-prompt guard, and — when the
 * call carries a chat context — the chat's touchedPanes (the activity
 * watcher only pings sessions recorded here). Every delivery also lands in
 * the Deck's fleet event feed (`▸ orch → session`).
 */
function notePromptDelivered(
  sessionId: string,
  sessionName: string,
  ctx: ToolCallContext,
): void {
  lastPromptDelivery.set(sessionId, Date.now());
  if (ctx.chatId)
    useOrchestrator
      .getState()
      .recordTouchedPane(ctx.chatId, sessionId, sessionName);
  pushFleetEvent({ kind: "orch_prompt", sessionId, sessionName });
}

/** Ordered session entries (rail order), optionally scoped to one project. */
function orderedSessions(projectId: string | null): VibeSessionEntry[] {
  const v = useVibe.getState();
  return v.order
    .map((id) => v.sessions[id])
    .filter((e): e is VibeSessionEntry => !!e)
    .filter((e) => projectId === null || e.session.projectId === projectId);
}

/** The session snapshot shared by fleet_snapshot + the summary (scoped). */
export function fleetSessions(projectId: string | null = null) {
  const v = useVibe.getState();
  return sessionSnapshot({ sessions: orderedSessions(projectId), busy: v.busy });
}

/**
 * Resolve an `agent` argument to its session entry WITHIN the call's project
 * scope, or fail listing every valid id. Accepts a raw session id, or a
 * session name / agent name (optionally `@`-prefixed, case-insensitive)
 * that is unique within the scope.
 */
function requireSession(agent: unknown, ctx: ToolCallContext): VibeSessionEntry {
  const scoped = orderedSessions(ctx.projectId);
  if (typeof agent === "string" && agent.trim()) {
    const byId = scoped.find((e) => e.session.id === agent);
    if (byId) return byId;
    // name resolution: "@Maya" / "maya" — unique within the project scope
    const needle = agent.trim().replace(/^@/, "").toLowerCase();
    const byName = scoped.filter(
      (e) =>
        e.session.name.toLowerCase() === needle ||
        e.session.agentName.toLowerCase() === needle,
    );
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      throw new Error(
        `ambiguous agent name ${JSON.stringify(String(agent))} — matches: ${byName
          .map((e) => `${e.session.id} ("${e.session.name}")`)
          .join(", ")}; use the id`,
      );
    }
  }
  const valid = scoped
    .map((e) => `${e.session.id} ("${e.session.name}")`)
    .join(", ");
  throw new Error(
    `unknown agent ${JSON.stringify(String(agent))} — valid agents${
      ctx.projectId ? " in this project" : ""
    }: ${valid || "(no agents)"}`,
  );
}

function stripNotes(items: NoteItem[]): ToolNoteItem[] {
  return items.map((n) => ({ text: n.text, done: n.done }));
}

/** The Conductor's project record — required by project-scoped tools. */
function requireProject(ctx: ToolCallContext): { id: string; dir: string } {
  const projectId = ctx.projectId ?? "";
  const dir = useProjects.getState().projects[projectId]?.dir?.trim() ?? "";
  if (!projectId || !dir)
    throw new Error(
      "this tool needs a project context — no project folder available",
    );
  return { id: projectId, dir };
}

/** Names already used by sessions of the scope (collision set). */
function takenAgentNames(projectId: string | null): string[] {
  const taken: string[] = [];
  for (const e of orderedSessions(projectId)) {
    taken.push(e.session.agentName, e.session.name);
  }
  return taken;
}

function gitBin(): string | undefined {
  return useSwarm.getState().settings.gitPath?.trim() || undefined;
}

/** The Settings master toggle of the GitHub integration (Phase 7). */
function githubEnabled(): boolean {
  return !!useSwarm.getState().settings.githubIntegration;
}

/**
 * Hard gate of every github tool except `github_status` (which reports the
 * state instead). The registry keeps the tools statically declared — this
 * runtime refusal is the enforceable gate (see the github section below).
 */
function requireGithub(): void {
  if (!githubEnabled())
    throw new Error(
      "GitHub integration is disabled (Settings → GitHub) — this tool is unavailable. Do not retry; if the user wants GitHub work, tell them to enable the integration.",
    );
}

/** Validate a PR `number` argument. */
function requirePrNumber(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0)
    throw new Error("number must be a positive PR number (from list_prs)");
  return raw;
}

/** Trailing-slash-insensitive path equality. */
function samePath(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/** Sessions (ALL projects) working in `path` — cleanup/shared bookkeeping. */
function sessionsInPath(path: string): VibeSessionEntry[] {
  return orderedSessions(null).filter((e) =>
    samePath(e.session.projectDir, path),
  );
}

/** Resolve symlinks (macOS /tmp → /private/tmp) — falls back to the input. */
function canonicalizePath(path: string): Promise<string> {
  return invoke<string>("canonicalize_path", { path }).catch(() => path);
}

/**
 * Find one SwarmZ worktree entry by path, scoped to the CALLING Conductor's
 * project repo ONLY — a Conductor must never assign agents into or clean up
 * another project's worktrees, so the persisted cross-project registry is
 * deliberately NOT consulted. The model-supplied path is canonicalized
 * before matching (git reports canonical paths).
 */
async function findWorktreeEntry(path: string, ctx: ToolCallContext) {
  const { dir } = requireProject(ctx);
  const canonical = await canonicalizePath(path);
  const scan = await listWorktrees([dir], gitBin());
  return (
    scan.entries.find(
      (e) => samePath(e.path, canonical) || samePath(e.path, path),
    ) ?? null
  );
}

/**
 * Per-worktree async mutex: cleanup, assignment and the shared occupancy /
 * status re-checks of ONE worktree path run strictly serialized, so a
 * cleanup can never interleave with a re-homing or a second cleanup between
 * its final checks and the removal. Keyed by canonical path.
 */
const worktreeLocks = new Map<string, Promise<unknown>>();

async function withWorktreeLock<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = (await canonicalizePath(path)).replace(/\/+$/, "");
  const tail = worktreeLocks.get(key) ?? Promise.resolve();
  const run = tail.then(fn, fn); // previous failures don't poison the queue
  worktreeLocks.set(
    key,
    run.catch(() => {}),
  );
  return run;
}

// ---- spawn_agents ----

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/;

/**
 * How long a shared lane's NEXT initial turn waits for the previous agent's
 * turn to finish (one writer per worktree). Kept under the tool's registry
 * timeout so an over-busy lane degrades into an honest per-agent warning,
 * never a bus timeout.
 */
const SHARED_LANE_WAIT_MS = 8 * 60 * 1000;

/** Placement of one agent: worktree "new" | "shared:<agent>" | "none". */
async function resolvePlacement(
  spec: SpawnAgentSpec,
  name: string,
  ctx: ToolCallContext,
  projectDir: string,
): Promise<{
  cwd: string;
  worktree: { root: string; branch: string; shared: boolean } | null;
  sharedHostId?: string;
}> {
  const placement = String(spec.worktree ?? "").trim();
  if (placement === "none") {
    return { cwd: projectDir, worktree: null };
  }
  if (placement === "new") {
    const base = branchSlugForAgent(name, spec.task);
    let lastErr = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const branch = attempt === 0 ? base : `${base}-${attempt + 1}`;
      try {
        const info = await addWorktree({
          cwd: projectDir,
          branch,
          copyEnv: true,
          gitBin: gitBin(),
        });
        useSwarm.getState().registerWorktreeRepo(info.root);
        return {
          cwd: info.path,
          worktree: { root: info.root, branch: info.branch, shared: false },
        };
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        // branch/folder collisions retry with a suffix; real git errors abort
        if (!/already exists/i.test(lastErr)) break;
      }
    }
    throw new Error(`could not create a worktree: ${lastErr}`);
  }
  if (placement.startsWith("shared:")) {
    const hostName = placement.slice("shared:".length).trim();
    if (!hostName) throw new Error('placement "shared:" needs an agent name');
    const host = requireSession(hostName, ctx);
    if (!host.session.worktree) {
      throw new Error(
        `agent "${host.session.name}" has no worktree to share — place it in one first (worktree "new" or assign_worktree)`,
      );
    }
    return {
      cwd: host.session.projectDir,
      worktree: {
        root: host.session.worktree.root,
        branch: host.session.worktree.branch,
        shared: true,
      },
      sharedHostId: host.session.id,
    };
  }
  throw new Error(
    `unknown worktree placement ${JSON.stringify(placement)} — use "new", "shared:<agentName>" or "none"`,
  );
}

/**
 * Create one agent session (marked conductor-spawned) per its spec.
 * `reservedNames` is the BATCH's case-insensitive name reservation: explicit
 * names collide loudly (against live sessions AND earlier batch entries —
 * duplicate names would make `shared:<name>` and every name-based tool
 * ambiguous), auto-picked names avoid the whole set; the chosen name is
 * added before any await, so a parallel retry can't re-use it.
 */
async function spawnOneAgent(
  spec: SpawnAgentSpec,
  ctx: ToolCallContext,
  projectId: string,
  projectDir: string,
  reservedNames: Set<string>,
): Promise<{
  result: SpawnAgentResult;
  task?: { id: string; text: string; expectReport: boolean };
}> {
  const task = typeof spec.task === "string" ? spec.task.trim() : "";
  if (!task) throw new Error("task must not be empty");
  const model = typeof spec.model === "string" ? spec.model.trim() : "";
  if (model && !MODEL_RE.test(model))
    throw new Error(`invalid model "${model}" — letters, digits and . _ : / - only`);
  const effort =
    typeof spec.effort === "string" && spec.effort.trim()
      ? spec.effort.trim()
      : "medium"; // swarm default: sub-agents run medium unless chosen otherwise
  const access: VibeAccess = spec.access === "full" ? "full" : "workspace";
  const explicit = typeof spec.name === "string" ? spec.name.trim() : "";
  if (explicit && reservedNames.has(explicit.toLowerCase())) {
    throw new Error(
      `agent name "${explicit}" is already in use in this project — pick a different name or omit it`,
    );
  }
  const name = explicit || pickAgentName([...reservedNames]);
  reservedNames.add(name.toLowerCase());

  const placement = await resolvePlacement(spec, name, ctx, projectDir);
  let id: string;
  try {
    id = await startVibeSession({
      name,
      agentName: name,
      projectDir: placement.cwd,
      projectId,
      spawnedBy: "conductor",
      worktree: placement.worktree,
      ...(model ? { model } : {}),
      effort,
      access,
    });
  } catch (err) {
    // a FRESH worktree created for this agent must not orphan when the
    // session never started — roll it back (it is clean by construction;
    // the gated non-force removal double-checks that)
    const msg = err instanceof Error ? err.message : String(err);
    if (placement.worktree && !placement.worktree.shared) {
      let rolledBack = false;
      try {
        await removeWorktree({
          root: placement.worktree.root,
          path: placement.cwd,
          branch: placement.worktree.branch,
          force: false,
          gitBin: gitBin(),
        });
        rolledBack = true;
      } catch {
        /* rollback failed — name the path below so nothing orphans silently */
      }
      throw new Error(
        rolledBack
          ? `${msg} (the freshly created worktree was rolled back)`
          : `${msg} — AND the fresh worktree could not be rolled back; clean it up via cleanup_worktree: ${placement.cwd}`,
      );
    }
    throw err instanceof Error ? err : new Error(msg);
  }
  // joining an existing worktree marks the host shared too
  if (placement.sharedHostId) {
    useVibe.getState().setWorktreeShared(placement.sharedHostId, true);
  }
  const entry = useVibe.getState().sessions[id];
  return {
    result: {
      id,
      name: entry?.session.name ?? name,
      cwd: placement.cwd,
      branch: placement.worktree?.branch ?? null,
      shared: placement.worktree?.shared ?? false,
    },
    task: { id, text: task, expectReport: spec.expect_report === true },
  };
}

/** Honest, human-readable account of what the batch created. */
function buildSummary(results: SpawnAgentResult[]): string {
  const created = results.filter((r) => r.id && !r.error).length;
  const failed = results.filter((r) => r.error).length;
  let summary = `spawned ${created} agent${created === 1 ? "" : "s"}`;
  if (failed) summary += `; ${failed} failed`;
  return summary;
}

// ---- plans (thin invoke wrappers — Rust owns the confinement) ----

function planWrite(
  projectDir: string,
  title: string,
  markdown: string,
): Promise<ConductorPlanInfo> {
  return invoke<ConductorPlanInfo>("conductor_plan_write", {
    projectDir,
    title,
    markdown,
  });
}

function planList(projectDir: string): Promise<ConductorPlanInfo[]> {
  return invoke<ConductorPlanInfo[]>("conductor_plan_list", { projectDir });
}

function planRead(
  projectDir: string,
  slug: string,
): Promise<ConductorPlanDocument> {
  return invoke<ConductorPlanDocument>("conductor_plan_read", {
    projectDir,
    slug,
  });
}

export const executors: Record<OrchestratorToolName, ToolExecutor> = {
  // ---- sensing ----

  fleet_snapshot: async (_args, ctx) => {
    const sessions = fleetSessions(ctx.projectId);
    const project = ctx.projectId
      ? (useProjects.getState().projects[ctx.projectId] ?? null)
      : null;
    const now = Date.now();
    const timers = ctx.projectId
      ? listTimers(ctx.projectId).map((t) => ({
          id: t.id,
          note: t.note,
          fires_at: new Date(t.at).toISOString(),
          remaining: describeRemaining(t.at, now),
        }))
      : [];
    return {
      // the Conductor's own project heads the snapshot (null = unscoped dev call)
      project: project
        ? { id: project.id, name: project.name, dir: project.dir }
        : null,
      summary: fleetSummaryLine(sessions),
      sessions,
      // who works where — sessions without a worktree work in the project dir
      worktrees: worktreeOccupancy(sessions),
      timers,
    };
  },

  read_agent: async (args, ctx) => {
    const entry = requireSession(args.agent, ctx);
    const items = entry.order
      .map((id) => entry.items[id])
      .filter((i): i is NonNullable<typeof i> => !!i);
    const tail =
      typeof args.tail_messages === "number" ? args.tail_messages : undefined;
    return {
      agent: {
        id: entry.session.id,
        name: entry.session.name,
        cwd: entry.session.projectDir,
        model: entry.session.model ?? null,
        access: entry.session.access,
        worktree: entry.session.worktree,
      },
      transcript: renderSessionTranscript(items, { tail }),
    };
  },

  read_project_docs: async (args, ctx) => {
    const hasAgent = typeof args.agent === "string" && args.agent.trim();
    const hasPath = typeof args.path === "string" && args.path.trim();
    if (!!hasAgent === !!hasPath)
      throw new Error('exactly one of "agent" or "path" is required');
    const root = hasAgent
      ? requireSession(args.agent, ctx).session.projectDir
      : (args.path as string).trim();
    if (!root)
      throw new Error("the agent has no working directory — pass \"path\" instead");
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

  git_status: async (args, ctx) => {
    const hasAgent = typeof args.agent === "string" && args.agent.trim();
    const hasPath = typeof args.path === "string" && args.path.trim();
    if (!!hasAgent === !!hasPath)
      throw new Error('exactly one of "agent" or "path" is required');
    let cwd: string;
    let agent: { id: string; name: string } | null = null;
    if (hasAgent) {
      const entry = requireSession(args.agent, ctx);
      cwd = entry.session.projectDir;
      agent = { id: entry.session.id, name: entry.session.name };
    } else {
      cwd = (args.path as string).trim();
    }
    const g = await fetchGitInfo(cwd, gitBin()).catch(() => null);
    if (!g) return { agent, cwd, git: null, note: `not a git repository: ${cwd}` };
    return {
      agent,
      cwd,
      git: {
        repo: g.repo,
        branch: g.branch,
        insertions: g.insertions,
        deletions: g.deletions,
        untracked: g.untracked,
        dirty: g.insertions + g.deletions + g.untracked > 0,
        remote_url: g.remote_url,
      },
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

  // ---- agents ----

  prompt_agent: async (args, ctx) => {
    const entry = requireSession(args.agent, ctx);
    const text = String(args.text ?? "");
    if (!text) throw new Error("text must not be empty");
    const id = entry.session.id;
    const name = entry.session.name;
    assertNoDoublePrompt(id, name);
    // expect_report (Phase 5): the fresh turn is outputSchema-constrained so
    // the agent ends with a machine-readable status report. Schema AND
    // report suffix apply ONLY to FRESH turns (freshTurnText) — a steered
    // running turn keeps its own format and must not receive a report
    // instruction it has no schema/expectation for (documented in the
    // registry description).
    const expectReport = args.expect_report === true;
    // registered BEFORE the send — a very fast completion event must not
    // beat the registration and lose the structured parsing; cleared again
    // on a steer (no schema applied) or a failed send
    if (expectReport) noteReportExpected(id);
    let how: { mode: "steered" | "queued"; turnId: string | null };
    try {
      // steerMessageStrict routes by state: busy → turn/steer (mid-flight
      // injection), idle → a fresh turn. Both STRICT — failures reject.
      how = await vibeSteerMessage(
        id,
        text,
        expectReport
          ? {
              outputSchema:
                AGENT_REPORT_SCHEMA as unknown as Record<string, unknown>,
              freshTurnText: text + REPORT_PROMPT_SUFFIX,
            }
          : undefined,
      );
    } catch (err) {
      if (expectReport) clearReportExpectation(id);
      throw err;
    }
    if (expectReport) {
      if (how.mode === "steered") clearReportExpectation(id);
      else bindReportExpectation(id, how.turnId);
    }
    notePromptDelivered(id, name, ctx);
    const result: PromptAgentResult = {
      delivered: true,
      agent: { id, name },
      mode: how.mode === "steered" ? "steered" : "turn",
    };
    return result;
  },

  spawn_agents: async (args, ctx) => {
    const specs = args.agents as SpawnAgentSpec[];
    if (!Array.isArray(specs) || specs.length < 1 || specs.length > 8)
      throw new Error("agents must contain 1–8 entries");
    const { id: projectId, dir: projectDir } = requireProject(ctx);

    // case-insensitive name reservation for the whole batch: live sessions
    // of the project + every name this batch hands out — explicit duplicate
    // names fail their spec instead of creating ambiguous `shared:<name>` /
    // name-based-tool targets
    const reservedNames = new Set(
      takenAgentNames(projectId).map((n) => n.toLowerCase()),
    );

    const results: SpawnAgentResult[] = new Array(specs.length);
    const tasks: {
      index: number;
      id: string;
      text: string;
      expectReport: boolean;
    }[] = [];
    // sequential on purpose — each start creates a worktree (git checkout)
    // and spawns a codex process; "shared:" placements may reference agents
    // spawned earlier in the SAME batch
    for (let i = 0; i < specs.length; i++) {
      try {
        const { result, task } = await spawnOneAgent(
          specs[i],
          ctx,
          projectId,
          projectDir,
          reservedNames,
        );
        results[i] = result;
        if (task) tasks.push({ index: i, ...task });
      } catch (e) {
        results[i] = {
          error: e instanceof Error ? e.message : String(e),
          name: typeof specs[i]?.name === "string" ? specs[i].name : null,
        };
      }
    }

    // initial tasks once all agents exist — GROUPED BY WORKTREE: within one
    // lane the next agent's turn starts only after the previous agent's turn
    // FINISHED (one writer per worktree — a Promise.all kickoff would have
    // several agents mutating the same checkout at once); distinct lanes
    // still kick off in parallel. A lane that stays busy past the deadline
    // hands the remaining tasks back to the Conductor instead of starting a
    // second writer.
    const deliver = async ({
      index,
      id,
      text,
      expectReport,
    }: (typeof tasks)[number]) => {
      try {
        // expect_report (Phase 5): the task turn is outputSchema-constrained
        // so the agent ends with a machine-readable status report. The
        // expectation registers BEFORE the send (a racing completion event
        // must not lose the parsing), binds to the acked turn id after, and
        // clears on a failed send (catch below).
        if (expectReport) noteReportExpected(id);
        const sent = await vibeSendMessage(
          id,
          expectReport ? text + REPORT_PROMPT_SUFFIX : text,
          expectReport
            ? {
                outputSchema:
                  AGENT_REPORT_SCHEMA as unknown as Record<string, unknown>,
              }
            : undefined,
        );
        if (expectReport) bindReportExpectation(id, sent.turnId);
        notePromptDelivered(
          id,
          useVibe.getState().sessions[id]?.session.name ??
            results[index]?.name ??
            id,
          ctx,
        );
        return true;
      } catch (e) {
        if (expectReport) clearReportExpectation(id);
        const r = results[index];
        if (r)
          r.warning = `task not delivered: ${e instanceof Error ? e.message : String(e)}`;
        return false;
      }
    };
    const lanes = new Map<string, typeof tasks>();
    for (const t of tasks) {
      const cwd = results[t.index]?.cwd ?? t.id;
      const lane = lanes.get(cwd) ?? [];
      lane.push(t);
      lanes.set(cwd, lane);
    }
    await Promise.all(
      [...lanes.values()].map(async (lane) => {
        for (let i = 0; i < lane.length; i++) {
          if (i > 0) {
            const prev = lane[i - 1];
            const prevName =
              useVibe.getState().sessions[prev.id]?.session.name ?? prev.id;
            const idle = await waitForSessionIdle(prev.id, SHARED_LANE_WAIT_MS);
            if (!idle) {
              for (let j = i; j < lane.length; j++) {
                const r = results[lane[j].index];
                if (r && !r.warning)
                  r.warning = `task not delivered: the shared worktree is still busy with «${prevName}» — prompt this agent once the lane is free (one writer per worktree)`;
              }
              break;
            }
          }
          await deliver(lane[i]);
        }
      }),
    );

    const out: SpawnAgentsResult = {
      agents: results,
      summary: buildSummary(results),
    };
    return out;
  },

  interrupt_agent: async (args, ctx) => {
    const entry = requireSession(args.agent, ctx);
    const id = entry.session.id;
    if (!useVibe.getState().busy[id]) {
      return {
        interrupted: false,
        agent: { id, name: entry.session.name },
        note: "no turn is running — nothing to interrupt",
      };
    }
    interruptVibeSession(id);
    return { interrupted: true, agent: { id, name: entry.session.name } };
  },

  close_agent: async (args, ctx) => {
    const entry = requireSession(args.agent, ctx);
    const { id, name, worktree, projectDir } = entry.session;
    await closeVibeSession(id);
    return {
      closed: true,
      agent: { id, name },
      ...(worktree
        ? {
            note: `the agent's worktree stays (${projectDir}) — clean it via cleanup_worktree once the work is merged or discarded`,
          }
        : {}),
    };
  },

  set_agent_config: async (args, ctx) => {
    const entry = requireSession(args.agent, ctx);
    const id = entry.session.id;
    const touched: string[] = [];
    if (args.model !== undefined || args.effort !== undefined) {
      const model =
        args.model === undefined
          ? entry.session.model
          : String(args.model).trim() || undefined;
      if (model && !MODEL_RE.test(model))
        throw new Error(`invalid model "${model}"`);
      const effort =
        args.effort === undefined
          ? entry.session.effort
          : String(args.effort).trim() || undefined;
      await setVibeModelEffort(id, model, effort);
      if (args.model !== undefined) touched.push("model");
      if (args.effort !== undefined) touched.push("effort");
    }
    if (args.access !== undefined) {
      const access = args.access === "full" ? "full" : "workspace";
      await setVibeAccess(id, access);
      touched.push("access");
    }
    if (touched.length === 0)
      throw new Error("nothing to change — pass model, effort and/or access");
    const after = useVibe.getState().sessions[id]?.session;
    return {
      agent: { id, name: entry.session.name },
      changed: touched,
      config: {
        model: after?.model ?? null,
        effort: after?.effort ?? null,
        access: after?.access ?? entry.session.access,
      },
      note: "takes effect from the agent's next turn",
    };
  },

  review_agent: async (args, ctx) => {
    const entry = requireSession(args.agent, ctx);
    const target = typeof args.target === "string" ? args.target : "uncommitted";
    const res = await reviewSession(entry.session.id, target);
    return {
      agent: { id: entry.session.id, name: entry.session.name },
      cwd: entry.session.projectDir,
      target: target || "uncommitted",
      status: res.status,
      review: res.review ?? "(the review returned no findings text)",
    };
  },

  decide_approval: async (args, ctx) => {
    const entry = requireSession(args.agent, ctx);
    const decision = args.decision === "decline" ? "decline" : "accept";
    const wanted =
      typeof args.approval_id === "string" && args.approval_id.trim()
        ? args.approval_id.trim()
        : null;
    const pending = entry.order
      .map((iid) => entry.items[iid])
      .filter(
        (i): i is Extract<NonNullable<typeof i>, { kind: "approval" }> =>
          !!i && i.kind === "approval" && i.status === "pending",
      );
    if (pending.length === 0)
      throw new Error(
        `agent "${entry.session.name}" has no pending approval to decide`,
      );
    const approval = wanted
      ? pending.find((a) => a.id === wanted)
      : pending[0];
    if (!approval)
      throw new Error(
        `no pending approval "${wanted}" on agent "${entry.session.name}" — pending: ${pending
          .map((a) => a.id)
          .join(", ")}`,
      );
    if (approval.escalation !== "routine")
      throw new Error(
        "this approval is classified DESTRUCTIVE — only the human may decide it; tell the user it is waiting",
      );
    // the STRICT server-anchored path: Rust re-checks the class stored next
    // to the blocked Responder and refuses anything non-routine — the check
    // above is a fast courtesy, never the authority. Errors (already
    // resolved by the human, dead session, destructive) propagate; nothing
    // is marked optimistically.
    await respondVibeApproval(entry.session.id, approval.id, decision);
    return {
      decided: true,
      agent: { id: entry.session.id, name: entry.session.name },
      approval_id: approval.id,
      decision,
    };
  },

  // ---- worktrees ----

  create_worktree: async (args, ctx) => {
    const { dir } = requireProject(ctx);
    const branch =
      (typeof args.branch === "string" && args.branch.trim()) ||
      `swarm/lane-${1000 + Math.floor(Math.random() * 9000)}`;
    const info = await addWorktree({
      cwd: dir,
      branch,
      copyEnv: true,
      gitBin: gitBin(),
    });
    useSwarm.getState().registerWorktreeRepo(info.root);
    return {
      root: info.root,
      path: info.path,
      branch: info.branch,
      copied_env_files: info.copied,
    };
  },

  assign_worktree: async (args, ctx) => {
    const entry = requireSession(args.agent, ctx);
    const path = String(args.path ?? "").trim();
    if (!path) throw new Error("path must not be empty");
    // same lock as cleanup_worktree: a re-homing can never interleave with a
    // cleanup's final occupancy check on the same worktree
    return withWorktreeLock(path, async () => {
      const wt = await findWorktreeEntry(path, ctx);
      if (!wt)
        throw new Error(
          `no SwarmZ worktree at ${path} in this project — create one first (create_worktree / spawn_agents worktree:"new")`,
        );
      if (wt.missing)
        throw new Error(`the worktree folder is gone: ${path}`);
      // shared iff another agent already works there
      const others = sessionsInPath(wt.path).filter(
        (e) => e.session.id !== entry.session.id,
      );
      const shared = others.length > 0;
      // rejects busy sessions; commits metadata only after the backend ack
      await assignWorktreeToSession(entry.session.id, {
        path: wt.path,
        root: wt.root,
        branch: wt.branch,
        shared,
      });
      if (shared) {
        for (const other of others)
          useVibe.getState().setWorktreeShared(other.session.id, true);
      }
      return {
        agent: { id: entry.session.id, name: entry.session.name },
        path: wt.path,
        branch: wt.branch,
        shared,
        note: "the agent works there from its next turn on",
      };
    });
  },

  worktree_status: async (_args, ctx) => {
    const { dir } = requireProject(ctx);
    const scan = await listWorktrees([dir], gitBin());
    return {
      worktrees: scan.entries.map((e) => ({
        path: e.path,
        branch: e.branch,
        dirty: e.dirty,
        ahead: e.ahead,
        ...(e.ahead_unknown ? { ahead_unknown: true } : {}),
        missing: e.missing,
        agents: sessionsInPath(e.path).map((s) => s.session.name),
      })),
    };
  },

  cleanup_worktree: async (args, ctx) => {
    const path = String(args.path ?? "").trim();
    if (!path) throw new Error("path must not be empty");
    // ONE per-worktree lock around occupancy + status + removal: nothing may
    // re-home into (assign_worktree takes the same lock) or re-check this
    // path while the cleanup decides. The removal itself is the GATED
    // non-force path — Rust re-checks dirty/ahead inside the call and `git
    // worktree remove` (without --force) refuses even later-appearing work.
    return withWorktreeLock(path, async () => {
      const wt = await findWorktreeEntry(path, ctx);
      if (!wt) throw new Error(`no SwarmZ worktree at ${path} in this project`);
      const occupants = sessionsInPath(wt.path);
      if (occupants.length > 0)
        throw new Error(
          `refused: agent${occupants.length === 1 ? "" : "s"} ${occupants
            .map((e) => `"${e.session.name}"`)
            .join(", ")} still work${occupants.length === 1 ? "s" : ""} in this worktree — close or re-home them first`,
        );
      // SAFE GATE: re-check at execution time — on ANY doubt (including an
      // uncomputable ahead count) the worktree stays
      const st = await worktreeStatus(wt.path, gitBin());
      if (st.exists && st.dirty)
        throw new Error(
          "refused: the worktree has uncommitted changes — commit, merge or explicitly discard them first (or ask the user)",
        );
      if ((st.exists && st.ahead_unknown) || (!st.exists && wt.ahead_unknown))
        throw new Error(
          `refused: could not verify whether branch "${wt.branch}" holds unmerged commits — resolve manually (or ask the user)`,
        );
      const ahead = st.exists ? st.ahead : wt.ahead;
      if (ahead > 0)
        throw new Error(
          `refused: branch "${wt.branch}" holds ${ahead} commit${ahead === 1 ? "" : "s"} no other branch has — merge or push it first (or ask the user)`,
        );
      await removeWorktree({
        root: wt.root,
        path: wt.path,
        branch: wt.branch,
        force: false,
        gitBin: gitBin(),
      });
      void useSwarm.getState().refreshWorktrees();
      return { removed: true, path: wt.path, branch: wt.branch };
    });
  },

  // ---- timers ----

  set_timer: async (args, ctx) => {
    const { id: projectId } = requireProject(ctx);
    const note = typeof args.note === "string" ? args.note.trim() : "";
    if (!note) throw new Error("note must not be empty");
    const resolved = resolveFireAt(Date.now(), args.delay_seconds, args.at_iso);
    if ("error" in resolved) throw new Error(resolved.error);
    const timer = createTimer(projectId, note, resolved.at);
    return {
      timer_id: timer.id,
      note: timer.note,
      fires_at: new Date(timer.at).toISOString(),
      remaining: describeRemaining(timer.at, Date.now()),
    };
  },

  list_timers: async (_args, ctx) => {
    const { id: projectId } = requireProject(ctx);
    const now = Date.now();
    return {
      timers: listTimers(projectId).map((t) => ({
        timer_id: t.id,
        note: t.note,
        fires_at: new Date(t.at).toISOString(),
        remaining: describeRemaining(t.at, now),
      })),
    };
  },

  cancel_timer: async (args, ctx) => {
    const { id: projectId } = requireProject(ctx);
    const timerId = String(args.timer_id ?? "").trim();
    const timer = cancelTimer(projectId, timerId);
    return { cancelled: true, timer_id: timer.id, note: timer.note };
  },

  // ---- plans ----

  write_plan: async (args, ctx) => {
    const { dir } = requireProject(ctx);
    const title = String(args.title ?? "");
    const markdown = String(args.markdown ?? "");
    const info = await planWrite(dir, title, markdown);
    return {
      written: true,
      slug: info.slug,
      path: info.path,
      note: "agents can read this file — reference the path in their briefs",
    };
  },

  list_plans: async (_args, ctx) => {
    const { dir } = requireProject(ctx);
    return { plans: await planList(dir) };
  },

  read_plan: async (args, ctx) => {
    const { dir } = requireProject(ctx);
    return planRead(dir, String(args.slug ?? ""));
  },

  // ---- github (Phase 7 — gated on the Settings master toggle) ----
  //
  // GATING DECISION (documented in AGENTS.md): the tools stay in the static
  // registry catalog and are gated HERE at runtime. Dynamic registration
  // can't be enforced anyway — dynamicTools are declared at thread/start and
  // live in the rollout, so a mid-run Settings toggle could never retract
  // them from running threads; a uniform runtime refusal is the only gate
  // that always holds (and Rust re-gates the write commands server-side).
  // `github_status` is the one tool that always answers — it reports the
  // disabled state instead of erroring, so the Conductor can explain it.

  github_status: async (_args, ctx) => {
    if (!githubEnabled()) {
      return {
        integration_enabled: false,
        note: "The GitHub integration is disabled (Settings → GitHub). Every other github tool refuses while it is off — if the user asks for GitHub work, tell them to enable it there.",
      };
    }
    const { id: projectId, dir } = requireProject(ctx);
    const auth = await fetchGhAuthStatus();
    if (!auth.installed || !auth.authenticated) {
      return {
        integration_enabled: true,
        auth,
        note: auth.installed
          ? "gh is installed but not logged in — the user must run `gh auth login`"
          : "the GitHub CLI (gh) is not installed on this machine",
      };
    }
    // detection through the shared controller path keeps the panel cache warm
    await refreshProjectGithub(projectId, { force: true });
    const gh = useGithub.getState();
    const project = gh.byProject[projectId];
    if (!project || project.repoStatus !== "ok" || !project.repo) {
      return {
        integration_enabled: true,
        auth: { login: auth.login },
        repo: null,
        note:
          project?.repoStatus === "no_remote"
            ? `this project (${dir}) has no GitHub remote`
            : `GitHub repo detection failed: ${project?.repoError ?? project?.repoStatus ?? "unknown"}`,
      };
    }
    const watched = gh.watched[projectId] ?? [];
    return {
      integration_enabled: true,
      auth: { login: auth.login },
      repo: project.repo,
      open_prs: project.prs.map((p) => ({
        number: p.number,
        title: p.title,
        head: p.head_ref,
        draft: p.is_draft,
        checks: p.checks,
        review_decision: p.review_decision,
        watched: watched.includes(p.number),
      })),
    };
  },

  list_prs: async (_args, ctx) => {
    requireGithub();
    const { id: projectId, dir } = requireProject(ctx);
    const prs = unwrapGh(await fetchGhPrList(dir), "list PRs");
    // keep the panel/Deck cache in sync with what the Conductor just saw
    useGithub.getState().patchProject(projectId, {
      repoStatus: "ok",
      prs,
      prsFetchedAt: Date.now(),
      prsError: null,
    });
    const watched = useGithub.getState().watched[projectId] ?? [];
    return {
      prs: prs.map((p) => ({
        number: p.number,
        title: p.title,
        author: p.author,
        head: p.head_ref,
        base: p.base_ref,
        draft: p.is_draft,
        mergeable: p.mergeable,
        review_decision: p.review_decision,
        checks: p.checks,
        url: p.url,
        watched: watched.includes(p.number),
      })),
    };
  },

  read_pr: async (args, ctx) => {
    requireGithub();
    const { dir } = requireProject(ctx);
    const number = requirePrNumber(args.number);
    const includeDiff = args.include_diff !== false;
    const detail = unwrapGh(
      await fetchGhPrView(dir, number, includeDiff),
      `read PR #${number}`,
    );
    return {
      number: detail.number,
      title: detail.title,
      author: detail.author,
      head: detail.head_ref,
      base: detail.base_ref,
      draft: detail.is_draft,
      mergeable: detail.mergeable,
      review_decision: detail.review_decision,
      checks: detail.checks,
      url: detail.url,
      body: detail.body,
      stats: {
        additions: detail.additions,
        deletions: detail.deletions,
        changed_files: detail.changed_files,
      },
      files: detail.files,
      reviews: detail.reviews,
      ...(includeDiff
        ? {
            diff: detail.diff ?? "(diff unavailable)",
            ...(detail.diff_truncated ? { diff_truncated: true } : {}),
          }
        : {}),
    };
  },

  create_pr: async (args, ctx) => {
    requireGithub();
    const { id: projectId } = requireProject(ctx);
    const title = String(args.title ?? "").trim();
    const body = String(args.body ?? "").trim();
    if (!title) throw new Error("title must not be empty");
    if (!body) throw new Error("body must not be empty — describe what changed and why");
    const hasAgent = typeof args.agent === "string" && args.agent.trim();
    const wantedBranch =
      typeof args.branch === "string" ? args.branch.trim() : "";
    if (!!hasAgent === !!wantedBranch)
      throw new Error('exactly one of "agent" or "branch" is required');
    // resolve the checkout the PR comes from: the agent's worktree, or the
    // project worktree carrying the named branch
    let checkoutDir: string;
    let branch: string;
    if (hasAgent) {
      const entry = requireSession(args.agent, ctx);
      if (!entry.session.worktree)
        throw new Error(
          `agent "${entry.session.name}" works directly in the project folder — a PR comes from a worktree branch (place the agent in one first)`,
        );
      checkoutDir = entry.session.projectDir;
      branch = entry.session.worktree.branch;
    } else {
      const { dir } = requireProject(ctx);
      const scan = await listWorktrees([dir], gitBin());
      const wt = scan.entries.find((e) => e.branch === wantedBranch && !e.missing);
      if (!wt)
        throw new Error(
          `no worktree on branch "${wantedBranch}" in this project — worktree_status lists the valid branches`,
        );
      checkoutDir = wt.path;
      branch = wt.branch;
    }
    const created = unwrapGh(
      await ghCreatePr({
        dir: checkoutDir,
        title,
        body,
        base:
          typeof args.base === "string" && args.base.trim()
            ? args.base.trim()
            : undefined,
        draft: args.draft === true,
      }),
      "create PR",
    );
    void refreshProjectGithub(projectId, { force: true });
    return {
      created: true,
      url: created.url,
      branch,
      note: "the branch was pushed to origin (plain push) and the PR opened — merging stays with the user",
    };
  },

  review_pr: async (args, ctx) => {
    requireGithub();
    const { dir } = requireProject(ctx);
    const number = requirePrNumber(args.number);
    // the PR's refs decide the review target (branch:<base>)
    const detail = unwrapGh(
      await fetchGhPrView(dir, number, false),
      `read PR #${number}`,
    );
    // the reviewing session: explicit agent, else the unique agent whose
    // worktree sits on the PR's head branch
    let entry: VibeSessionEntry;
    if (typeof args.agent === "string" && args.agent.trim()) {
      entry = requireSession(args.agent, ctx);
    } else {
      const onBranch = orderedSessions(ctx.projectId).filter(
        (e) => e.session.worktree?.branch === detail.head_ref,
      );
      if (onBranch.length === 0)
        throw new Error(
          `no agent of this project works on the PR's head branch "${detail.head_ref}" — spawn/assign one into a worktree on that branch (or read_pr ${number} and judge the diff yourself)`,
        );
      if (onBranch.length > 1)
        throw new Error(
          `several agents work on "${detail.head_ref}" (${onBranch
            .map((e) => e.session.name)
            .join(", ")}) — pass one explicitly as "agent"`,
        );
      entry = onBranch[0];
    }
    if (entry.session.worktree?.branch !== detail.head_ref)
      throw new Error(
        `agent "${entry.session.name}" is not on the PR's head branch "${detail.head_ref}" — the review must run in a checkout of that branch`,
      );
    const base = detail.base_ref || "main";
    const res = await reviewSession(entry.session.id, `branch:${base}`);
    const reviewText = res.review ?? "(the review returned no findings text)";
    const post = args.post === true;
    let posted = false;
    let postError: string | null = null;
    if (post) {
      const action =
        args.action === "approve" || args.action === "request_changes"
          ? args.action
          : "comment";
      try {
        unwrapGh(
          await ghReviewPr(
            dir,
            number,
            action,
            // GitHub caps review bodies — keep the posted text bounded
            reviewText.length > 60_000
              ? `${reviewText.slice(0, 60_000)}\n\n…(truncated)`
              : reviewText,
          ),
          "post the review",
        );
        posted = true;
      } catch (e) {
        postError = e instanceof Error ? e.message : String(e);
      }
    }
    return {
      number,
      agent: { id: entry.session.id, name: entry.session.name },
      target: `branch:${base}`,
      status: res.status,
      review: reviewText,
      posted,
      ...(postError ? { post_error: postError } : {}),
    };
  },

  comment_pr: async (args, ctx) => {
    requireGithub();
    const { dir } = requireProject(ctx);
    const number = requirePrNumber(args.number);
    const body = String(args.body ?? "").trim();
    if (!body) throw new Error("body must not be empty");
    const res = unwrapGh(
      await ghCommentPr(dir, number, body),
      `comment on PR #${number}`,
    );
    return { commented: true, number, ...(res as object) };
  },

  watch_pr: async (args, ctx) => {
    requireGithub();
    const { id: projectId, dir } = requireProject(ctx);
    const number = requirePrNumber(args.number);
    if (args.action === "unwatch") {
      const removed = unwatchPr(projectId, number);
      return {
        watching: false,
        number,
        note: removed
          ? `PR #${number} is no longer watched`
          : `PR #${number} was not watched`,
      };
    }
    // verify the PR exists before promising to watch it
    const prs = unwrapGh(await fetchGhPrList(dir), "list PRs");
    if (!prs.some((p) => p.number === number))
      throw new Error(
        `PR #${number} is not an open PR of this repo — list_prs shows the valid numbers`,
      );
    watchPr(projectId, number);
    return {
      watching: true,
      number,
      note: "every real change (checks, reviews, draft/ready, close/merge) wakes you with an autonomous [pr update] turn. The watch lasts for this app run — set a timer for follow-ups that must survive a restart.",
    };
  },

  // ---- memory ----

  remember: async (args, ctx) => {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) throw new Error("nothing to remember: text must not be empty");
    // scope "project" is the default — it needs the Conductor's project
    // context; an unscoped (dev-hook) call without an explicit scope falls
    // back to global instead of erroring
    const requested =
      args.scope === "global" || args.scope === "project"
        ? args.scope
        : undefined;
    const scope = requested ?? (ctx.projectId ? "project" : "global");
    if (scope === "project" && !ctx.projectId)
      throw new Error(
        'no project context for scope "project" — use scope "global"',
      );
    // Rust enforces the caps + FIFO and returns an honest note (e.g. dropped
    // the oldest entry). The remember chip shows in the chat via tool_call/done.
    const res = await appendMemory(text, scope, ctx.projectId ?? undefined);
    return { remembered: text, scope, ...res };
  },
};
