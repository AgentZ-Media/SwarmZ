import { useMemo, useState } from "react";
import { FlaskConical, ShieldCheck } from "lucide-react";
import { candidatesForBatch, selectCandidateAttempt } from "@/lib/missions/candidates";
import { flushMissionsPersist, useMissions } from "@/lib/missions/store";
import type { CandidateBatch, MissionTask, TaskAttempt } from "@/lib/missions/types";
import { cn } from "@/lib/utils";

export function CandidateAttemptsPanel({ taskId }: { taskId: string }) {
  const signature = useMissions((state) => {
    const task = state.projection.tasks[taskId];
    const batches = Object.values(state.projection.candidateBatches).filter((item) => item.taskId === taskId);
    const attempts = task?.attemptIds.map((id) => state.projection.attempts[id]) ?? [];
    const integration = Object.values(state.projection.integrationTrains)
      .flatMap((train) => train.entries.filter((entry) => entry.taskId === taskId)
        .map((entry) => `${train.id}:${train.status}:${entry.status}:${entry.commit ?? ""}`));
    return `${task?.status}:${task?.attemptIds.length}:${attempts.map((item) => `${item?.id}:${item?.status}:${item?.artifactIds.join(",")}`).join("|")}:${batches.map((item) => `${item.id}:${item.attemptIds.length}:${item.selectedAttemptId ?? ""}`).join("|")}:${integration.join("|")}`;
  });
  const snapshot = useMemo(() => readCandidateSnapshot(taskId), [taskId, signature]);
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(2);
  const [instruction, setInstruction] = useState("");
  const [extend, setExtend] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!snapshot) return null;
  const { task, batch, attempts } = snapshot;
  const alreadyIntegrated = Object.values(useMissions.getState().projection.integrationTrains)
    .some((train) => train.missionId === task.missionId &&
      train.entries.some((entry) => entry.taskId === task.id && entry.status === "integrated"));
  const openBatch = batch && !batch.selectedAttemptId ? batch : null;
  const displayedBatch = open && !openBatch ? null : batch;
  const canRequest = !alreadyIntegrated && ["ready", "failed", "blocked", "needs_human", "succeeded"].includes(task.status) && !openBatch;
  const needed = task.attemptIds.length + count;
  const needsExtension = needed > task.maxAttempts;

  const run = async (action: () => void) => {
    setError(null);
    try {
      action();
      await flushMissionsPersist();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  if (!displayedBatch && !open) {
    return canRequest ? (
      <button type="button" onClick={() => setOpen(true)} className="focus-ring mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-line2 py-2 text-11 text-mut hover:bg-pop hover:text-txt">
        <FlaskConical size={13} /> Compare 2–8 fresh candidates
      </button>
    ) : null;
  }

  if (!displayedBatch) {
    return (
      <div className="mt-2 rounded-md border border-acc/25 bg-acc/5 p-3">
        <div className="flex items-center gap-2"><FlaskConical size={13} className="text-acc" /><p className="text-11 font-semibold text-txt">Approve a controlled candidate run</p></div>
        <p className="mt-1 text-10 leading-normal text-fnt">Every candidate gets a fresh temporary worker, branch and worktree. SwarmZ waits for artifact-backed evidence before recommending a winner.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-[100px_1fr]">
          <label className="text-10 text-fnt">Candidates<select value={count} onChange={(event) => setCount(Number(event.target.value))} className="focus-ring mt-1 h-8 w-full rounded-md border border-line2 bg-card px-2 text-11 text-txt">{[2,3,4,5,6,7,8].map((value) => <option key={value}>{value}</option>)}</select></label>
          <label className="text-10 text-fnt">Comparison instruction<input value={instruction} onChange={(event) => setInstruction(event.target.value)} maxLength={4_000} placeholder="Explore materially different approaches…" className="focus-ring mt-1 h-8 w-full rounded-md border border-line2 bg-card px-2 text-11 text-txt placeholder:text-fnt" /></label>
        </div>
        {needsExtension && needed <= 20 && <label className="mt-2 flex items-start gap-2 text-10 text-attn"><input type="checkbox" checked={extend} onChange={(event) => setExtend(event.target.checked)} className="focus-ring mt-0.5 accent-[var(--acc)]" /><span>Explicitly extend this task’s attempt budget from {task.maxAttempts} to {needed}.</span></label>}
        {needed > 20 && <p className="mt-2 text-10 text-err">This would exceed the hard cap of 20 task attempts.</p>}
        {error && <p role="alert" className="mt-2 text-10 text-err">{error}</p>}
        <div className="mt-3 flex justify-end gap-2"><button type="button" onClick={() => setOpen(false)} className="focus-ring h-8 rounded-md px-3 text-11 text-mut hover:bg-card">Cancel</button><button type="button" disabled={instruction.trim().length < 2 || needed > 20 || (needsExtension && !extend)} onClick={() => void run(() => { useMissions.getState().requestCandidateBatch(task.missionId, task.id, { count, instruction: instruction.trim(), extendAttemptBudget: extend }); setOpen(false); })} className="focus-ring h-8 rounded-md bg-acc px-3 text-11 font-semibold text-bg disabled:opacity-40">Approve {count} candidates</button></div>
      </div>
    );
  }

  const terminal = attempts.length === displayedBatch.count && attempts.every((attempt) => attempt.status !== "running");
  const selection = terminal ? selectCandidateAttempt(candidatesForBatch(useMissions.getState().projection, displayedBatch), {
    minimumEvidenceCount: displayedBatch.minimumEvidenceCount,
    minimumScoreMargin: displayedBatch.minimumScoreMargin,
    tieBreakers: ["lower_tokens", "lower_duration", "attempt_id"],
  }) : null;
  return (
    <div className="mt-2 rounded-md border border-line2 bg-panel p-3">
      <div className="flex items-center gap-2"><FlaskConical size={13} className="text-acc" /><p className="text-11 font-semibold text-txt">Candidate run</p><span className="ml-auto font-mono text-10 text-fnt">{attempts.length}/{displayedBatch.count} launched</span></div>
      {displayedBatch.selectedAttemptId ? <><p className="mt-2 flex items-center gap-1.5 text-10 text-ok"><ShieldCheck size={12} /> Human-selected winner: {displayedBatch.selectedAttemptId}</p>{canRequest && <button type="button" onClick={() => setOpen(true)} className="focus-ring mt-2 h-7 w-full rounded-md border border-line2 text-10 text-mut hover:bg-card hover:text-txt"><FlaskConical size={11} className="mr-1 inline" />Compare another candidate batch</button>}</> : !terminal ? <p className="mt-2 text-10 text-fnt">Fresh workers are still launching or producing independent evidence.</p> : selection && <>
        <p className={cn("mt-2 text-10 leading-normal", selection.decision === "selected" ? "text-ok" : "text-attn")}>{selection.explanation}</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">{selection.assessments.map((assessment) => {
          const attempt = attempts.find((item) => item.id === assessment.attemptId)!;
          const recommended = selection.selectedAttemptId === assessment.attemptId;
          const canOverride = selection.decision !== "selected" && attempt.status === "succeeded" && assessment.passedEvidence > 0;
          return <div key={assessment.attemptId} className={cn("rounded-md border p-2", recommended ? "border-ok/35 bg-ok/5" : "border-line bg-card")}><div className="flex items-center gap-2"><span className="truncate font-mono text-10 text-txt">candidate {attempt.ordinal}</span><span className="ml-auto font-mono text-10 text-fnt">score {assessment.score}</span></div><p className="mt-1 text-10 text-fnt">{assessment.passedEvidence} evidence · {attempt.status}</p>{assessment.blockers.length > 0 && <p className="mt-1 break-words text-10 text-err">{assessment.blockers.join(" · ")}</p>}{recommended && <button type="button" onClick={() => void run(() => useMissions.getState().selectCandidate(task.missionId, displayedBatch.id, attempt.id))} className="focus-ring mt-2 h-7 w-full rounded-md bg-ok/15 text-10 font-semibold text-ok hover:bg-ok/20">Confirm evidence winner</button>}{canOverride && <button type="button" disabled={overrideReason.trim().length < 10} onClick={() => void run(() => useMissions.getState().overrideCandidate(task.missionId, displayedBatch.id, attempt.id, overrideReason.trim()))} className="focus-ring mt-2 h-7 w-full rounded-md border border-attn/35 text-10 font-medium text-attn disabled:opacity-35">Select with explicit override</button>}</div>;
        })}</div>
        {selection.decision !== "selected" && <label className="mt-2 block text-10 text-fnt">Required override rationale<textarea value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} maxLength={1_000} rows={2} placeholder="Explain why this candidate wins despite an ambiguous evidence margin…" className="focus-ring mt-1 w-full rounded-md border border-line2 bg-card px-2 py-1.5 text-10 text-txt placeholder:text-fnt" /></label>}
      </>}
      {error && <p role="alert" className="mt-2 text-10 text-err">{error}</p>}
    </div>
  );
}

function readCandidateSnapshot(taskId: string): { task: MissionTask; batch: CandidateBatch | null; attempts: TaskAttempt[] } | null {
  const projection = useMissions.getState().projection;
  const task = projection.tasks[taskId];
  if (!task) return null;
  const batch = Object.values(projection.candidateBatches).filter((item) => item.taskId === taskId).sort((left, right) => right.requestedAt - left.requestedAt)[0] ?? null;
  return { task, batch, attempts: batch ? batch.attemptIds.map((id) => projection.attempts[id]).filter((item): item is TaskAttempt => !!item) : [] };
}
