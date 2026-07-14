import { useMemo, useState } from "react";
import { Archive, Bell, CalendarClock, MoreHorizontal, Trash2, X } from "lucide-react";
import { flushMissionsPersist, useMissions } from "@/lib/missions/store";
import { cancelMissionSchedule, createMissionSchedule } from "@/lib/missions/schedules";
import type { Mission, MissionSchedule } from "@/lib/missions/types";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

type ConfirmAction = "cancel" | "archive" | null;

export function MissionHeaderActions({ mission }: { mission: Mission }) {
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmAction>(null);
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState("");
  const [at, setAt] = useState(() => localInput(Date.now() + 60 * 60_000));
  const [error, setError] = useState<string | null>(null);
  const signature = useMissions((state) => Object.values(state.projection.schedules)
    .filter((item) => item.missionId === mission.id)
    .map((item) => `${item.id}:${item.cancelledAt}:${item.claimedAt}:${item.firedAt}:${item.lastDeliveryError}:${item.nextAttemptAt}`).join("|"));
  const schedules = useMemo(() => Object.values(useMissions.getState().projection.schedules)
    .filter((item) => item.missionId === mission.id && item.cancelledAt === null && item.firedAt === null)
    .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id)), [mission.id, signature]);
  const running = useMissions((state) => mission.taskIds.some((id) => state.projection.tasks[id]?.status === "running"));
  const cancellable = !["cancelled", "archived", "failed", "succeeded"].includes(mission.status);

  const add = async () => {
    setError(null);
    try {
      if (note.trim().length < 2) throw new Error("Add a useful reminder note.");
      await createMissionSchedule(mission.id, note.trim(), new Date(at).getTime());
      setNote("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const commitLifecycle = async () => {
    if (!confirm || typed !== mission.title) return;
    setError(null);
    try {
      if (confirm === "cancel") useMissions.getState().cancelMission(mission.id);
      else useMissions.getState().archiveMission(mission.id);
      await flushMissionsPersist();
      setConfirm(null); setTyped("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return <>
    <Popover open={remindersOpen} onOpenChange={setRemindersOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`${schedules.length} pending mission reminders`} className={cn("focus-ring flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-11 hover:bg-card", schedules.length ? "border-acc/35 text-acc" : "border-line2 text-mut hover:text-txt")}><Bell size={12} aria-hidden />{schedules.length || "Reminder"}</button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[calc(100dvh-5rem)] w-[min(380px,calc(100vw-2rem))] overflow-y-auto p-3">
        <div className="flex items-center gap-2"><CalendarClock size={13} className="text-acc" /><p className="text-11 font-semibold text-txt">Durable mission reminders</p><button type="button" onClick={() => setRemindersOpen(false)} aria-label="Close reminders" className="focus-ring ml-auto h-7 w-7 rounded-md text-fnt hover:bg-card"><X size={13} className="mx-auto" /></button></div>
        <p className="mt-1 text-10 leading-normal text-fnt">Deadlines survive restarts. Overdue reminders fire on the next launch and are claimed before the native notification.</p>
        <label className="mt-3 block text-10 text-fnt">Note<input value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} className="focus-ring mt-1 h-8 w-full rounded-md border border-line2 bg-card px-2 text-11 text-txt" placeholder="Review the combined release evidence" /></label>
        <label className="mt-2 block text-10 text-fnt">When<input type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} className="focus-ring mt-1 h-8 w-full rounded-md border border-line2 bg-card px-2 font-mono text-10 text-txt" /></label>
        <button type="button" onClick={() => void add()} disabled={note.trim().length < 2 || !at} className="focus-ring mt-2 h-8 w-full rounded-md bg-acc text-11 font-semibold text-bg disabled:opacity-40">Schedule reminder</button>
        {error && <p role="alert" aria-live="assertive" className="mt-2 break-words text-10 text-err">{error}</p>}
        <div className="mt-3 max-h-44 space-y-1 overflow-y-auto">{schedules.length === 0 ? <p className="py-2 text-center text-10 text-fnt">No pending reminders.</p> : schedules.map((item) => <ScheduleRow key={item.id} schedule={item} onError={setError} />)}</div>
      </PopoverContent>
    </Popover>
    <DropdownMenu onOpenChange={(open) => { if (open) setRemindersOpen(false); }}>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Mission actions" className="focus-ring flex h-8 w-8 items-center justify-center rounded-md border border-line2 text-mut hover:bg-card hover:text-txt"><MoreHorizontal size={14} aria-hidden /></button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem danger disabled={!cancellable} onSelect={() => setConfirm("cancel")}><Trash2 />Cancel mission</DropdownMenuItem>
        <DropdownMenuItem disabled={running || mission.status === "archived"} onSelect={() => setConfirm("archive")}><Archive />Archive mission</DropdownMenuItem>
        {running && <p className="px-2 py-1 text-10 leading-normal text-fnt">Archive is locked while a worker is running.</p>}
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open) { setConfirm(null); setTyped(""); } }}>
      <DialogContent showClose={false} className="w-[calc(100vw-2rem)] max-w-md p-4">
        <DialogTitle className="text-14">{confirm === "cancel" ? "Cancel this mission?" : "Archive this mission?"}</DialogTitle>
        <DialogDescription className="mt-2 text-11 text-mut">{confirm === "cancel" ? "Running Mission workers will be interrupted. Existing branches, evidence and the immutable audit log remain available." : "The mission leaves the active workspace and becomes immutable. This cannot be undone from the UI."}</DialogDescription>
        <label className="mt-4 block text-10 text-fnt">Type <strong className="break-words text-txt">{mission.title}</strong> to confirm<input autoFocus value={typed} onChange={(event) => setTyped(event.target.value)} aria-invalid={typed.length > 0 && typed !== mission.title} className="focus-ring mt-1 h-9 w-full rounded-md border border-line2 bg-card px-3 text-12 text-txt" /></label>
        {error && <p role="alert" aria-live="assertive" className="mt-2 break-words text-10 text-err">{error}</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-2"><button type="button" onClick={() => { setConfirm(null); setTyped(""); }} className="focus-ring h-8 rounded-md px-3 text-11 text-mut hover:bg-card">Keep mission</button><button type="button" disabled={typed !== mission.title} onClick={() => void commitLifecycle()} className="focus-ring h-8 rounded-md bg-err px-3 text-11 font-semibold text-bg disabled:opacity-35">{confirm === "cancel" ? "Cancel mission" : "Archive mission"}</button></div>
      </DialogContent>
    </Dialog>
  </>;
}

