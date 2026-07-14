import { useSwarm } from "@/store";
import type { VibeAccess } from "@/types";
import { useVibe, type VibeSessionEntry } from "@/lib/vibe/session-store";
import {
  sendMessageStrict as vibeSendMessage,
  steerMessageStrict as vibeSteerMessage,
  startSession as startVibeSession,
  closeSession as closeVibeSession,
  interrupt as interruptVibeSession,
  respondApprovalStrict as respondVibeApproval,
  setAccess as setVibeAccess,
  setModelEffort as setVibeModelEffort,
  reviewSession,
  waitForSessionIdle,
} from "@/lib/vibe/controller";
import { pickAgentName, branchSlugForAgent } from "@/lib/vibe/names";
import { addWorktree, removeWorktree } from "@/lib/worktree";
import { isAutonomousTurnInFlight } from "./controller";
import { withWorktreeBriefing } from "./briefing";
import {
  AGENT_REPORT_SCHEMA,
  bindReportExpectation,
  clearReportExpectation,
  noteReportExpected,
  REPORT_PROMPT_SUFFIX,
} from "./report";
import {
  fetchCodexModelCatalog,
  validateCatalogModelEffort,
  type CodexModelCatalogEntry,
} from "./models";
import type {
  PromptAgentResult,
  SpawnAgentResult,
  SpawnAgentSpec,
  SpawnAgentsResult,
} from "./types";
import type { ExecutorFamily } from "./executor-types";
import {
  assertNoDoublePrompt,
  notePromptDelivered,
  requireProject,
  requireSession,
  takenAgentNames,
  type ToolCallContext,
} from "./executor-agents";
import {
  approvalLooksLikeGithubWrite,
  gitBin,
  resolveAgentAccess,
  sanitizeAgentName,
  validModelId,
} from "./executor-guards";
import {
  busyLaneBlocker,
  sessionsInPath,
  withWorktreeLock,
} from "./executor-worktrees";
import { assertSafeSpawnBatch, spawnBatchSummary } from "./spawn-batch";

type AgentTool =
  | "prompt_agent"
  | "spawn_agents"
  | "interrupt_agent"
  | "close_agent"
  | "set_agent_config"
  | "review_agent"
  | "decide_approval";

/**
 * How long a shared lane's NEXT initial turn waits for the previous agent's
 * turn to finish (one writer per worktree). Kept under the tool's registry
 * timeout so an over-busy lane degrades into an honest per-agent warning,
 * never a bus timeout.
 */
const SHARED_LANE_WAIT_MS = 8 * 60 * 1000;

/**
 * Serialize the Conductor's check-and-send boundary per canonical checkout.
 * A different busy session in the same checkout owns the writer lease until
 * its turn lands idle; callers must retry instead of creating two writers.
 */
async function withLaneWriterClaim<T>(
  entry: VibeSessionEntry,
  operation: () => Promise<T>,
): Promise<T> {
  return withWorktreeLock(entry.session.projectDir, async () => {
    const state = useVibe.getState();
    const blocker = busyLaneBlocker(
      sessionsInPath(entry.session.projectDir),
      entry.session.projectDir,
      entry.session.id,
      state.busy,
    );
    if (blocker) {
      throw new Error(
        `refused: shared checkout writer lease is held by "${blocker.session.name}" — wait for that turn to finish`,
      );
    }
    return operation();
  });
}

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
  catalog: CodexModelCatalogEntry[],
): Promise<{
  result: SpawnAgentResult;
  task?: { id: string; text: string; expectReport: boolean };
}> {
  const task = typeof spec.task === "string" ? spec.task.trim() : "";
  if (!task) throw new Error("task must not be empty");
  let model = typeof spec.model === "string" ? spec.model.trim() : "";
  if (model && !validModelId(model))
    throw new Error(`invalid model "${model}" — letters, digits and . _ : / - only`);
  const effort =
    typeof spec.effort === "string" && spec.effort.trim()
      ? spec.effort.trim()
      : "medium"; // swarm default: sub-agents run medium unless chosen otherwise
  if (effort.toLowerCase() === "ultra")
    throw new Error(
      'effort "ultra" is unavailable in SwarmZ — Ultra is a multi-agent mode, not a single-agent reasoning level',
    );
  if (model) {
    const entry = validateCatalogModelEffort(catalog, model, effort);
    model = entry.model;
  }
  const access: VibeAccess = resolveAgentAccess(spec.access);
  const explicit =
    typeof spec.name === "string" ? sanitizeAgentName(spec.name) : "";
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
        // re-scan so a now-empty repo root is pruned from the registry again
        void useSwarm.getState().refreshWorktrees();
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
  // worktree placements get the workspace briefing prepended to the first
  // task — the agent must know it sits in a worktree, where the main repo
  // lives and that dependency dirs were not copied (briefing.ts)
  const text = withWorktreeBriefing(
    task,
    placement.worktree
      ? {
          worktreePath: placement.cwd,
          branch: placement.worktree.branch,
          mainRepoRoot: placement.worktree.root,
          shared: placement.worktree.shared,
        }
      : null,
  );
  return {
    result: {
      id,
      name: entry?.session.name ?? name,
      cwd: placement.cwd,
      branch: placement.worktree?.branch ?? null,
      shared: placement.worktree?.shared ?? false,
    },
    task: { id, text, expectReport: spec.expect_report === true },
  };
}

