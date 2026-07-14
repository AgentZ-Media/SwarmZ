import { useMemo, useState } from "react";
import {
  Check,
  CircleAlert,
  GitCommitHorizontal,
  GitMerge,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  SkipForward,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  retryIntegrationTrainEntry,
  rollbackIntegrationTrain,
  skipIntegrationTrainEntry,
} from "@/lib/integration/controller";
import { checkpointFromArtifact } from "@/lib/integration/controller-support";
import type { IntegrationCheckpoint } from "@/lib/integration/types";
import { useMissions } from "@/lib/missions/store";
import type { IntegrationTrain, MissionTask, QualityGate } from "@/lib/missions/types";
import { cn } from "@/lib/utils";

type HumanAction =
  | { kind: "retry" | "skip"; train: IntegrationTrain; taskId: string }
  | { kind: "rollback"; train: IntegrationTrain };

function approvalId(kind: HumanAction["kind"]): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `integration-${kind}-${Date.now()}-${random}`;
}

export function MissionIntegrationView({ missionId }: { missionId: string }) {
  const [action, setAction] = useState<HumanAction | null>(null);
  const [reason, setReason] = useState("");
  const [checkpointId, setCheckpointId] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signature = useMissions((state) => {
    const mission = state.projection.missions[missionId];
    if (!mission) return "";
    const trains = mission.integrationTrainIds.map((id) => {
      const train = state.projection.integrationTrains[id];
      return train ? `${id}:${train.status}:${train.updatedAt}` : id;
    });
    const gates = Object.values(state.projection.qualityGates)
      .filter((gate) => gate.missionId === missionId)
      .map((gate) => `${gate.id}:${gate.status}:${gate.updatedAt}`);
    const checkpoints = Object.values(state.projection.artifacts)
      .filter((artifact) => artifact.missionId === missionId && artifact.label === "integration-checkpoint")
      .map((artifact) => `${artifact.id}:${artifact.createdAt}`);
    return [...trains, ...gates, ...checkpoints].join("|");
  });
  const { trains, gates, tasks, checkpointsByTrain } = useMemo(() => {
    const projection = useMissions.getState().projection;
    const mission = projection.missions[missionId];
    const checkpoints = Object.values(projection.artifacts)
      .map(checkpointFromArtifact)
      .filter((checkpoint): checkpoint is IntegrationCheckpoint => checkpoint !== null)
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
    const checkpointsByTrain = new Map<string, IntegrationCheckpoint[]>();
    for (const checkpoint of checkpoints) {
      const values = checkpointsByTrain.get(checkpoint.trainId) ?? [];
      values.push(checkpoint);
      checkpointsByTrain.set(checkpoint.trainId, values);
    }
    return {
      trains: (mission?.integrationTrainIds ?? [])
        .map((id) => projection.integrationTrains[id])
        .filter((train): train is IntegrationTrain => Boolean(train)),
      gates: Object.values(projection.qualityGates).filter((gate) => gate.missionId === missionId),
      tasks: projection.tasks,
      checkpointsByTrain,
    };
  }, [missionId, signature]);

  const openAction = (next: HumanAction) => {
    setAction(next);
    setReason("");
    setConfirmation("");
    setError(null);
    setCheckpointId(next.kind === "rollback" ? checkpointsByTrain.get(next.train.id)?.[0]?.id ?? "" : "");
  };
  const closeAction = () => {
    if (pending) return;
    setAction(null);
    setError(null);
  };
  const submit = async () => {
    if (!action) return;
    setPending(true);
    setError(null);
    const approvedAt = Date.now();
    const approval = { approvalId: approvalId(action.kind), approvedBy: "human" as const, approvedAt };
    try {
      if (action.kind === "rollback") {
        if (!checkpointId || confirmation !== "ROLLBACK") return;
        await rollbackIntegrationTrain({ missionId, trainId: action.train.id, checkpointId, approval });
      } else {
        const request = {
          missionId,
          trainId: action.train.id,
          taskId: action.taskId,
          reason: reason.trim(),
          approval,
        };
        if (action.kind === "retry") await retryIntegrationTrainEntry(request);
        else await skipIntegrationTrainEntry(request);
      }
      setAction(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  const selectedCheckpoint = action?.kind === "rollback"
    ? checkpointsByTrain.get(action.train.id)?.find((checkpoint) => checkpoint.id === checkpointId)
    : null;
  const canSubmit = action?.kind === "rollback"
    ? Boolean(checkpointId && confirmation === "ROLLBACK")
    : reason.trim().length >= 10;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section>
          <div className="mb-3 flex items-center gap-2"><GitMerge size={15} className="text-acc" /><h2 className="text-14 font-semibold text-txt">Integration train</h2></div>
          {trains.length > 0 ? trains.map((train) => (
            <Train
              key={train.id}
              train={train}
              tasks={tasks}
              checkpoints={checkpointsByTrain.get(train.id) ?? []}
              onAction={openAction}
            />
          )) : <div className="border-y border-line py-8"><p className="text-13 font-medium text-txt">No branch is waiting to integrate.</p><p className="mt-2 max-w-xl text-11 leading-relaxed text-fnt">When a task produces a reviewed commit, the scheduler creates a train, orders it by dependencies, cherry-picks it onto the integration branch and runs required gates before it can advance.</p></div>}
        </section>
        <section>
          <div className="mb-3 flex items-center gap-2"><ShieldCheck size={15} className="text-ok" /><h2 className="text-14 font-semibold text-txt">Quality gates</h2><span className="ml-auto font-mono text-10 text-fnt">{gates.length}</span></div>
          <div className="border-y border-line">
            {gates.length ? gates.map((gate) => <Gate key={gate.id} gate={gate} />) : <p className="py-6 text-11 leading-relaxed text-fnt">Gates appear here as tasks reach verification. Required gates must pass; waivers remain visible in the audit log.</p>}
          </div>
        </section>
      </div>

      <Dialog open={action !== null} onOpenChange={(open) => { if (!open) closeAction(); }}>
        <DialogContent showClose={!pending} className="w-[calc(100vw-2rem)] max-w-lg p-5">
          <DialogTitle className="text-14">
            {action?.kind === "retry" ? "Retry failed integration?" : action?.kind === "skip" ? "Skip failed entry?" : "Roll back integration branch?"}
          </DialogTitle>
          <DialogDescription className="mt-2 text-11 leading-relaxed text-mut">
            {action?.kind === "retry" && "This creates a new durable operation generation for only this entry. Previous failed receipts remain in the audit log."}
            {action?.kind === "skip" && "The task will not join this integration branch. Your reason is permanently recorded and the train continues with later entries."}
            {action?.kind === "rollback" && "The integration worktree will reset to the exact durable checkpoint you choose. Entries after it are re-queued; the failed entry still needs Retry or Skip."}
          </DialogDescription>
          {action?.kind === "rollback" ? (
            <div className="mt-4 space-y-3">
              <label className="block text-10 font-semibold uppercase tracking-wide text-fnt" htmlFor="integration-checkpoint">Durable checkpoint</label>
              <select id="integration-checkpoint" value={checkpointId} onChange={(event) => setCheckpointId(event.target.value)} disabled={pending} className="focus-ring h-9 w-full rounded-md border border-line2 bg-card px-2 font-mono text-10 text-txt">
                {(checkpointsByTrain.get(action.train.id) ?? []).map((checkpoint) => <option key={checkpoint.id} value={checkpoint.id}>{checkpoint.headCommit.slice(0, 10)} · {checkpoint.integratedTaskIds.length} integrated · {new Date(checkpoint.createdAt).toLocaleString()}</option>)}
              </select>
              {selectedCheckpoint && <div className="rounded-md border border-line bg-panel/50 p-3"><p className="font-mono text-10 text-acc">{selectedCheckpoint.headCommit}</p><p className="mt-1 text-10 text-fnt">{selectedCheckpoint.integratedTaskIds.length} task(s) retained at this checkpoint</p></div>}
              <label className="block text-10 text-mut" htmlFor="rollback-confirmation">Type <span className="font-mono font-semibold text-txt">ROLLBACK</span> to confirm</label>
              <input id="rollback-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={pending} autoComplete="off" className="focus-ring h-9 w-full rounded-md border border-err/35 bg-card px-3 font-mono text-11 text-txt" />
            </div>
          ) : (
            <div className="mt-4">
              <label className="mb-2 block text-10 font-semibold uppercase tracking-wide text-fnt" htmlFor="integration-action-reason">Audit reason</label>
              <Textarea id="integration-action-reason" value={reason} onChange={(event) => setReason(event.target.value)} disabled={pending} placeholder="Explain why this exception is safe and intentional…" className="min-h-24 resize-y text-11" />
              <p className="mt-1 text-right font-mono text-9 text-fnt">{reason.trim().length}/10 minimum</p>
            </div>
          )}
          {error && <div role="alert" className="mt-3 flex items-start gap-2 rounded-md border border-err/30 bg-err/5 p-3 text-10 leading-relaxed text-err"><CircleAlert size={13} className="mt-0.5 shrink-0" />{error}</div>}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" disabled={pending} onClick={closeAction} className="focus-ring h-8 rounded-md px-3 text-11 text-mut hover:bg-card disabled:opacity-40">Cancel</button>
            <button type="button" disabled={!canSubmit || pending} onClick={() => void submit()} className={cn("focus-ring flex h-8 items-center gap-2 rounded-md px-3 text-11 font-semibold text-bg disabled:opacity-35", action?.kind === "retry" ? "bg-acc" : "bg-err")}>
              {pending && <LoaderCircle size={13} className="animate-spin" />}
              {action?.kind === "retry" ? "Retry entry" : action?.kind === "skip" ? "Skip entry" : "Roll back"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Train({
  train,
  tasks,
  checkpoints,
  onAction,
}: {
  train: IntegrationTrain;
  tasks: Record<string, MissionTask>;
  checkpoints: readonly IntegrationCheckpoint[];
  onAction: (action: HumanAction) => void;
}) {
  return (
    <div className="mb-4 border-y border-line bg-panel/30">
      <div className="flex items-center gap-3 border-b border-line px-3 py-2">
        <span className={cn("font-mono text-10 uppercase", train.status === "blocked" ? "text-err" : "text-acc")}>{train.status}</span>
        <span className="min-w-0 truncate font-mono text-11 text-mut">{train.integrationBranch}</span>
        <span className="ml-auto shrink-0 text-10 text-fnt">base {train.baseBranch}</span>
        {train.status === "blocked" && checkpoints.length > 0 && <button type="button" onClick={() => onAction({ kind: "rollback", train })} className="focus-ring flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line2 px-2 text-10 text-mut hover:border-err/40 hover:text-err"><RotateCcw size={12} />Rollback</button>}
      </div>
      <ol>
        {train.entries.slice().sort((a, b) => a.position - b.position).map((entry) => (
          <li key={entry.taskId} className="border-b border-line px-3 py-2 last:border-0">
            <div className="flex items-center gap-3">
              <GitCommitHorizontal size={13} className={cn("shrink-0", entry.status === "integrated" ? "text-ok" : entry.status === "failed" ? "text-err" : entry.status === "skipped" ? "text-attn" : "text-fnt")} />
              <span className="min-w-0 truncate text-11 text-txt">{tasks[entry.taskId]?.title ?? entry.taskId}</span>
              <span className="ml-auto shrink-0 font-mono text-10 text-fnt">{entry.status}</span>
              {train.status === "blocked" && entry.status === "failed" && <div className="flex shrink-0 gap-1.5"><button type="button" onClick={() => onAction({ kind: "retry", train, taskId: entry.taskId })} className="focus-ring flex h-7 items-center gap-1 rounded-md bg-acc/15 px-2 text-10 font-semibold text-acc hover:bg-acc/20"><RotateCcw size={11} />Retry</button><button type="button" onClick={() => onAction({ kind: "skip", train, taskId: entry.taskId })} className="focus-ring flex h-7 items-center gap-1 rounded-md border border-err/30 px-2 text-10 text-err hover:bg-err/5"><SkipForward size={11} />Skip</button></div>}
            </div>
            {entry.detail && <p className="mt-1.5 break-words pl-6 text-10 leading-relaxed text-fnt">{entry.detail}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Gate({ gate }: { gate: QualityGate }) {
  const passed = gate.status === "passed" || gate.status === "waived";
  const failed = gate.status === "failed";
  return <div className="flex items-start gap-2 border-b border-line px-1 py-2.5 last:border-0">{passed ? <Check size={13} className="mt-0.5 shrink-0 text-ok" /> : failed ? <CircleAlert size={13} className="mt-0.5 shrink-0 text-err" /> : <span className="mt-1 h-2 w-2 shrink-0 rounded-full border border-line2" />}<div className="min-w-0"><p className="truncate text-11 font-medium text-txt">{gate.label}</p><p className={cn("mt-0.5 font-mono text-10", passed ? "text-ok" : failed ? "text-err" : "text-fnt")}>{gate.status}{gate.required ? " · required" : ""}</p>{gate.details && <p className="mt-1 text-10 leading-relaxed text-fnt">{gate.details}</p>}</div></div>;
}