function ScheduleRow({ schedule, onError }: { schedule: MissionSchedule; onError: (value: string | null) => void }) {
  const uncertain = schedule.claimedAt !== null && schedule.firedAt === null;
  return <div className="flex items-center gap-2 rounded-md bg-card px-2 py-2"><div className="min-w-0 flex-1"><p className="break-words text-10 text-txt">{schedule.note}</p><time className="font-mono text-10 text-fnt">{new Date(schedule.at).toLocaleString()}</time>{schedule.lastDeliveryError && <p className="mt-0.5 text-10 leading-normal text-err">Delivery failed · retry {schedule.nextAttemptAt ? new Date(schedule.nextAttemptAt).toLocaleTimeString() : "pending"}</p>}{uncertain && <p className="mt-0.5 text-10 leading-normal text-attn">Delivery uncertain · not retried automatically</p>}</div>{!uncertain && <button type="button" aria-label={`Cancel reminder ${schedule.note}`} onClick={() => void cancelMissionSchedule(schedule.missionId, schedule.id).catch((error) => onError(error instanceof Error ? error.message : String(error)))} className="focus-ring h-7 w-7 rounded-md text-fnt hover:bg-err/10 hover:text-err"><X size={12} className="mx-auto" /></button>}</div>;
}

function localInput(timestamp: number): string {
  const date = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}
