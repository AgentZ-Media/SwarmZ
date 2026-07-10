// Orchestrator tool executors — one async function per tool in the Rust
// registry (src-tauri/src/orchestrator/registry.rs, the single source of
// names/schemas). They run in the webview because that's where the Zustand
// stores live; the bus (bus.ts) dispatches `orchestrator://tool-request`
// events here and reports results back to Rust.
//
// Args arrive pre-validated by the Rust registry (required props + basic
// types) — executors still throw clear errors for everything semantic
// (unknown session ids, non-repo git requests, …). A thrown error becomes
// the tool call's error message.

import { useSwarm } from "@/store";
import type { NoteItem } from "@/types";
import { fetchGitInfo } from "@/lib/transport";
import { pushFleetEvent } from "@/lib/events";
import { useVibe, type VibeSessionEntry } from "@/lib/vibe/session-store";
import {
  // STRICT on purpose: the orchestrator must never report `delivered:true`
  // for a turn that never started (the UI path swallows failures — they are
  // already visible in the transcript as warning items)
  sendMessageStrict as vibeSendMessage,
  startSession as startVibeSession,
} from "@/lib/vibe/controller";
import { renderSessionTranscript } from "@/lib/vibe/transcript";
import { useOrchestrator } from "./chat-store";
import { fleetSummaryLine, sessionSnapshot } from "./snapshot";
import { discoverProjects, projectDocs } from "./native";
import { appendMemory } from "./memory";
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
 * therefore never track touched sessions.
 */
export interface ToolCallContext {
  chatId: string | null;
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
 * including create_panes startup prompts (in-memory; the guard is about
 * accidental duplicates within seconds, not restarts).
 */
const lastPromptDelivery = new Map<string, number>();

/**
 * The write choke point: the double-prompt guard, plus a busy session is
 * always REFUSED (a native session runs one turn at a time — the backend
 * rejects a second turn too).
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

/** Ordered session entries (rail order). */
function orderedSessions(): VibeSessionEntry[] {
  const v = useVibe.getState();
  return v.order
    .map((id) => v.sessions[id])
    .filter((e): e is VibeSessionEntry => !!e);
}

/** The session snapshot shared by fleet_snapshot + the summary. */
export function fleetSessions() {
  const v = useVibe.getState();
  return sessionSnapshot({ sessions: orderedSessions(), busy: v.busy });
}

/** Resolve a pane_id to its session entry, or fail listing every valid id. */
function requireSession(paneId: unknown): VibeSessionEntry {
  const entry =
    typeof paneId === "string" ? useVibe.getState().sessions[paneId] : undefined;
  if (entry) return entry;
  const valid = orderedSessions()
    .map((e) => `${e.session.id} ("${e.session.name}")`)
    .join(", ");
  throw new Error(
    `unknown pane_id ${JSON.stringify(String(paneId))} — valid session ids: ${valid || "(no sessions open)"}`,
  );
}

function stripNotes(items: NoteItem[]): ToolNoteItem[] {
  return items.map((n) => ({ text: n.text, done: n.done }));
}

/**
 * Create one native session (marked conductor-spawned). Access defaults to
 * workspace-write for orchestrator-created sessions (the human still
 * decides approvals).
 *
 * Project assignment: the session's PROJECT is resolved from its `cwd`
 * (startSession → `openProject`, deduped by canonical path) — NOT from the
 * user's currently active tab. Rationale: the orchestrator may spawn into
 * any folder, and a session must always live under the tab of the folder it
 * actually works in; an unknown cwd opens its project tab WITHOUT stealing
 * the user's active one (spawnedBy: "conductor" → activate: false).
 * Unnamed sessions get a pool agent name, collision-free per project.
 */
async function createOneSession(
  spec: CreatePaneSpec,
): Promise<{ result: CreatePaneResult; prompt?: { id: string; text: string } }> {
  const cwd = typeof spec.cwd === "string" ? spec.cwd.trim() : "";
  if (!cwd) throw new Error("cwd is required and must be a non-empty path");
  const model = typeof spec.model === "string" ? spec.model.trim() : "";
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/.test(model))
    throw new Error(`invalid model "${model}" — letters, digits and . _ : / - only`);
  const effort = typeof spec.reasoning === "string" ? spec.reasoning : undefined;
  if (effort && !["minimal", "low", "medium", "high", "xhigh"].includes(effort))
    throw new Error(`invalid reasoning "${effort}"`);
  const id = await startVibeSession({
    ...(typeof spec.name === "string" && spec.name.trim()
      ? { name: spec.name.trim() }
      : {}),
    projectDir: cwd,
    spawnedBy: "conductor",
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    access: "workspace",
  });
  const name = useVibe.getState().sessions[id]?.session.name ?? spec.name ?? null;
  return {
    result: { id, name, cwd },
    prompt:
      typeof spec.prompt === "string" && spec.prompt.trim()
        ? { id, text: spec.prompt }
        : undefined,
  };
}

