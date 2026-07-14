import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import {
  Archive,
  ChevronRight,
  CirclePause,
  ExternalLink,
  FileText,
  Play,
  X,
} from "lucide-react";
import { useMissions } from "@/lib/missions/store";
import type {
  MissionArtifact,
  MissionTask,
  QualityGate,
  TaskAttempt,
  TaskStatus,
} from "@/lib/missions/types";
import { openUrl } from "@/lib/transport";
import { focusSession } from "@/lib/vibe/controller";
import { useVibeUi } from "@/lib/vibe/ui-store";
import { cn } from "@/lib/utils";
import { CandidateAttemptsPanel } from "./CandidateAttemptsPanel";

export interface MissionTaskInspectorProps {
  className?: string;
}

interface InspectorSnapshot {
  task: MissionTask;
  missionTitle: string;
  missionArchived: boolean;
  dependencies: MissionTask[];
  attempts: TaskAttempt[];
  artifacts: MissionArtifact[];
  gates: QualityGate[];
}

/** Detailed, action-capable view of the task selected in the workspace UI. */
export function MissionTaskInspector({
  className,
}: MissionTaskInspectorProps) {
  const titleId = useId();
  const selectedTaskId = useVibeUi((state) => state.selectedMissionTaskId);
  const revisionSignature = useMissions((state) =>
    selectedTaskId ? inspectorSignature(state, selectedTaskId) : "",
  );
  const hydrateStatus = useMissions((state) => state.hydrateStatus);
  const hydrateError = useMissions((state) => state.hydrateError);
  const snapshot = useMemo(
    () => (selectedTaskId ? readSnapshot(selectedTaskId) : null),
    [selectedTaskId, revisionSignature],
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [retryInstruction, setRetryInstruction] = useState("");
  const [extendAttemptLimit, setExtendAttemptLimit] = useState(false);
  useEffect(() => {
    setActionError(null);
    setRetryInstruction("");
    setExtendAttemptLimit(false);
  }, [selectedTaskId]);

  if (hydrateStatus === "failed") {
    return (
      <aside
        aria-label="Mission task inspector"
        className={cn(
          "flex min-h-0 min-w-0 flex-col rounded-xl border border-err/35 bg-card p-4",
          className,
        )}
      >
        <p role="alert" className="text-12 font-medium text-err">
          Mission storage unavailable
        </p>
        <p className="mt-1 break-words text-11 leading-normal text-mut">
          {hydrateError || "The selected task cannot be loaded safely."}
        </p>
      </aside>
    );
  }

  if (!snapshot) {
    return (
      <aside
        aria-label="Mission task inspector"
        className={cn(
          "flex min-h-48 min-w-0 flex-col items-center justify-center rounded-xl border border-line bg-card px-6 py-8 text-center",
          className,
        )}
      >
        <FileText size={20} className="text-fnt" aria-hidden />
        <p className="mt-2 text-13 font-medium text-txt">Select a task</p>
        <p className="mt-1 max-w-[42ch] text-11 leading-normal text-mut">
          Choose a mission task to inspect its dependencies, acceptance
          criteria, attempts, evidence and quality gates.
        </p>
      </aside>
    );
  }

  const { task, missionTitle, missionArchived, dependencies, attempts, artifacts, gates } =
    snapshot;
  const canPause = !missionArchived && canPauseTask(task.status);
  const canResume = !missionArchived && task.status === "paused";
  const latestAttempt = attempts[attempts.length - 1] ?? null;
  const hasRunningAttempt = attempts.some((attempt) => attempt.status === "running");
  const canArchive = !missionArchived && task.status !== "archived" && !hasRunningAttempt;
  const canRequeue = !missionArchived && !!latestAttempt &&
    ["needs_human", "blocked", "failed", "cancelled"].includes(latestAttempt.status);
  const reportQuestion = latestAttempt?.report &&
    typeof latestAttempt.report.question === "string"
    ? latestAttempt.report.question
    : null;
  const attemptLimitExhausted = attempts.length >= task.maxAttempts;

  const runAction = (action: "pause" | "resume" | "archive") => {
    setActionError(null);
    try {
      const state = useMissions.getState();
      if (action === "pause") state.pauseTask(task.missionId, task.id);
      if (action === "resume") state.resumeTask(task.missionId, task.id);
      if (action === "archive") {
        state.archiveTask(task.missionId, task.id);
        useVibeUi.getState().setSelectedMissionTaskId(null);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  const requeueFreshAttempt = () => {
    setActionError(null);
    try {
      if (!latestAttempt || !canRequeue) throw new Error("This task is not waiting for a fresh attempt.");
      const instruction = retryInstruction.trim();
      if (instruction.length < 2) throw new Error("Add a concrete answer or correction for the next worker.");
      if (instruction.length > 4_000) throw new Error("Retry instructions must stay below 4,000 characters.");
      useMissions.getState().requeueTask(
        task.missionId,
        task.id,
        latestAttempt.id,
        instruction,
        { extendAttemptLimit: attemptLimitExhausted && extendAttemptLimit },
      );
      setRetryInstruction("");
      setExtendAttemptLimit(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <aside
      aria-labelledby={titleId}
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-card",
        className,
      )}
    >
      <header className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 font-mono text-10 text-fnt">
            <span className="truncate">{missionTitle}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">P{task.priority}</span>
          </div>
          <h2
            id={titleId}
            className="mt-1 break-words text-14 font-semibold tracking-[-0.01em] text-txt"
          >
            {task.title}
          </h2>
          {task.description && (
            <p className="mt-1 max-w-[72ch] break-words text-12 leading-normal text-mut">
              {task.description}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <StatusChip status={task.status} />
            <span className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-10 text-fnt">
              risk {task.risk}
            </span>
            {task.role && (
              <span className="max-w-full truncate rounded-sm border border-line px-1.5 py-0.5 font-mono text-10 text-fnt">
                {task.role}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => useVibeUi.getState().setSelectedMissionTaskId(null)}
          aria-label="Close task inspector"
          className="focus-ring flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fnt hover:bg-pop hover:text-txt"
        >
          <X size={15} aria-hidden />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className="grid min-w-0 gap-px bg-line"
          style={{
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 22rem), 1fr))",
          }}
        >
          <div className="min-w-0 bg-card p-4">
            <SectionTitle label="Assignment" count={null} />
            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-11">
              <dt className="font-mono text-fnt">root</dt>
              <dd className="select-text break-all font-mono text-mut" title={task.root.path}>
                {task.root.path}
              </dd>
              <dt className="font-mono text-fnt">worktree</dt>
              <dd className="break-all font-mono text-mut">{worktreeLabel(task)}</dd>
              <dt className="font-mono text-fnt">attempts</dt>
              <dd className="font-mono tabular-nums text-mut">
                {attempts.length} / {task.maxAttempts}
              </dd>
              {(task.declaredFiles.length > 0 || task.declaredGlobs.length > 0) && (
                <>
                  <dt className="font-mono text-fnt">scope</dt>
                  <dd className="min-w-0 space-y-1 font-mono text-10 text-mut">
                    {[...task.declaredFiles, ...task.declaredGlobs].map((path) => (
                      <div key={path} className="select-text truncate" title={path}>
                        {path}
                      </div>
                    ))}
                  </dd>
                </>
              )}
            </dl>
          </div>

          <div className="min-w-0 bg-card p-4">
            <SectionTitle label="Dependencies" count={dependencies.length} />
            {dependencies.length === 0 ? (
              <EmptyLine>No upstream tasks.</EmptyLine>
            ) : (
              <div className="mt-2 space-y-1">
                {dependencies.map((dependency) => (
                  <button
                    key={dependency.id}
                    type="button"
                    onClick={() =>
                      useVibeUi.getState().setSelectedMissionTaskId(dependency.id)
                    }
                    className="focus-ring group flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-pop"
                  >
                    <StatusDot status={dependency.status} />
                    <span className="min-w-0 flex-1 truncate text-11 text-mut">
                      {dependency.title}
                    </span>
                    <ChevronRight
                      size={12}
                      aria-hidden
                      className="shrink-0 text-fnt group-hover:text-mut"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <InspectorSection>
          <SectionTitle
            label="Acceptance criteria"
            count={task.acceptanceCriteria.length}
          />
          {task.acceptanceCriteria.length === 0 ? (
            <EmptyLine>No explicit acceptance criteria.</EmptyLine>
          ) : (
            <ul className="mt-2 space-y-2">
              {task.acceptanceCriteria.map((criterion, index) => (
                <li key={`${index}:${criterion}`} className="flex gap-2 text-12 leading-normal text-mut">
                  <span aria-hidden className="mt-0.5 font-mono text-fnt">
                    ·
                  </span>
                  <span className="select-text break-words">{criterion}</span>
                </li>
              ))}
            </ul>
          )}
        </InspectorSection>

        <InspectorSection>
          <SectionTitle label="Attempts" count={attempts.length} />
          {attempts.length === 0 ? (
            <EmptyLine>No worker attempt has started.</EmptyLine>
          ) : (
            <div className="mt-2 divide-y divide-line">
              {[...attempts].reverse().map((attempt) => (
                <AttemptRow key={attempt.id} attempt={attempt} />
              ))}
            </div>
          )}
          {!missionArchived && <CandidateAttemptsPanel taskId={task.id} />}
        </InspectorSection>

        <div
          className="grid min-w-0 gap-px bg-line"
          style={{
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 22rem), 1fr))",
          }}
        >
          <div className="min-w-0 bg-card p-4">
            <SectionTitle label="Evidence" count={artifacts.length} />
            {artifacts.length === 0 ? (
              <EmptyLine>No evidence recorded.</EmptyLine>
            ) : (
              <div className="mt-2 space-y-1">
                {artifacts.map((artifact) => (
                  <ArtifactRow key={artifact.id} artifact={artifact} />
                ))}
              </div>
            )}
          </div>

          <div className="min-w-0 bg-card p-4">
            <SectionTitle label="Quality gates" count={gates.length} />
            {gates.length === 0 ? (
              <EmptyLine>No gates configured.</EmptyLine>
            ) : (
              <div className="mt-2 space-y-2">
                {gates.map((gate) => (
                  <GateRow key={gate.id} gate={gate} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <footer className="border-t border-line bg-panel px-4 py-3">
        {canRequeue && (
          <div className="mb-3 rounded-md border border-attn/30 bg-attn/5 p-3">
            <p className="text-11 font-semibold text-txt">Answer and start a fresh worker</p>
            <p className="mt-1 text-10 leading-normal text-fnt">
              {reportQuestion || latestAttempt?.summary || "The previous attempt needs a human correction before work can continue."}
            </p>
            <div className="mt-2 flex items-end gap-2">
              <label className="min-w-0 flex-1 text-10 text-fnt">
                Human instruction
                <textarea
                  value={retryInstruction}
                  onChange={(event) => setRetryInstruction(event.target.value)}
                  rows={2}
                  maxLength={4_000}
                  placeholder="Give the decision, missing context or corrected constraint…"
                  className="focus-ring mt-1 w-full resize-y rounded-md border border-line2 bg-card px-2.5 py-2 text-11 leading-normal text-txt placeholder:text-fnt"
                />
              </label>
              <button type="button" onClick={requeueFreshAttempt} disabled={retryInstruction.trim().length < 2 || (attemptLimitExhausted && (!extendAttemptLimit || task.maxAttempts >= 20))} className="focus-ring h-8 shrink-0 rounded-md bg-acc px-3 text-11 font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">
                Approve fresh retry
              </button>
            </div>
            {attemptLimitExhausted && task.maxAttempts < 20 && (
              <label className="mt-2 flex items-start gap-2 text-10 leading-normal text-attn">
                <input type="checkbox" checked={extendAttemptLimit} onChange={(event) => setExtendAttemptLimit(event.target.checked)} className="focus-ring mt-0.5 accent-[var(--acc)]" />
                <span>Attempt limit reached. Approve exactly one additional attempt ({task.maxAttempts} → {task.maxAttempts + 1}, hard cap 20).</span>
              </label>
            )}
            {attemptLimitExhausted && task.maxAttempts >= 20 && <p className="mt-2 text-10 text-err">The hard cap of 20 attempts is exhausted. Split or rewrite the task instead of retrying it again.</p>}
            <p className="mt-1.5 text-10 text-fnt">This creates a new approved mission revision. The previous worker is never resumed.</p>
          </div>
        )}
        {actionError && (
          <p role="alert" className="mb-2 break-words text-11 text-err">
            {actionError}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {missionArchived && <span className="mr-auto rounded-sm border border-line px-2 py-1 font-mono text-10 uppercase text-fnt">read-only archive</span>}
          <button
            type="button"
            onClick={() => runAction("pause")}
            disabled={!canPause}
            title={canPause ? "Pause this task" : "This task cannot be paused"}
            className="focus-ring flex h-8 items-center gap-1.5 rounded-md border border-line2 px-3 text-11 font-medium text-mut hover:bg-card hover:text-txt disabled:cursor-not-allowed disabled:opacity-35"
          >
            <CirclePause size={13} aria-hidden /> Pause
          </button>
          <button
            type="button"
            onClick={() => runAction("resume")}
            disabled={!canResume}
            title={canResume ? "Resume this task" : "Only paused tasks can resume"}
            className="focus-ring flex h-8 items-center gap-1.5 rounded-md border border-line2 px-3 text-11 font-medium text-mut hover:bg-card hover:text-txt disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Play size={12} aria-hidden /> Resume
          </button>
          <button
            type="button"
            onClick={() => runAction("archive")}
            disabled={!canArchive}
            title={
              hasRunningAttempt
                ? "Pause the running task and wait for its worker to stop before archiving"
                : "Archive this task"
            }
            className="focus-ring flex h-8 items-center gap-1.5 rounded-md border border-line2 px-3 text-11 font-medium text-mut hover:border-err/40 hover:bg-err/10 hover:text-err disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Archive size={13} aria-hidden /> Archive
          </button>
        </div>
      </footer>
    </aside>
  );
}

function AttemptRow({ attempt }: { attempt: TaskAttempt }) {
  const reportLines = scalarReportLines(attempt.report);
  return (
    <div className="py-3 first:pt-1 last:pb-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-mono text-11 tabular-nums text-txt">
          attempt {attempt.ordinal}
        </span>
        <AttemptStatus status={attempt.status} />
        {attempt.workerLabel && (
          <span className="min-w-0 truncate font-mono text-10 text-fnt">
            {attempt.workerLabel}
          </span>
        )}
        {attempt.sessionId && (
          <button
            type="button"
            onClick={() => focusSession(attempt.sessionId!)}
            className="focus-ring ml-auto flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-10 text-acc hover:bg-acc/10"
          >
            Open worker <ExternalLink size={10} aria-hidden />
          </button>
        )}
      </div>
      {(attempt.summary || attempt.error) && (
        <p
          className={cn(
            "mt-1.5 select-text break-words text-11 leading-normal",
            attempt.error ? "text-err" : "text-mut",
          )}
        >
          {attempt.error || attempt.summary}
        </p>
      )}
      {reportLines.length > 0 && (
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-md bg-panel px-2 py-1.5 font-mono text-10">
          {reportLines.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-fnt">{label}</dt>
              <dd className="select-text truncate text-mut" title={value}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function ArtifactRow({ artifact }: { artifact: MissionArtifact }) {
  const external = !!artifact.uri && /^https?:\/\//i.test(artifact.uri);
  const content = (
    <>
      <FileText size={12} className="shrink-0 text-fnt" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-11 text-mut">
        {artifact.label}
      </span>
      <span className="shrink-0 font-mono text-10 text-fnt">{artifact.kind}</span>
      {external && <ExternalLink size={10} className="shrink-0 text-fnt" aria-hidden />}
    </>
  );
  if (external) {
    return (
      <button
        type="button"
        onClick={() => void openUrl(artifact.uri!)}
        className="focus-ring flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-pop"
        title={artifact.uri ?? undefined}
      >
        {content}
      </button>
    );
  }
  return (
    <div
      className="flex min-w-0 items-center gap-2 px-2 py-1.5"
      title={artifact.uri ?? artifact.label}
    >
      {content}
    </div>
  );
}

function GateRow({ gate }: { gate: QualityGate }) {
  return (
    <div className="rounded-md bg-panel px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <GateGlyph gate={gate} />
        <span className="min-w-0 flex-1 truncate text-11 text-txt">
          {gate.label}
        </span>
        {gate.required && (
          <span className="font-mono text-10 text-fnt">required</span>
        )}
      </div>
      {gate.details && (
        <p className="mt-1 select-text break-words text-10 leading-normal text-mut">
          {gate.details}
        </p>
      )}
      {gate.command && (
        <code className="mt-1 block select-text truncate font-mono text-10 text-fnt" title={gate.command}>
          {gate.command}
        </code>
      )}
    </div>
  );
}

function GateGlyph({ gate }: { gate: QualityGate }) {
  const className = cn(
    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full font-mono text-10",
    gate.status === "passed" && "bg-ok/15 text-ok",
    gate.status === "failed" && "bg-err/15 text-err",
    (gate.status === "pending" || gate.status === "running") &&
      "bg-warn/15 text-warn",
    gate.status === "waived" && "bg-line2 text-fnt",
  );
  return (
    <span className={className} title={gate.status} aria-label={gate.status}>
      {gate.status === "passed"
        ? "✓"
        : gate.status === "failed"
          ? "×"
          : gate.status === "running"
            ? "▸"
            : "·"}
    </span>
  );
}

function SectionTitle({ label, count }: { label: string; count: number | null }) {
  return (
    <h3 className="flex items-center gap-2 font-mono text-11 font-medium text-mut">
      <span>{label}</span>
      {count !== null && (
        <span className="rounded-sm bg-panel px-1.5 py-0.5 tabular-nums text-fnt">
          {count}
        </span>
      )}
    </h3>
  );
}

function InspectorSection({ children }: { children: ReactNode }) {
  return <section className="border-t border-line p-4">{children}</section>;
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-11 text-fnt">{children}</p>;
}

function StatusChip({ status }: { status: TaskStatus }) {
  const tone = taskStatusTone(status);
  return (
    <span
      className={cn(
        "rounded-sm px-1.5 py-0.5 font-mono text-10",
        tone === "attention" && "bg-attn/10 text-attn",
        tone === "error" && "bg-err/10 text-err",
        tone === "warning" && "bg-warn/10 text-warn",
        tone === "ok" && "bg-ok/10 text-ok",
        tone === "active" && "bg-acc/10 text-acc",
        tone === "neutral" && "border border-line text-fnt",
      )}
    >
      {humanizeStatus(status)}
    </span>
  );
}

function StatusDot({ status }: { status: TaskStatus }) {
  const tone = taskStatusTone(status);
  return (
    <span
      aria-label={humanizeStatus(status)}
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        tone === "attention" && "bg-attn",
        tone === "error" && "bg-err",
        tone === "warning" && "bg-warn",
        tone === "ok" && "bg-ok",
        tone === "active" && "bg-acc",
        tone === "neutral" && "bg-fnt",
      )}
    />
  );
}

function AttemptStatus({ status }: { status: TaskAttempt["status"] }) {
  const cls =
    status === "succeeded"
      ? "text-ok"
      : status === "failed"
        ? "text-err"
        : status === "needs_human"
          ? "text-attn"
          : status === "running"
            ? "text-acc"
            : status === "blocked"
              ? "text-warn"
              : "text-fnt";
  return (
    <span className={cn("font-mono text-10", cls)}>
      {humanizeStatus(status)}
    </span>
  );
}

function taskStatusTone(
  status: TaskStatus,
): "attention" | "error" | "warning" | "ok" | "active" | "neutral" {
  if (status === "needs_human") return "attention";
  if (status === "failed") return "error";
  if (status === "blocked") return "warning";
  if (status === "succeeded") return "ok";
  if (status === "running" || status === "ready") return "active";
  return "neutral";
}

function humanizeStatus(status: string): string {
  return status.split("_").join(" ");
}

function canPauseTask(status: TaskStatus): boolean {
  return ![
    "paused",
    "succeeded",
    "failed",
    "cancelled",
    "archived",
  ].includes(status);
}

function worktreeLabel(task: MissionTask): string {
  const policy = task.worktreePolicy;
  if (policy.mode === "shared") return `shared with ${policy.sharedWithTaskId}`;
  return policy.mode;
}

function scalarReportLines(
  report: Record<string, unknown> | null,
): Array<[string, string]> {
  if (!report) return [];
  const preferred = ["status", "summary", "tests", "question"];
  const keys = [
    ...preferred.filter((key) => key in report),
    ...Object.keys(report).filter((key) => !preferred.includes(key)),
  ];
  const lines: Array<[string, string]> = [];
  for (const key of keys) {
    const value = report[key];
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      continue;
    }
    lines.push([key, String(value)]);
    if (lines.length === 5) break;
  }
  return lines;
}

function inspectorSignature(
  state: ReturnType<typeof useMissions.getState>,
  taskId: string,
): string {
  const task = state.projection.tasks[taskId];
  if (!task) return "missing";
  const missionStatus = state.projection.missions[task.missionId]?.status ?? "missing";
  const dependencies = task.dependencyIds
    .map((id) => state.projection.tasks[id])
    .filter((item): item is MissionTask => !!item)
    .map((item) => `${item.id}:${item.status}:${item.updatedAt}`)
    .join(",");
  const attempts = task.attemptIds
    .map((id) => state.projection.attempts[id])
    .filter((item): item is TaskAttempt => !!item)
    .map(
      (item) =>
        `${item.id}:${item.status}:${item.finishedAt ?? ""}:${item.artifactIds.join(",")}`,
    )
    .join("|");
  const gates = task.qualityGateIds
    .map((id) => state.projection.qualityGates[id])
    .filter((item): item is QualityGate => !!item)
    .map((item) => `${item.id}:${item.status}:${item.updatedAt}`)
    .join("|");
  return `${missionStatus}:${task.id}:${task.status}:${task.updatedAt}:${task.artifactIds.join(",")}:${dependencies}:${attempts}:${gates}`;
}

function readSnapshot(taskId: string): InspectorSnapshot | null {
  const projection = useMissions.getState().projection;
  const task = projection.tasks[taskId];
  if (!task) return null;
  const attempts = task.attemptIds
    .map((id) => projection.attempts[id])
    .filter((item): item is TaskAttempt => !!item);
  const artifactIds = new Set(task.artifactIds);
  for (const attempt of attempts) {
    for (const id of attempt.artifactIds) artifactIds.add(id);
  }
  return {
    task,
    missionTitle: projection.missions[task.missionId]?.title ?? "Unknown mission",
    missionArchived: projection.missions[task.missionId]?.status === "archived",
    dependencies: task.dependencyIds
      .map((id) => projection.tasks[id])
      .filter((item): item is MissionTask => !!item),
    attempts,
    artifacts: [...artifactIds]
      .map((id) => projection.artifacts[id])
      .filter((item): item is MissionArtifact => !!item),
    gates: task.qualityGateIds
      .map((id) => projection.qualityGates[id])
      .filter((item): item is QualityGate => !!item),
  };
}
