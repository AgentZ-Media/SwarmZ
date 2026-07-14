import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Clock3, RefreshCw, ShieldAlert, X } from "lucide-react";
import { useMissionOutbox } from "@/lib/missions/outbox-store";
import type { MissionOutboxRecord } from "@/lib/missions/outbox";
import { useVibeUi } from "@/lib/vibe/ui-store";
import { cn } from "@/lib/utils";

export function MissionRecoveryPanel({ missionId }: { missionId: string }) {
  const signature = useMissionOutbox((state) => Object.values(state.snapshot.records)
    .filter((record) => record.missionId === missionId)
    .map((record) => `${record.id}:${record.status}:${record.attempts}:${record.updatedAt}:${record.nextAttemptAt}:${record.lastError ?? ""}`)
    .sort()
    .join("|"));
  const hydrateStatus = useMissionOutbox((state) => state.hydrateStatus);
  const hydrateError = useMissionOutbox((state) => state.hydrateError);
  const rows = useMemo(() => Object.values(useMissionOutbox.getState().snapshot.records)
    .filter((record) => record.missionId === missionId)
    .sort((a, b) => {
      const rank = (record: MissionOutboxRecord) => record.status === "dead_letter" ? 0 : record.status === "failed" ? 1 : record.status === "claimed" ? 2 : record.status === "pending" ? 3 : 4;
      return rank(a) - rank(b) || b.updatedAt - a.updatedAt;
    }), [missionId, signature]);
  const active = rows.filter((record) => record.status !== "delivered");
  const history = rows.filter((record) => record.status === "delivered").slice(0, 12);
  const close = () => useVibeUi.getState().setRecoveryOpen(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", key);
    const timer = window.setInterval(() => tick((value) => value + 1), 1_000);
    return () => { window.removeEventListener("keydown", key); window.clearInterval(timer); };
  }, []);

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="mission-recovery-title" className="absolute inset-0 z-50 flex justify-end bg-black/50" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <aside className="flex h-full w-[min(620px,95vw)] flex-col border-l border-line2 bg-panel shadow-2xl">
        <header className="flex min-h-14 items-center gap-3 border-b border-line px-4">
          <ShieldAlert size={15} className={active.length ? "text-attn" : "text-ok"} />
          <div><h2 id="mission-recovery-title" className="text-14 font-semibold text-txt">Recovery &amp; delivery ledger</h2><p className="mt-0.5 text-10 text-fnt">Write-ahead effects, durable claims and restart reconciliation</p></div>
          <button onClick={close} aria-label="Close recovery panel" className="focus-ring ml-auto flex h-8 w-8 items-center justify-center rounded-md text-fnt hover:bg-card hover:text-txt"><X size={14} /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {hydrateStatus === "failed" && <div role="alert" className="mb-4 border border-err/35 bg-err/10 p-3"><p className="flex items-center gap-2 text-12 font-medium text-err"><AlertTriangle size={13} /> Dispatch frozen</p><p className="mt-1 text-11 leading-relaxed text-mut">{hydrateError || "The outbox could not be loaded safely."}</p></div>}
          <div className="mb-3 flex items-baseline gap-2"><h3 className="text-12 font-semibold text-txt">Open delivery work</h3><span className="font-mono text-10 text-fnt">{active.length}</span></div>
          {active.length ? <div className="border-y border-line">{active.map((record) => <RecoveryRow key={record.id} record={record} />)}</div> : <div className="border-y border-line py-8 text-center"><Check size={18} className="mx-auto text-ok" /><p className="mt-2 text-12 font-medium text-txt">Reconciled</p><p className="mt-1 text-11 text-fnt">No command is stranded, retrying or waiting for a receipt.</p></div>}
          {history.length > 0 && <><div className="mb-3 mt-6 flex items-baseline gap-2"><h3 className="text-12 font-semibold text-txt">Recent durable receipts</h3><span className="font-mono text-10 text-fnt">latest {history.length}</span></div><div className="border-y border-line">{history.map((record) => <RecoveryRow key={record.id} record={record} />)}</div></>}
        </div>
      </aside>
    </div>
  );
}

function RecoveryRow({ record }: { record: MissionOutboxRecord }) {
  const [error, setError] = useState<string | null>(null);
  const retry = async () => {
    setError(null);
    try { await useMissionOutbox.getState().retryDeadLetter(record.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const due = Math.max(0, record.nextAttemptAt - Date.now());
  const statusClass = record.status === "delivered" ? "text-ok" : record.status === "dead_letter" ? "text-err" : record.status === "failed" ? "text-attn" : "text-acc";
  return <div className="border-b border-line px-3 py-3 last:border-0"><div className="flex items-center gap-2"><span aria-hidden className={cn("font-mono text-10", statusClass)}>{record.status === "delivered" ? "✓" : record.status === "dead_letter" ? "×" : record.status === "failed" ? "!" : record.status === "claimed" ? "▶" : "◇"}</span><span className="text-11 font-medium text-txt">{record.command.kind}</span><span className={cn("font-mono text-10 uppercase", statusClass)}>{record.status.replace("_", " ")}</span><span className="ml-auto font-mono text-10 text-fnt">attempt {record.attempts}/{record.maxAttempts}</span></div><p className="mt-1 truncate font-mono text-10 text-fnt">{record.idempotencyKey}</p>{record.lastError && <p className="mt-1 text-11 leading-relaxed text-err">{record.lastError}</p>}<div className="mt-2 flex items-center gap-2">{record.status === "failed" && <span className="flex items-center gap-1 font-mono text-10 text-attn"><Clock3 size={10} /> retry in {Math.ceil(due / 1000)}s</span>}{record.status === "dead_letter" && <button onClick={() => void retry()} className="focus-ring flex h-7 items-center gap-1.5 rounded-md border border-line2 px-2.5 text-10 text-mut hover:bg-card hover:text-txt"><RefreshCw size={10} /> Retry after review</button>}<time className="ml-auto font-mono text-10 text-fnt">{new Date(record.updatedAt).toLocaleTimeString()}</time></div>{error && <p role="alert" className="mt-2 text-10 text-err">{error}</p>}</div>;
}