/** Honest, human-readable account of what the batch created. */
function buildSummary(results: CreatePaneResult[]): string {
  const created = results.filter((r) => r.id && !r.error).length;
  const failed = results.filter((r) => r.error).length;
  let summary = `created ${created} session${created === 1 ? "" : "s"}`;
  if (failed) summary += `; ${failed} failed`;
  return summary;
}

export const executors: Record<OrchestratorToolName, ToolExecutor> = {
  // ---- read tools ----

  fleet_snapshot: async () => {
    const sessions = fleetSessions();
    return {
      summary: fleetSummaryLine(sessions),
      sessions,
    };
  },

  read_transcript: async (args) => {
    const entry = requireSession(args.pane_id);
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
      transcript: renderSessionTranscript(items, { tail }),
    };
  },

  read_project_docs: async (args) => {
    const hasPane = typeof args.pane_id === "string" && args.pane_id.trim();
    const hasPath = typeof args.path === "string" && args.path.trim();
    if (!!hasPane === !!hasPath)
      throw new Error('exactly one of "pane_id" or "path" is required');
    const root = hasPane
      ? requireSession(args.pane_id).session.projectDir
      : (args.path as string).trim();
    if (!root)
      throw new Error("the session has no project directory — pass \"path\" instead");
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
    const hasPane = typeof args.pane_id === "string" && args.pane_id.trim();
    const hasPath = typeof args.path === "string" && args.path.trim();
    if (!!hasPane === !!hasPath)
      throw new Error('exactly one of "pane_id" or "path" is required');
    let cwd: string;
    let session: { id: string; name: string } | null = null;
    if (hasPane) {
      const entry = requireSession(args.pane_id);
      cwd = entry.session.projectDir;
      session = { id: entry.session.id, name: entry.session.name };
    } else {
      cwd = (args.path as string).trim();
    }
    const gitBin = useSwarm.getState().settings.gitPath?.trim() || undefined;
    const g = await fetchGitInfo(cwd, gitBin).catch(() => null);
    if (!g) return { session, cwd, git: null, note: `not a git repository: ${cwd}` };
    return {
      session,
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

  // ---- write tools ----

  prompt_pane: async (args, ctx) => {
    const entry = requireSession(args.pane_id);
    const text = String(args.text ?? "");
    if (!text) throw new Error("text must not be empty");
    const id = entry.session.id;
    const name = entry.session.name;
    assertSessionPromptAllowed(id, name);
    await vibeSendMessage(id, text);
    notePromptDelivered(id, name, ctx);
    const result: PromptPaneResult = {
      delivered: true,
      session: { id, name },
      submitted: true,
    };
    return result;
  },

  create_panes: async (args, ctx) => {
    const specs = args.panes as CreatePaneSpec[];
    if (!Array.isArray(specs) || specs.length < 1 || specs.length > 8)
      throw new Error("panes must contain 1–8 entries");

    const results: CreatePaneResult[] = new Array(specs.length);
    const prompts: { index: number; id: string; text: string }[] = [];
    // sequential on purpose — each start spawns a codex process
    for (let i = 0; i < specs.length; i++) {
      try {
        const { result, prompt } = await createOneSession(specs[i]);
        results[i] = result;
        if (prompt) prompts.push({ index: i, ...prompt });
      } catch (e) {
        results[i] = {
          error: e instanceof Error ? e.message : String(e),
          cwd: typeof specs[i]?.cwd === "string" ? specs[i].cwd : null,
          name: typeof specs[i]?.name === "string" ? specs[i].name : null,
        };
      }
    }

    // initial prompts in parallel once all sessions exist — a session's
    // thread is live right after start, so the turn submits immediately
    await Promise.all(
      prompts.map(async ({ index, id, text }) => {
        try {
          await vibeSendMessage(id, text);
          notePromptDelivered(
            id,
            useVibe.getState().sessions[id]?.session.name ??
              results[index]?.name ??
              id,
            ctx,
          );
        } catch (e) {
          const r = results[index];
          if (r)
            r.warning = `prompt not delivered: ${e instanceof Error ? e.message : String(e)}`;
        }
      }),
    );

    const out: CreatePanesResult = {
      sessions: results,
      summary: buildSummary(results),
    };
    return out;
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