export const agentExecutors: ExecutorFamily<AgentTool> = {
  prompt_agent: async (args, ctx) => {
    const entry = requireSession(args.agent, ctx);
    // capability-reuse guard (TF5): a FULL-access session (danger-full-access,
    // approvalPolicy "never" — the sandbox bypassed) must never be driven by
    // the Conductor. The Conductor can only ever CREATE "workspace" agents
    // (resolveAgentAccess), so a full-access lane was elevated by a HUMAN for
    // direct use — reusing it via the Conductor (especially in an autonomous
    // turn) would launder full access through the swarm. The human's composer
    // / @session path is separate (vibe controller) and stays unaffected.
    if (entry.session.access === "full")
      throw new Error(
        `agent "${entry.session.name}" runs with FULL access (danger-full-access) — the Conductor cannot drive it. Ask the user to prompt it directly via the composer.`,
      );
    const text = String(args.text ?? "");
    if (!text) throw new Error("text must not be empty");
    return withLaneWriterClaim(entry, async () => {
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
    const expectationToken = expectReport ? noteReportExpected(id) : null;
    let how: { mode: "steered" | "queued"; turnId: string | null };
    try {
      // steerMessageStrict routes by state: busy → turn/steer (mid-flight
      // injection), idle → a fresh turn. Both STRICT — failures reject.
      how = await vibeSteerMessage(
        id,
        text,
        expectReport
          ? {
              via: "conductor",
              // Conductor path: Rust refuses a full-access session (the
              // capability-reuse guard, authoritative at the backend)
              requireWorkspace: true,
              outputSchema:
                AGENT_REPORT_SCHEMA as unknown as Record<string, unknown>,
              freshTurnText: text + REPORT_PROMPT_SUFFIX,
            }
          : { via: "conductor", requireWorkspace: true },
      );
    } catch (err) {
      if (expectationToken) clearReportExpectation(id, expectationToken);
      throw err;
    }
    if (expectationToken) {
      if (how.mode === "steered") clearReportExpectation(id, expectationToken);
      else bindReportExpectation(id, expectationToken, how.turnId);
    }
    notePromptDelivered(id, name, ctx);
    const result: PromptAgentResult = {
      delivered: true,
      agent: { id, name },
      mode: how.mode === "steered" ? "steered" : "turn",
    };
      return result;
    });
  },

  spawn_agents: async (args, ctx) => {
    const specs = args.agents as SpawnAgentSpec[];
    if (!Array.isArray(specs) || specs.length < 1 || specs.length > 8)
      throw new Error("agents must contain 1–8 entries");
    // Fail before worktree/session side effects. Several `none` entries all
    // resolve to the main checkout and cannot honestly start in parallel.
    assertSafeSpawnBatch(specs);
    const { id: projectId, dir: projectDir } = requireProject(ctx);
    if (specs.some((spec) => String(spec?.worktree ?? "").trim() === "none")) {
      const blocker = busyLaneBlocker(
        sessionsInPath(projectDir),
        projectDir,
        "",
        useVibe.getState().busy,
      );
      if (blocker) {
        throw new Error(
          `spawn batch refused before creating agents: the project checkout is busy with "${blocker.session.name}". Wait for that turn to finish or use worktree "new".`,
        );
      }
    }
    // Fetch once for the batch, before any worktree/session is created. Only
    // explicit overrides need strict validation; default-config spawns keep
    // working if model/list is temporarily unavailable.
    const needsCatalog = specs.some(
      (spec) => typeof spec.model === "string" && spec.model.trim().length > 0,
    );
    const catalog = needsCatalog ? await fetchCodexModelCatalog() : [];

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
          catalog,
        );
        results[i] = result;
        if (task) tasks.push({ index: i, ...task });
      } catch (e) {
        // the failure path stores the model-supplied name too — sanitize it
        // like the success path before it can reach any wire/UI surface
        const rawName = specs[i]?.name;
        results[i] = {
          error: e instanceof Error ? e.message : String(e),
          name: typeof rawName === "string" ? sanitizeAgentName(rawName) : null,
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
      const expectationToken = expectReport ? noteReportExpected(id) : null;
      try {
        // expect_report (Phase 5): the task turn is outputSchema-constrained
        // so the agent ends with a machine-readable status report. The
        // expectation registers BEFORE the send (a racing completion event
        // must not lose the parsing), binds to the acked turn id after, and
        // clears on a failed send (catch below).
        const entry = useVibe.getState().sessions[id];
        if (!entry) throw new Error("agent disappeared before its task could be delivered");
        const sent = await withLaneWriterClaim(entry, () => vibeSendMessage(
            id,
            expectReport ? text + REPORT_PROMPT_SUFFIX : text,
            expectReport
              ? {
                  via: "conductor",
                  requireWorkspace: true,
                  outputSchema:
                    AGENT_REPORT_SCHEMA as unknown as Record<string, unknown>,
                }
              : { via: "conductor", requireWorkspace: true },
          ));
        if (expectationToken) bindReportExpectation(id, expectationToken, sent.turnId);
        const result = results[index];
        if (result) {
          result.delivery = "started";
          result.turnId = sent.turnId;
        }
        notePromptDelivered(
          id,
          useVibe.getState().sessions[id]?.session.name ??
            results[index]?.name ??
            id,
          ctx,
        );
        return true;
      } catch (e) {
        if (typeof expectationToken === "string") clearReportExpectation(id, expectationToken);
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
      summary: spawnBatchSummary(results),
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
      let model =
        args.model === undefined
          ? entry.session.model
          : String(args.model).trim() || undefined;
      if (model && !validModelId(model))
        throw new Error(`invalid model "${model}"`);
      const effort =
        args.effort === undefined
          ? entry.session.effort
          : String(args.effort).trim() || undefined;
      if (effort?.toLowerCase() === "ultra")
        throw new Error(
          'effort "ultra" is unavailable in SwarmZ — Ultra is a multi-agent mode, not a single-agent reasoning level',
        );
      if (model) {
        const catalog = await fetchCodexModelCatalog();
        const catalogEntry = validateCatalogModelEffort(catalog, model, effort);
        model = catalogEntry.model;
      }
      await setVibeModelEffort(id, model, effort);
      if (args.model !== undefined) touched.push("model");
      if (args.effort !== undefined) touched.push("effort");
    }
    if (args.access !== undefined) {
      // the Conductor can only set "workspace" — "full" is human-only
      const access = resolveAgentAccess(args.access);
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
    // C3: the Conductor must not launder a HUMAN-granted full-access session
    // through a detached review — pass the strict flag (Rust's
    // `conductor_access_gate` is authoritative).
    const res = await reviewSession(entry.session.id, target, {
      requireWorkspace: true,
    });
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
    // TF5 defense-in-depth: even a "routine"-classified approval that performs
    // an OUTWARD GitHub write (push / PR / release) must NOT be accepted in an
    // AUTONOMOUS turn while the user has not opted into autonomous GitHub
    // actions — mirrors guardOutwardGithub for the direct-approval path (the
    // Rust classifier already marks such commands destructive; this is the
    // belt-and-braces twin). A human-triggered turn stays allowed.
    if (
      decision === "accept" &&
      isAutonomousTurnInFlight(ctx.chatId) &&
      useSwarm.getState().settings.autonomousGithubWrites !== true &&
      approvalLooksLikeGithubWrite(approval)
    )
      throw new Error(
        'refused: this approval performs an outward GitHub write (push / PR / release) and this is an AUTONOMOUS turn. Such writes stay with the user unless they enable Settings → "Autonomous GitHub actions". Leave it for the human to decide.',
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
};
