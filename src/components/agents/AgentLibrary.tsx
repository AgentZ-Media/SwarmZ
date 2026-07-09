import { useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Copy,
  FolderOpen,
  Loader2,
  Pencil,
  Play,
  Plus,
  Settings,
  Trash2,
  Wand2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Tip } from "../ui/tooltip";
import { cn } from "@/lib/utils";
import { useAgents } from "@/lib/agents/store";
import { useSwarm } from "@/store";
import { useVibeUi } from "@/lib/vibe/ui-store";
import { createAgent, deleteAgent, readAgent } from "@/lib/agents/api";
import type { AgentSummary } from "@/lib/agents/types";
import { readMemory } from "@/lib/orchestrator/memory";
import { DEFAULT_PERSONA } from "@/lib/orchestrator/persona";
import { startBuilderSession } from "@/lib/vibe/controller";
import { AgentEditor } from "./AgentEditor";
import { NewAgentBuilderDialog } from "./NewAgentBuilderDialog";

/** The orchestrator's built-in memory cap (kept in sync with the Rust seed). */
const MAESTRO_MEMORY_MAX = 20;

/**
 * The Agent Library (⌘K → "Agents"). A grid of agent cards over the on-disk
 * `~/.swarmz/agents/` folder, with Maestro pinned as the built-in Agent #0.
 * accent color is IDENTITY only (avatar tint + identity dot) — never status
 * (DESIGN.md). Start opens the matching New dialog preselecting the agent
 * (vibe-default → native session, otherwise a terminal pane).
 */
export function AgentLibrary({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}) {
  const open = useAgents((s) => s.libraryOpen);
  const setOpen = useAgents((s) => s.setLibraryOpen);
  const agents = useAgents((s) => s.agents);
  const loading = useAgents((s) => s.loading);
  const openEditor = useAgents((s) => s.openEditor);
  const setNewBuilderOpen = useAgents((s) => s.setNewBuilderOpen);
  const refreshAgents = useAgents((s) => s.refreshAgents);

  const [maestroMemory, setMaestroMemory] = useState<number | null>(null);

  // Maestro's memory fill for its built-in card
  useEffect(() => {
    if (!open) return;
    void readMemory()
      .then((m) => setMaestroMemory(m.length))
      .catch(() => setMaestroMemory(null));
  }, [open]);

  const count = agents?.length ?? 0;

  /** Launch an agent: close the library and open the matching New dialog with
   * the agent preselected. A vibe-default agent starts as a native session
   * (switching into Vibe Mode); everything else as a terminal pane. */
  const startAgent = (a: AgentSummary) => {
    setOpen(false);
    if (a.defaultRuntime === "vibe") {
      useSwarm.getState().setUiMode("vibe");
      useVibeUi.getState().openNewSessionForAgent(a.slug);
    } else {
      useSwarm.getState().openNewAgentForAgent(a.slug);
    }
  };

  /** Open a Builder session on an existing agent's folder (refine mode). */
  const refineWithBuilder = (a: AgentSummary) => {
    setOpen(false);
    void startBuilderSession({
      slug: a.slug,
      agentDir: a.dir,
      name: a.name,
      refine: true,
      ...(a.defaultModel ? { model: a.defaultModel } : {}),
    });
  };

  const duplicate = async (a: AgentSummary) => {
    const existing = new Set((agents ?? []).map((x) => x.slug));
    let slug = `${a.slug}-copy`;
    let n = 2;
    while (existing.has(slug)) slug = `${a.slug}-copy-${n++}`;
    const detail = await readAgent(a.slug);
    await createAgent(
      {
        ...detail,
        slug,
        name: `${detail.name} copy`,
        createdAt: "",
      },
      detail.soul,
    );
    await refreshAgents();
    openEditor(slug);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-baseline gap-3">
              Agents
              <span className="font-mono text-[10px] font-normal text-faint">
                {count + 1} agents · ~/.swarmz/agents
              </span>
            </DialogTitle>
            <DialogDescription>
              Specialist agents with their own persona, memory and identity
              color. Maestro is the built-in Agent #0.
            </DialogDescription>
          </DialogHeader>

          <div className="grid max-h-[65vh] grid-cols-1 gap-3 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
            {/* Agent #0 — Maestro, built-in, not removable */}
            <MaestroCard
              memoryCount={maestroMemory}
              onSettings={() => {
                setOpen(false);
                onOpenSettings();
              }}
            />

            {(agents ?? []).map((a) => (
              <AgentCard
                key={a.slug}
                agent={a}
                onStart={() => startAgent(a)}
                onEdit={() => openEditor(a.slug)}
                onRefine={() => refineWithBuilder(a)}
                onFiles={() => void revealItemInDir(a.dir)}
                onDuplicate={() => void duplicate(a)}
                onDeleted={() => void refreshAgents()}
              />
            ))}

            {/* New agent — the chat-driven Builder wizard (Phase C) */}
            <button
              onClick={() => setNewBuilderOpen(true)}
              className="flex min-h-[120px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border text-faint transition-colors hover:border-input hover:text-muted-foreground"
            >
              <Plus size={18} />
              <span className="font-mono text-[11px]">New agent</span>
              <span className="font-mono text-[9px] text-faint/70">
                design it in chat
              </span>
            </button>

            {loading && agents === null && (
              <div className="col-span-full flex items-center justify-center py-8 text-faint">
                <Loader2 size={18} className="animate-spin" />
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <AgentEditor />
      <NewAgentBuilderDialog />
    </>
  );
}

function CardShell({
  emoji,
  accent,
  name,
  role,
  builtin,
  children,
}: {
  emoji: string;
  accent: string;
  name: string;
  role: string;
  builtin?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border bg-card p-3.5",
        builtin ? "border-dashed border-border" : "border-border",
      )}
    >
      <div className="mb-2 flex items-center gap-2.5">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lg"
          style={{
            backgroundColor: `color-mix(in srgb, ${accent} 16%, var(--secondary))`,
            border: `1px solid color-mix(in srgb, ${accent} 30%, var(--border))`,
          }}
        >
          {emoji}
        </div>
        <div className="min-w-0">
          <div
            className="line-clamp-2 text-sm font-semibold leading-snug text-foreground"
            title={name}
          >
            {name}
          </div>
          <div className="truncate font-mono text-[10px] text-faint" title={role}>
            {role}
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}

function MaestroCard({
  memoryCount,
  onSettings,
}: {
  memoryCount: number | null;
  onSettings: () => void;
}) {
  return (
    <CardShell
      emoji={DEFAULT_PERSONA.emoji ?? "🎼"}
      accent="var(--ring)"
      name={DEFAULT_PERSONA.name}
      role="fleet conductor · built-in"
      builtin
    >
      <p className="mb-3 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
        The orchestrator itself — assigns the work, keeps the tempo. Persona
        &amp; memory editable in Settings.
      </p>
      <div className="mt-auto flex items-center gap-2 font-mono text-[10px] text-faint">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: "var(--ring)" }}
        />
        <span className="tabular-nums">
          memory {memoryCount ?? "–"}/{MAESTRO_MEMORY_MAX}
        </span>
        <button
          onClick={onSettings}
          className="ml-auto flex items-center gap-1 rounded border border-border px-2 py-0.5 text-muted-foreground transition-colors hover:border-input hover:text-foreground"
        >
          <Settings size={11} /> Settings
        </button>
      </div>
    </CardShell>
  );
}

