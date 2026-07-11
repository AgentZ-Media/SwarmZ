// The Conductor's PLAN VIEWER — reads the Markdown plan documents the
// Conductor writes under `<project>/.swarmz/plans/` (its one sanctioned write
// surface) so the human can actually READ them in-app instead of only on
// disk. Read-only: list (conductor_plan_list) → one document (conductor_plan_read),
// rendered with the shared lightweight markdown. Native-only.

import { useEffect, useState } from "react";
import { ChevronLeft, FileText, RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tip } from "@/components/ui/tooltip";
import { OrchestratorMarkdown } from "@/components/OrchestratorMarkdown";
import { listPlans, readPlan } from "@/lib/orchestrator/native";
import { useProjects } from "@/lib/projects/store";
import { IS_TAURI } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { ConductorPlanInfo } from "@/lib/orchestrator/types";

/** Icon button in the Conductor header — opens the plan viewer for the active
 * project. Hidden off-Tauri (no filesystem). */
export function ConductorPlansButton({ projectId }: { projectId: string | null }) {
  const [open, setOpen] = useState(false);
  if (!IS_TAURI || !projectId) return null;
  return (
    <>
      <Tip label="Conductor plans">
        <button
          onClick={() => setOpen(true)}
          className="focus-ring flex h-6 w-6 items-center justify-center rounded-md text-fnt hover:bg-card hover:text-txt"
        >
          <FileText size={13} />
        </button>
      </Tip>
      {open && (
        <PlansDialog open={open} onOpenChange={setOpen} projectId={projectId} />
      )}
    </>
  );
}

function PlansDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}) {
  const dir = useProjects((s) => s.projects[projectId]?.dir ?? "");
  const [plans, setPlans] = useState<ConductorPlanInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ConductorPlanInfo | null>(null);

  const refresh = () => {
    if (!dir) return;
    setError(null);
    setPlans(null);
    void listPlans(dir)
      .then((ps) =>
        setPlans(
          [...ps].sort((a, b) => b.modified_ms - a.modified_ms),
        ),
      )
      .catch((e) => setError(String(e)));
  };

  // load on open / project change
  useEffect(() => {
    refresh();
    setSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[70vh] max-h-[640px] w-full max-w-2xl flex-col p-0">
        <DialogHeader className="mb-0 flex-row items-center gap-2 border-b border-line px-5 py-3.5">
          {selected ? (
            <button
              onClick={() => setSelected(null)}
              className="focus-ring -ml-1 flex h-7 items-center gap-1 rounded-md px-2 text-12 text-mut hover:bg-card hover:text-txt"
            >
              <ChevronLeft size={13} /> Plans
            </button>
          ) : (
            <FileText size={14} className="shrink-0 text-acc" />
          )}
          <DialogTitle className="min-w-0 flex-1 truncate text-14">
            {selected ? selected.title : "Conductor plans"}
          </DialogTitle>
          {!selected && (
            <button
              onClick={refresh}
              title="Refresh"
              className="focus-ring mr-6 flex h-7 w-7 items-center justify-center rounded-md text-fnt hover:bg-card hover:text-txt"
            >
              <RefreshCw size={12} />
            </button>
          )}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {selected ? (
            <PlanDetail dir={dir} plan={selected} />
          ) : error ? (
            <p className="font-mono text-11 text-err">{error}</p>
          ) : plans === null ? (
            <p className="text-12 text-fnt">Loading plans…</p>
          ) : plans.length === 0 ? (
            <p className="max-w-sm text-12 leading-relaxed text-fnt">
              No plan documents yet. When the Conductor writes a plan for this
              project (its `write_plan` tool), it appears here.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {plans.map((p) => (
                <li key={p.slug}>
                  <button
                    onClick={() => setSelected(p)}
                    className={cn(
                      "focus-ring flex w-full items-center gap-3 rounded-lg border border-line bg-card px-3 py-2.5 text-left transition-colors hover:border-line2",
                    )}
                  >
                    <FileText size={13} className="shrink-0 text-fnt" />
                    <span className="min-w-0 flex-1 truncate text-13 text-txt">
                      {p.title}
                    </span>
                    <span className="shrink-0 font-mono text-10 tabular-nums text-fnt">
                      {new Date(p.modified_ms).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PlanDetail({ dir, plan }: { dir: string; plan: ConductorPlanInfo }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setContent(null);
    setError(null);
    void readPlan(dir, plan.slug)
      .then((doc) => {
        if (!stale) setContent(doc.content);
      })
      .catch((e) => {
        if (!stale) setError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [dir, plan.slug]);

  if (error) return <p className="font-mono text-11 text-err">{error}</p>;
  if (content === null) return <p className="text-12 text-fnt">Loading…</p>;
  return (
    <div className="select-text text-13 leading-relaxed text-txt">
      <OrchestratorMarkdown text={content} />
    </div>
  );
}
