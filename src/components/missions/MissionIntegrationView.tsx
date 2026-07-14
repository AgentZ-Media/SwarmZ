import { useMemo } from "react";
import { Check, CircleAlert, GitCommitHorizontal, GitMerge, ShieldCheck } from "lucide-react";
import { useMissions } from "@/lib/missions/store";
import type { IntegrationTrain, QualityGate } from "@/lib/missions/types";
import { cn } from "@/lib/utils";

export function MissionIntegrationView({ missionId }: { missionId: string }) {
  const signature = useMissions((state) => {
    const mission = state.projection.missions[missionId];
    if (!mission) return "";
    const trains = mission.integrationTrainIds.map((id) => {
      const train = state.projection.integrationTrains[id];
      return train ? `${id}:${train.status}:${train.updatedAt}` : id;
    });
    const gates = Object.values(state.projection.qualityGates).filter((gate) => gate.missionId === missionId).map((gate) => `${gate.id}:${gate.status}:${gate.updatedAt}`);
    return [...trains, ...gates].join("|");
  });
  const { trains, gates } = useMemo(() => {
    const projection = useMissions.getState().projection;
    const mission = projection.missions[missionId];
    return {
      trains: (mission?.integrationTrainIds ?? []).map((id) => projection.integrationTrains[id]).filter((train): train is IntegrationTrain => !!train),
      gates: Object.values(projection.qualityGates).filter((gate) => gate.missionId === missionId),
    };
  }, [missionId, signature]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section>
          <div className="mb-3 flex items-center gap-2"><GitMerge size={15} className="text-acc" /><h2 className="text-14 font-semibold text-txt">Integration train</h2></div>
          {trains.length > 0 ? trains.map((train) => <Train key={train.id} train={train} />) : <div className="border-y border-line py-8"><p className="text-13 font-medium text-txt">No branch is waiting to integrate.</p><p className="mt-2 max-w-xl text-11 leading-relaxed text-fnt">When a task produces a reviewed commit, the scheduler creates a train, orders it by dependencies, rebases it onto the current integration branch and runs required gates before it can advance.</p></div>}
        </section>
        <section>
          <div className="mb-3 flex items-center gap-2"><ShieldCheck size={15} className="text-ok" /><h2 className="text-14 font-semibold text-txt">Quality gates</h2><span className="ml-auto font-mono text-10 text-fnt">{gates.length}</span></div>
          <div className="border-y border-line">
            {gates.length ? gates.map((gate) => <Gate key={gate.id} gate={gate} />) : <p className="py-6 text-11 leading-relaxed text-fnt">Gates appear here as tasks reach verification. Required gates must pass; waivers remain visible in the audit log.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}

function Train({ train }: { train: IntegrationTrain }) {
  return (
    <div className="mb-4 border-y border-line bg-panel/30">
      <div className="flex items-center gap-3 border-b border-line px-3 py-2"><span className="font-mono text-10 uppercase text-acc">{train.status}</span><span className="font-mono text-11 text-mut">{train.integrationBranch}</span><span className="ml-auto text-10 text-fnt">base {train.baseBranch}</span></div>
      <ol>
        {train.entries.slice().sort((a, b) => a.position - b.position).map((entry) => <li key={entry.taskId} className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-0"><GitCommitHorizontal size={13} className={cn(entry.status === "integrated" ? "text-ok" : entry.status === "failed" ? "text-err" : "text-fnt")} /><span className="truncate text-11 text-txt">{entry.taskId}</span><span className="ml-auto font-mono text-10 text-fnt">{entry.status}</span></li>)}
      </ol>
    </div>
  );
}

function Gate({ gate }: { gate: QualityGate }) {
  const passed = gate.status === "passed" || gate.status === "waived";
  const failed = gate.status === "failed";
  return <div className="flex items-start gap-2 border-b border-line px-1 py-2.5 last:border-0">{passed ? <Check size={13} className="mt-0.5 shrink-0 text-ok" /> : failed ? <CircleAlert size={13} className="mt-0.5 shrink-0 text-err" /> : <span className="mt-1 h-2 w-2 shrink-0 rounded-full border border-line2" />}<div className="min-w-0"><p className="truncate text-11 font-medium text-txt">{gate.label}</p><p className={cn("mt-0.5 font-mono text-10", passed ? "text-ok" : failed ? "text-err" : "text-fnt")}>{gate.status}{gate.required ? " · required" : ""}</p>{gate.details && <p className="mt-1 text-10 leading-relaxed text-fnt">{gate.details}</p>}</div></div>;
}
