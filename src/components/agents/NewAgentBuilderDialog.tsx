import { useEffect, useMemo, useState } from "react";
import { Check, Pencil, Wand2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useAgents } from "@/lib/agents/store";
import { createAgent } from "@/lib/agents/api";
import { slugify } from "@/lib/agents/types";
import { slugTaken, stubAgentDef } from "@/lib/agents/builder";
import { startBuilderSession } from "@/lib/vibe/controller";
import {
  ensureCodexModels,
  recentCodexModels,
  useCodexModels,
} from "@/lib/orchestrator/models";
import { cn, prettyModel } from "@/lib/utils";

/**
 * The "New agent" pre-dialog: name → slug (collision-checked), an optional
 * capable model, then it creates the agent folder and hands off to the Agent
 * Builder — which opens in its own focused modal (BuilderModal). The chat there
 * does the real design work; this dialog is just the doorway.
 */
export function NewAgentBuilderDialog() {
  const open = useAgents((s) => s.newBuilderOpen);
  const setOpen = useAgents((s) => s.setNewBuilderOpen);
  const setLibraryOpen = useAgents((s) => s.setLibraryOpen);
  const agents = useAgents((s) => s.agents);
  const refreshAgents = useAgents((s) => s.refreshAgents);

  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setModel("");
    setError(null);
    setCreating(false);
    // load the account model catalog so the inline list is populated in-dialog
    void ensureCodexModels();
  }, [open]);

  const slug = useMemo(() => slugify(name), [name]);
  const collision = useMemo(
    () => slugTaken(slug, (agents ?? []).map((a) => a.slug)),
    [slug, agents],
  );
  const canStart = !!name.trim() && !!slug && !collision && !creating;

  const start = async () => {
    if (!canStart) return;
    setCreating(true);
    setError(null);
    try {
      // create the folder with a minimal stub — the Builder overwrites it
      const detail = await createAgent(
        stubAgentDef(name, slug, model.trim() || undefined),
        "",
      );
      await refreshAgents();
      await startBuilderSession({
        slug: detail.slug,
        agentDir: detail.dir,
        name: detail.name,
        ...(model.trim() ? { model: model.trim() } : {}),
      });
      setOpen(false);
      setLibraryOpen(false);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 size={16} className="text-muted-foreground" />
            Build a new agent
          </DialogTitle>
          <DialogDescription>
            Name it, then design it in conversation. The Builder asks a few
            questions and writes the agent&apos;s files live — you watch and
            refine as it goes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>Agent name</Label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Podcast Editor"
              onKeyDown={(e) => e.key === "Enter" && canStart && void start()}
            />
            <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] text-faint">
              {slug ? (
                <>
                  <span>~/.swarmz/agents/</span>
                  <span
                    className={
                      collision ? "text-destructive" : "text-muted-foreground"
                    }
                  >
                    {slug}
                  </span>
                  {collision && <span className="text-destructive">· already exists</span>}
                </>
              ) : (
                <span>the folder slug is derived from the name</span>
              )}
            </div>
          </div>

          <div>
            <Label>Model (optional)</Label>
            {/* Inline picker — an in-dialog popover proved unreliable (Radix
                focus/pointer interplay across stacked dialogs), so the model
                list lives directly in the dialog: always visible, always
                clickable. */}
            <InlineModelPicker model={model} onPick={setModel} />
            <p className="mt-1.5 text-[11px] text-faint">
              A more capable model tends to write a sharper, more specific agent.
              Used for the whole build.
            </p>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
              <p className="break-words font-mono text-[10px] leading-relaxed text-destructive">
                {error}
              </p>
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => void start()} disabled={!canStart}>
            {creating ? "Starting…" : "Start building"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A flat, always-visible model list (no popover) — Default + the account
 * catalog + recents (deduped), plus a Custom… free-text row. */
function InlineModelPicker({
  model,
  onPick,
}: {
  model: string;
  onPick: (next: string) => void;
}) {
  const available = useCodexModels((s) => s.available);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState("");

  const options = useMemo(() => {
    const recents = recentCodexModels();
    return [...(model ? [model] : []), ...available, ...recents].filter(
      (m, i, arr) => arr.indexOf(m) === i,
    );
  }, [available, model]);

  return (
    <div className="max-h-52 overflow-y-auto rounded-md border border-border bg-secondary/40 p-1">
      <ModelRow
        selected={!model}
        label="Codex default"
        hint="a capable model"
        onClick={() => onPick("")}
      />
      {options.map((m) => (
        <ModelRow
          key={m}
          selected={m === model}
          label={prettyModel(m)}
          hint={m}
          mono
          onClick={() => onPick(m)}
        />
      ))}
      {custom ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = draft.trim();
            if (v) onPick(v);
            setCustom(false);
            setDraft("");
          }}
          className="px-1 py-1"
        >
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setCustom(false);
                setDraft("");
              }
            }}
            placeholder="model id, e.g. gpt-5.5"
            spellCheck={false}
            className="focus-ring h-7 w-full rounded bg-background px-2 font-mono text-[11px] text-foreground outline-none placeholder:text-faint"
          />
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setCustom(true)}
          className="focus-ring flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Pencil size={11} className="text-faint" /> Custom…
        </button>
      )}
    </div>
  );
}

function ModelRow({
  selected,
  label,
  hint,
  mono,
  onClick,
}: {
  selected: boolean;
  label: string;
  hint?: string;
  mono?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "focus-ring flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
        selected ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <Check
        size={12}
        className={cn("shrink-0", selected ? "text-ring" : "opacity-0")}
      />
      <span className={cn("min-w-0 flex-1 truncate", mono && "font-mono")}>
        {label}
      </span>
      {hint && hint !== label && (
        <span className="shrink-0 truncate font-mono text-[9px] text-faint">
          {hint}
        </span>
      )}
    </button>
  );
}
