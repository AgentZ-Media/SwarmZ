// Shared model + reasoning-effort picker (Vibe session header, Conductor /
// orchestrator-chat header, session-rail is display-only). A small popover of
// sibling buttons — the model list is the machine's recently-used Codex models
// (models.ts) plus a "Custom…" free-text escape hatch; effort is the fixed
// codex enum. Selecting shows "applies from the next turn" — codex only picks
// up model/effort as a per-turn override.

import { type ReactNode, useState } from "react";
import { Check, Pencil } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover";
import {
  CODEX_EFFORTS,
  ensureCodexModels,
  useCodexModels,
} from "@/lib/orchestrator/models";
import { prettyModel } from "@/lib/utils";
import { cn } from "@/lib/utils";

export interface ModelEffortSelection {
  model?: string;
  effort?: string;
}

export function ModelEffortPicker({
  children,
  model,
  effort,
  models,
  showEffort = true,
  onApply,
  align = "end",
  footer = "Applies from the next turn.",
}: {
  children: ReactNode;
  model?: string;
  effort?: string;
  /** recently-used model ids to offer (recentCodexModels) */
  models: string[];
  /** hide the effort section (OpenRouter chats have no reasoning effort) */
  showEffort?: boolean;
  onApply: (next: ModelEffortSelection) => void;
  align?: "start" | "center" | "end";
  /** footer note under the options — context-specific (per-turn override in a
   * chat, "Default for new chats." in Settings). */
  footer?: string;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState("");
  // the authoritative account catalog (model/list via codex_list_models),
  // fetched lazily on first open — recents/custom stay as the fallback
  const available = useCodexModels((s) => s.available);

  // one deduped list: current model first (even if unknown), then the
  // account's available catalog (default model first), then recents that
  // the catalog doesn't already cover
  const modelOptions = [
    ...(model ? [model] : []),
    ...available,
    ...models,
  ].filter((m, i, arr) => arr.indexOf(m) === i);

  const applyModel = (next?: string) => {
    onApply({ model: next, effort });
    setCustom(false);
    setDraft("");
  };
  const applyEffort = (next?: string) => onApply({ model, effort: next });

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) ensureCodexModels();
        if (!o) setCustom(false);
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-60 p-1.5">
        <PickerLabel>Model</PickerLabel>
        <div className="flex flex-col">
          <OptionRow
            selected={!model}
            label="Default"
            hint="codex config"
            onClick={() => applyModel(undefined)}
          />
          {modelOptions.map((m) => (
            <OptionRow
              key={m}
              selected={m === model}
              label={prettyModel(m)}
              hint={m}
              mono
              onClick={() => applyModel(m)}
            />
          ))}
          {custom ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const v = draft.trim();
                if (v) applyModel(v);
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
                  }
                }}
                placeholder="model id, e.g. gpt-5.5"
                spellCheck={false}
                className="focus-ring h-6 w-full rounded bg-secondary px-1.5 font-mono text-[11px] text-foreground outline-none placeholder:text-faint"
              />
            </form>
          ) : (
            <button
              onClick={() => setCustom(true)}
              className="focus-ring flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Pencil size={11} className="text-faint" /> Custom…
            </button>
          )}
        </div>

        {showEffort && (
          <>
            <PickerLabel className="mt-2">Reasoning effort</PickerLabel>
            <div className="flex flex-col">
              <OptionRow
                selected={!effort}
                label="Default"
                hint="codex config"
                onClick={() => applyEffort(undefined)}
              />
              {CODEX_EFFORTS.map((e) => (
                <OptionRow
                  key={e}
                  selected={e === effort}
                  label={e}
                  onClick={() => applyEffort(e)}
                />
              ))}
            </div>
          </>
        )}

        <p className="px-2 pt-2 pb-1 text-[10px] leading-snug text-faint">
          {footer}
        </p>
      </PopoverContent>
    </Popover>
  );
}

function PickerLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "px-2 pb-1 pt-1 font-mono text-[9px] uppercase tracking-[0.12em] text-faint",
        className,
      )}
    >
      {children}
    </div>
  );
}

function OptionRow({
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
      onClick={onClick}
      className={cn(
        "focus-ring flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-accent",
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
