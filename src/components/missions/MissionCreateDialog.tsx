import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, FileInput, X } from "lucide-react";
import { nanoid } from "nanoid";
import { importTasks } from "@/lib/intake/task-import";
import { useMissions } from "@/lib/missions/store";
import type { MissionRisk } from "@/lib/missions/types";
import { useProjects } from "@/lib/projects/store";
import { useVibeUi } from "@/lib/vibe/ui-store";
import { BUILTIN_PLAYBOOKS } from "@/lib/playbooks/builtins";
import { expandPlaybook } from "@/lib/playbooks";

const EXAMPLE = `[AUTH] Fix authentication race P0 @security
  Done when: concurrent refresh requests share one token exchange
- Add regression coverage P1 @tester depends: AUTH
- Update the operator documentation P2 @writer depends: AUTH`;

function riskFor(priority: number): MissionRisk {
  if (priority >= 95) return "critical";
  if (priority >= 75) return "high";
  if (priority >= 40) return "medium";
  return "low";
}

export function MissionCreateDialog() {
  const open = useVibeUi((state) => state.missionCreateOpen);
  const close = () => useVibeUi.getState().setMissionCreateOpen(false);
  const activeProjectId = useProjects((state) => state.activeProjectId);
  const hydrateStatus = useMissions((state) => state.hydrateStatus);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [input, setInput] = useState(EXAMPLE);
  const [parallel, setParallel] = useState(4);
  // Autonomous Mission workers always use the workspace sandbox. Network and
  // GitHub writes remain human/native-gated instead of being advertised as an
  // unenforced grant.
  const networkAuthority = "deny" as const;
  const githubAuthority = "deny" as const;
  const [qualityCommands, setQualityCommands] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [maxMinutes, setMaxMinutes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => importTasks(input), [input]);

  const applyPlaybook = (playbookId: string) => {
    if (!playbookId) return;
    const playbook = BUILTIN_PLAYBOOKS.find((item) => item.id === playbookId);
    const project = activeProjectId ? useProjects.getState().projects[activeProjectId] : null;
    if (!playbook || !project) return;
    const subject = title.trim() || project.name;
    const command = qualityCommands.split(/\r?\n/).map((item) => item.trim()).find(Boolean) || "pnpm test";
    const availableValues: Record<string, unknown> = {
      root: project.dir,
      release_name: subject,
      feature_name: subject,
      backlog_name: subject,
      verification_command: command,
      quality_command: command,
    };
    const values = Object.fromEntries(
      playbook.parameters
        .filter((parameter) => parameter.name in availableValues)
        .map((parameter) => [parameter.name, availableValues[parameter.name]]),
    );
    try {
      const expanded = expandPlaybook(playbook, values);
      setInput(JSON.stringify({ tasks: expanded.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        description: `${task.description}\n\nRole briefing: ${task.briefing}`,
        role: task.role,
        dependencies: task.dependencyIds,
        acceptanceCriteria: task.acceptanceCriteria,
      })) }, null, 2));
      if (!title.trim()) setTitle(playbook.title);
      if (!objective.trim()) setObjective(playbook.description);
      if (!qualityCommands.trim()) setQualityCommands(command);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => titleRef.current?.focus(), 0);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!open) return null;

  const create = () => {
    try {
      if (!activeProjectId) throw new Error("Open a project before creating a mission.");
      if (!title.trim()) throw new Error("Give the mission a clear title.");
      if (!objective.trim()) throw new Error("Describe the outcome the Orchestrator should achieve.");
      if (parsed.tasks.length === 0) throw new Error("Add at least one task.");
      if (hydrateStatus !== "ready") throw new Error("Mission storage is not ready yet.");

      const project = useProjects.getState().projects[activeProjectId];
      if (!project) throw new Error("The active project is no longer available.");
      const store = useMissions.getState();
      const commands = qualityCommands.split(/\r?\n/).map((command) => command.trim()).filter(Boolean);
      if (commands.length > 20 || commands.some((command) => command.length > 1_000)) {
        throw new Error("Use at most 20 verification commands, each below 1,000 characters.");
      }
      const tokenBudget = maxTokens.trim() ? Number(maxTokens) : null;
      const minuteBudget = maxMinutes.trim() ? Number(maxMinutes) : null;
      if (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1)) throw new Error("Token budget must be a positive integer.");
      if (minuteBudget !== null && (!Number.isFinite(minuteBudget) || minuteBudget <= 0)) throw new Error("Time budget must be positive.");
      const missionId = store.createMission({
        projectId: activeProjectId,
        title: title.trim(),
        objective: objective.trim(),
        policy: {
          maxParallelAttempts: parallel,
          networkAuthority,
          githubAuthority,
          qualityCommands: commands,
          allowedTools: ["workspace_sandbox"],
        },
        budget: { maxTokens: tokenBudget, maxActiveMinutes: minuteBudget },
      });
      const ids = parsed.tasks.map(() => nanoid(12));
      const referenceMap = new Map<string, string>();
      const availableProjects = Object.values(useProjects.getState().projects);
      const rootFor = (labels: string[]) => {
        const reference = labels.find((label) => label.toLowerCase().startsWith("root:"))?.slice(5).trim();
        if (!reference) return project;
        const normalized = reference.toLowerCase();
        const match = availableProjects.find((candidate) =>
          candidate.id.toLowerCase() === normalized ||
          candidate.name.toLowerCase() === normalized ||
          candidate.dir.toLowerCase() === normalized ||
          candidate.dir.split("/").filter(Boolean).pop()?.toLowerCase() === normalized,
        );
        if (!match) throw new Error(`Unknown mission root: ${reference}. Open that project first.`);
        return match;
      };
      parsed.tasks.forEach((task, index) => {
        if (task.externalId) referenceMap.set(task.externalId.toLowerCase(), ids[index]);
        referenceMap.set(task.title.toLowerCase(), ids[index]);
      });
      const unresolved = [...new Set(parsed.tasks.flatMap((task) =>
        task.dependencyRefs.filter((reference) => !referenceMap.has(reference.toLowerCase())),
      ))];
      if (unresolved.length) {
        throw new Error(`Unknown task dependencies: ${unresolved.slice(0, 5).join(", ")}`);
      }
      store.addTasks(
        missionId,
        parsed.tasks.map((task, index) => {
          const root = rootFor(task.labels);
          return ({
          id: ids[index],
          title: task.title,
          description: task.description,
          priority: task.priority,
          role: task.role,
          risk: riskFor(task.priority),
          acceptanceCriteria: task.acceptanceCriteria,
          root: { projectId: root.id, path: root.dir },
          worktreePolicy: { mode: "new" as const },
          dependencyIds: task.dependencyRefs
            .map((reference) => referenceMap.get(reference.toLowerCase()))
            .filter((id): id is string => !!id),
          declaredFiles: [],
          declaredGlobs: [],
          maxAttempts: 3,
          });
        }),
      );
      store.activateMission(missionId);
      useVibeUi.getState().setSelectedMissionId(missionId);
      useVibeUi.getState().setWorkspaceView("board");
      close();
      setTitle("");
      setObjective("");
      setQualityCommands("");
      setMaxTokens("");
      setMaxMinutes("");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-mission-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="flex max-h-[min(860px,92vh)] w-[min(920px,96vw)] flex-col overflow-hidden rounded-xl border border-line2 bg-panel shadow-2xl">
        <div className="flex h-14 shrink-0 items-center border-b border-line px-5">
          <div>
            <h2 id="create-mission-title" className="text-15 font-semibold text-txt">New mission</h2>
            <p className="mt-0.5 text-11 text-fnt">Import up to 500 tasks; dependencies become a schedulable DAG.</p>
          </div>
          <button onClick={close} aria-label="Close" className="focus-ring ml-auto flex h-8 w-8 items-center justify-center rounded-md text-mut hover:bg-card hover:text-txt">
            <X size={15} />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto p-5 md:grid-cols-[minmax(0,1fr)_280px]">
          <div className="space-y-4">
            <label className="block text-11 font-medium uppercase tracking-[0.08em] text-fnt">
              Start from a playbook
              <select defaultValue="" onChange={(event) => applyPlaybook(event.target.value)} className="focus-ring mt-1.5 h-10 w-full rounded-md border border-line2 bg-card px-3 text-12 normal-case tracking-normal text-txt">
                <option value="">Custom mission</option>
                {BUILTIN_PLAYBOOKS.map((playbook) => <option key={playbook.id} value={playbook.id}>{playbook.title} · v{playbook.version}</option>)}
              </select>
            </label>
            <label className="block text-11 font-medium uppercase tracking-[0.08em] text-fnt">
              Mission title
              <input ref={titleRef} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="Ship the production-ready release" className="focus-ring mt-1.5 h-10 w-full rounded-md border border-line2 bg-card px-3 text-13 normal-case tracking-normal text-txt placeholder:text-fnt" />
            </label>
            <label className="block text-11 font-medium uppercase tracking-[0.08em] text-fnt">
              Outcome
              <textarea value={objective} onChange={(event) => setObjective(event.target.value)} maxLength={3000} rows={3} placeholder="What must be true when this mission is complete?" className="focus-ring mt-1.5 w-full resize-y rounded-md border border-line2 bg-card px-3 py-2 text-13 normal-case leading-relaxed tracking-normal text-txt placeholder:text-fnt" />
            </label>
            <label className="block text-11 font-medium uppercase tracking-[0.08em] text-fnt">
              Task list · Markdown, plain text, CSV or JSON
              <textarea value={input} onChange={(event) => setInput(event.target.value)} rows={12} spellCheck={false} className="focus-ring mt-1.5 w-full resize-y rounded-md border border-line2 bg-bg px-3 py-2 font-mono text-12 normal-case leading-relaxed tracking-normal text-txt" />
            </label>
          </div>

          <aside className="space-y-4">
            <div className="border-b border-line pb-4">
              <div className="flex items-center gap-2 text-12 font-semibold text-txt"><FileInput size={14} className="text-acc" /> Intake preview</div>
              <div className="mt-3 flex items-baseline gap-2"><span className="font-mono text-24 font-semibold text-txt">{parsed.tasks.length}</span><span className="text-12 text-mut">tasks · {parsed.source}</span></div>
              <p className="mt-1 font-mono text-10 text-fnt">Use label <span className="text-mut">root:project-name</span> in JSON/CSV for multi-root work.</p>
              <div className="mt-2 max-h-36 overflow-y-auto text-11 leading-relaxed text-fnt">
                {parsed.tasks.slice(0, 8).map((task, index) => <div key={`${task.title}-${index}`} className="truncate py-0.5"><span className="mr-1.5 font-mono text-acc">{index + 1}</span>{task.title}</div>)}
                {parsed.tasks.length > 8 && <div className="pt-1 text-mut">+ {parsed.tasks.length - 8} more</div>}
              </div>
            </div>
            <label className="block text-11 font-medium uppercase tracking-[0.08em] text-fnt">
              Parallel workers <span className="ml-1 font-mono text-txt">{parallel}</span>
              <input type="range" min={1} max={8} value={parallel} onChange={(event) => setParallel(Number(event.target.value))} className="focus-ring mt-2 w-full accent-[var(--acc)]" />
            </label>
            <div className="border-t border-line pt-4">
              <p className="text-11 font-medium uppercase tracking-[0.08em] text-fnt">Execution envelope</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="text-10 text-fnt">Worker network<select value={networkAuthority} disabled className="mt-1 h-8 w-full cursor-not-allowed rounded-md border border-line2 bg-card px-2 font-mono text-10 text-fnt"><option value="deny">Sandbox denied</option></select></label>
                <label className="text-10 text-fnt">Worker GitHub<select value={githubAuthority} disabled className="mt-1 h-8 w-full cursor-not-allowed rounded-md border border-line2 bg-card px-2 font-mono text-10 text-fnt"><option value="deny">Native gate only</option></select></label>
                <label className="text-10 text-fnt">Token cap<input value={maxTokens} onChange={(event) => setMaxTokens(event.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="unlimited" className="focus-ring mt-1 h-8 w-full rounded-md border border-line2 bg-card px-2 font-mono text-10 text-txt placeholder:text-fnt" /></label>
                <label className="text-10 text-fnt">Active minutes<input value={maxMinutes} onChange={(event) => setMaxMinutes(event.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="unlimited" className="focus-ring mt-1 h-8 w-full rounded-md border border-line2 bg-card px-2 font-mono text-10 text-txt placeholder:text-fnt" /></label>
              </div>
              <label className="mt-3 block text-10 text-fnt">Independent verification commands<textarea value={qualityCommands} onChange={(event) => setQualityCommands(event.target.value)} rows={3} placeholder={"pnpm test\npnpm build"} className="focus-ring mt-1 w-full resize-y rounded-md border border-line2 bg-card px-2 py-1.5 font-mono text-10 leading-relaxed text-txt placeholder:text-fnt" /></label>
              <p className="mt-2 text-10 leading-normal text-fnt">Autonomous lanes never receive ambient credentials. GitHub mutations stay behind SwarmZ&apos;s native human approval gate.</p>
            </div>
            <p className="text-11 leading-relaxed text-fnt">The scheduler also respects global limits, dependencies, file locks, budgets and quality gates. Workers are temporary execution lanes; only the Orchestrator keeps memory.</p>
            {parsed.warnings.map((warning) => <p key={warning} className="flex gap-2 text-11 leading-relaxed text-attn"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{warning}</p>)}
          </aside>
        </div>

        <div className="flex shrink-0 items-center gap-3 border-t border-line px-5 py-3">
          {error && <p role="alert" className="mr-auto text-11 text-err">{error}</p>}
          {!error && <p className="mr-auto text-11 text-fnt">Your click approves exactly this scope and envelope revision.</p>}
          <button onClick={close} className="focus-ring h-8 rounded-md px-3 text-12 text-mut hover:bg-card hover:text-txt">Cancel</button>
          <button onClick={create} disabled={!activeProjectId || parsed.tasks.length === 0 || hydrateStatus !== "ready"} className="focus-ring h-8 rounded-md bg-acc px-4 text-12 font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">Approve &amp; start</button>
        </div>
      </div>
    </div>
  );
}