function AgentCard({
  agent,
  onStart,
  onEdit,
  onRefine,
  onFiles,
  onDuplicate,
  onDeleted,
}: {
  agent: AgentSummary;
  onStart: () => void;
  onEdit: () => void;
  onRefine: () => void;
  onFiles: () => void;
  onDuplicate: () => void;
  onDeleted: () => void;
}) {
  const [armDelete, setArmDelete] = useState(false);
  const disarmTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(disarmTimer.current), []);

  const accent = agent.accent || "var(--muted-foreground)";

  return (
    <CardShell
      emoji={agent.emoji || "🤖"}
      accent={accent}
      name={agent.name}
      role={agent.role || agent.slug}
    >
      <p className="mb-3 line-clamp-2 min-h-[2.6em] text-[11px] leading-relaxed text-muted-foreground">
        {agent.description || "No soul written yet."}
      </p>
      <div className="mt-auto flex items-center gap-2 font-mono text-[10px] text-faint">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: accent }}
        />
        <span className="tabular-nums">
          memory {agent.memoryCount}/{agent.memoryMax}
        </span>
        {agent.knowledgeCount > 0 && (
          <span className="rounded-full border border-border bg-secondary px-1.5 py-px">
            {agent.knowledgeCount} knowledge
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Tip label="Start this agent" side="top">
            <button
              onClick={onStart}
              className="flex h-6 w-6 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:border-input hover:text-foreground"
            >
              <Play size={12} />
            </button>
          </Tip>
          <IconBtn label="Edit fields & soul" onClick={onEdit}>
            <Pencil size={12} />
          </IconBtn>
          <IconBtn label="Refine with the Builder" onClick={onRefine}>
            <Wand2 size={12} />
          </IconBtn>
          <IconBtn label="Reveal folder in Finder" onClick={onFiles}>
            <FolderOpen size={12} />
          </IconBtn>
          <IconBtn label="Duplicate" onClick={onDuplicate}>
            <Copy size={12} />
          </IconBtn>
          <button
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded border transition-colors",
              armDelete
                ? "border-destructive/40 bg-destructive/15 text-destructive"
                : "border-border text-faint hover:border-destructive/40 hover:text-destructive",
            )}
            title={armDelete ? "Click again to delete" : "Delete agent"}
            onClick={() => {
              if (!armDelete) {
                setArmDelete(true);
                window.clearTimeout(disarmTimer.current);
                disarmTimer.current = window.setTimeout(
                  () => setArmDelete(false),
                  4000,
                );
                return;
              }
              window.clearTimeout(disarmTimer.current);
              setArmDelete(false);
              void deleteAgent(agent.slug).then(onDeleted);
            }}
            onPointerLeave={() => armDelete && setArmDelete(false)}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    </CardShell>
  );
}

function IconBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tip label={label} side="top">
      <button
        onClick={onClick}
        className="flex h-6 w-6 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:border-input hover:text-foreground"
      >
        {children}
      </button>
    </Tip>
  );
}
