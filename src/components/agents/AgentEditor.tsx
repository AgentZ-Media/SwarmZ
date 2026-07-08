import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input, Label } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { AGENT_COLORS, cn } from "@/lib/utils";
import { createAgent, readAgent, writeAgent } from "@/lib/agents/api";
import { slugify } from "@/lib/agents/types";
import type { AgentDefaultRuntime } from "@/lib/agents/types";
import { useAgents } from "@/lib/agents/store";

const DEFAULT_EMOJI = "🤖";

interface Draft {
  name: string;
  emoji: string;
  accent: string;
  role: string;
  tone: string;
  principles: string; // one per line, edited as text
  defaultRuntime: AgentDefaultRuntime;
  soul: string;
  createdAt: string;
}

function blankDraft(): Draft {
  return {
    name: "",
    emoji: DEFAULT_EMOJI,
    accent: AGENT_COLORS[0],
    role: "",
    tone: "",
    principles: "",
    defaultRuntime: "vibe",
    soul: "",
    createdAt: "",
  };
}

/**
 * The Phase-A agent editor: edit agent.json fields + the soul.md textarea and
 * save (agent_create for a new draft, agent_write for an existing one). The
 * agent's memory.md and knowledge/ are its own — not touched here. Controlled
 * by the agents store's `editingSlug` ("" = new draft, a slug = edit, null =
 * closed).
 */
export function AgentEditor() {
  const editingSlug = useAgents((s) => s.editingSlug);
  const openEditor = useAgents((s) => s.openEditor);
  const refreshAgents = useAgents((s) => s.refreshAgents);

  const open = editingSlug !== null;
  const isNew = editingSlug === "";

  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // load the draft whenever the target changes
  useEffect(() => {
    if (editingSlug === null) return;
    setError(null);
    if (editingSlug === "") {
      setDraft(blankDraft());
      return;
    }
    let cancelled = false;
    setLoading(true);
    void readAgent(editingSlug)
      .then((d) => {
        if (cancelled) return;
        setDraft({
          name: d.name,
          emoji: d.emoji || DEFAULT_EMOJI,
          accent: d.accent || AGENT_COLORS[0],
          role: d.role,
          tone: d.tone,
          principles: d.principles.join("\n"),
          defaultRuntime: d.defaultRuntime,
          soul: d.soul,
          createdAt: d.createdAt,
        });
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [editingSlug]);

  const derivedSlug = isNew ? slugify(draft.name) : (editingSlug ?? "");
  const canSave = draft.name.trim().length > 0 && (!isNew || derivedSlug.length > 0);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const def = {
      name: draft.name.trim(),
      slug: derivedSlug,
      emoji: draft.emoji.trim() || DEFAULT_EMOJI,
      accent: draft.accent,
      role: draft.role.trim(),
      tone: draft.tone.trim(),
      principles: draft.principles
        .split("\n")
        .map((p) => p.trim())
        .filter(Boolean),
      defaultRuntime: draft.defaultRuntime,
      createdAt: draft.createdAt,
    };
    try {
      if (isNew) {
        await createAgent(def, draft.soul);
      } else {
        await writeAgent(derivedSlug, def, draft.soul);
      }
      await refreshAgents();
      openEditor(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && openEditor(null)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isNew ? "New agent" : "Edit agent"}</DialogTitle>
          <DialogDescription>
            {isNew
              ? "Give it an identity and a soul. Memory and knowledge grow later — the Builder wizard arrives in the next step."
              : "Edit this agent's identity card and its soul. Its memory and knowledge files are its own."}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-faint">
            <Loader2 size={18} className="animate-spin" />
          </div>
        ) : (
          <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
            {/* identity row: emoji + name */}
            <div className="flex gap-3">
              <div>
                <Label>Emoji</Label>
                <Input
                  value={draft.emoji}
                  onChange={(e) => setDraft({ ...draft, emoji: e.target.value })}
                  className="w-16 text-center text-lg"
                  maxLength={4}
                />
              </div>
              <div className="min-w-0 flex-1">
                <Label>Name</Label>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="e.g. YouTube Coach"
                  autoFocus={isNew}
                />
                <div className="mt-1 font-mono text-[10px] text-faint">
                  {isNew ? (
                    derivedSlug ? (
                      <>
                        folder:{" "}
                        <span className="text-muted-foreground">
                          ~/.swarmz/agents/{derivedSlug}
                        </span>
                      </>
                    ) : (
                      "give it a name to derive its slug"
                    )
                  ) : (
                    <span className="text-muted-foreground">{editingSlug}</span>
                  )}
                </div>
              </div>
            </div>

            <div>
              <Label>Role</Label>
              <Input
                value={draft.role}
                onChange={(e) => setDraft({ ...draft, role: e.target.value })}
                placeholder="short role line, e.g. strategy & scripts"
              />
            </div>

            <div>
              <Label>Identity color</Label>
              <div className="flex flex-wrap gap-1.5">
                {AGENT_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setDraft({ ...draft, accent: c })}
                    className="h-6 w-6 rounded-full border-2 transition-transform hover:scale-110"
                    style={{
                      backgroundColor: c,
                      borderColor:
                        draft.accent === c ? "var(--foreground)" : "transparent",
                    }}
                    title={c}
                  />
                ))}
              </div>
            </div>

            <div>
              <Label>Default runtime</Label>
              <Select
                value={draft.defaultRuntime}
                onValueChange={(v) =>
                  setDraft({ ...draft, defaultRuntime: v as AgentDefaultRuntime })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="vibe">Vibe (native Codex session)</SelectItem>
                  <SelectItem value="claude">Claude Code (terminal)</SelectItem>
                  <SelectItem value="codex">Codex CLI (terminal)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Tone</Label>
              <Input
                value={draft.tone}
                onChange={(e) => setDraft({ ...draft, tone: e.target.value })}
                placeholder="voice / directness, e.g. direct, honest, no hype"
              />
            </div>

            <div>
              <Label>Principles (one per line)</Label>
              <Textarea
                value={draft.principles}
                onChange={(e) =>
                  setDraft({ ...draft, principles: e.target.value })
                }
                placeholder={"retention first\nhonesty over hype"}
                className="min-h-16 font-mono text-xs"
              />
            </div>

            <div>
              <Label>Soul (soul.md — the agent's voice)</Label>
              <Textarea
                value={draft.soul}
                onChange={(e) => setDraft({ ...draft, soul: e.target.value })}
                placeholder="# Agent name\nWho you are, how you speak, what you value, where your limits are."
                className="min-h-32 font-mono text-xs"
              />
            </div>

            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}

            <div className="flex justify-between gap-2 pt-1">
              <Button variant="ghost" onClick={() => openEditor(null)}>
                Cancel
              </Button>
              <Button
                disabled={!canSave || saving}
                onClick={() => void save()}
                className={cn(saving && "opacity-70")}
              >
                {saving && <Loader2 size={14} className="animate-spin" />}
                {isNew ? "Create agent" : "Save"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
