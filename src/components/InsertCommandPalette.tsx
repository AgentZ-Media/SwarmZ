import { useEffect, useRef, useState, type ReactNode } from "react";
import { Command } from "cmdk";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Plus, ScrollText, Search } from "lucide-react";
import { presetKey, useSwarm } from "@/store";
import { extractInputLabels } from "@/lib/command-vars";
import { insertCommandText } from "@/lib/insert-command";
import { folderName } from "@/lib/utils";
import { PaletteGroup, PaletteItem } from "./CommandPalette";
import { Input, Label } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";
import type { CustomCommand } from "@/types";

type Step =
  | { kind: "list" }
  | { kind: "inputs"; cmd: CustomCommand; submit: boolean; labels: string[] }
  | { kind: "add" };

/**
 * ⌘⇧K — insert a custom command (prompt snippet) into the active agent pane.
 * Selection PASTES via term.paste() (bracketed paste — agent CLIs treat it as
 * input, not keystrokes) without submitting; ⌘Enter additionally sends a
 * separate `\r` to submit (a `\r` inside the paste would only be a literal
 * newline in an agent input box). Commands with {{input:Label}} placeholders
 * ask for values first; built-ins ({{folder}}, {{cwd}}, {{branch}}, {{agent}})
 * fill from the target pane. Agent panes only — floating terminals have no
 * focus tracking in the store; `insert()` only needs a pty id, so extending
 * later is purely a target-resolution change.
 */
export function InsertCommandPalette() {
  const open = useSwarm((s) => s.commandPickerOpen);
  const setOpen = useSwarm((s) => s.setCommandPickerOpen);
  const customCommands = useSwarm((s) => s.customCommands);
  const targetId = useSwarm((s) => s.focusedAgentId ?? s.activeAgentId());
  const agent = useSwarm((s) => (targetId ? s.agents[targetId] : undefined));

  const [step, setStep] = useState<Step>({ kind: "list" });
  const stepRef = useRef(step);
  stepRef.current = step;
  // ⌘ state of the Enter keydown that triggered cmdk's onSelect (fired
  // synchronously inside the same event) — mouse clicks leave it false
  const submitRef = useRef(false);

  // a command picked in ⌘K that still needs {{input}} values lands directly
  // on the inputs form; otherwise every open starts fresh at the list
  useEffect(() => {
    if (!open) return;
    const s = useSwarm.getState();
    const pre = s.commandPickerPreselect;
    if (pre) {
      s.setCommandPickerPreselect(null);
      setStep({
        kind: "inputs",
        cmd: pre.cmd,
        submit: pre.submit,
        labels: extractInputLabels(pre.cmd.text),
      });
    } else setStep({ kind: "list" });
  }, [open]);

  const folderKey = agent ? presetKey(agent.cwd) : null;
  const folderCmds = folderKey
    ? (customCommands.folders[folderKey] ?? [])
    : [];
  const globalCmds = customCommands.global;
  const empty = folderCmds.length === 0 && globalCmds.length === 0;

  const insert = (
    text: string,
    submit: boolean,
    inputs?: Record<string, string>,
  ) => {
    setOpen(false);
    if (!targetId) return;
    insertCommandText(targetId, text, submit, inputs);
  };

  const handleSelect = (cmd: CustomCommand) => {
    const submit = submitRef.current;
    submitRef.current = false;
    if (!targetId) return;
    const labels = extractInputLabels(cmd.text);
    if (labels.length) setStep({ kind: "inputs", cmd, submit, labels });
    else insert(cmd.text, submit);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-overlay-in" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-[18%] z-50 w-full max-w-lg -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-[0_16px_48px_-12px_rgba(0,0,0,0.7)] data-[state=open]:animate-in"
          // we focus the target terminal ourselves — don't restore focus
          onCloseAutoFocus={(e) => e.preventDefault()}
          // Escape steps back to the list before it closes the dialog
          onEscapeKeyDown={(e) => {
            if (stepRef.current.kind !== "list") {
              e.preventDefault();
              setStep({ kind: "list" });
            }
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            Insert command
          </DialogPrimitive.Title>

          {step.kind === "list" && (
            <Command
              label="Insert command"
              loop
              onKeyDownCapture={(e) => {
                if (e.key === "Enter") submitRef.current = e.metaKey;
              }}
            >
              <div className="flex items-center gap-2 border-b border-border px-3">
                <Search size={14} className="shrink-0 text-faint" />
                <Command.Input
                  placeholder="Insert a command into the active pane…"
                  className="h-11 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-faint"
                />
                <kbd className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-faint">
                  esc
                </kbd>
              </div>
              {!targetId && (
                <div className="border-b border-border px-3 py-2 text-xs text-faint">
                  No active agent pane — open one to insert commands.
                </div>
              )}
              {empty ? (
                <div className="flex flex-col items-center gap-3 px-3 py-8 text-center">
                  <p className="text-sm text-faint">
                    No commands yet — save prompt snippets you use often,
                    globally or per project folder.
                  </p>
                  <Button size="sm" onClick={() => setStep({ kind: "add" })}>
                    <Plus size={13} /> New command
                  </Button>
                </div>
              ) : (
                <Command.List className="max-h-80 overflow-y-auto p-1.5">
                  <Command.Empty className="px-3 py-6 text-center text-sm text-faint">
                    Nothing found.
                  </Command.Empty>
                  {folderCmds.length > 0 && agent && (
                    <PaletteGroup
                      heading={`Folder · ${agent.cwd ? folderName(agent.cwd) : "~"}`}
                    >
                      {folderCmds.map((c) => (
                        <CommandRow
                          key={c.id}
                          cmd={c}
                          disabled={!targetId}
                          onSelect={() => handleSelect(c)}
                        />
                      ))}
                    </PaletteGroup>
                  )}
                  {globalCmds.length > 0 && (
                    <PaletteGroup heading="Global">
                      {globalCmds.map((c) => (
                        <CommandRow
                          key={c.id}
                          cmd={c}
                          disabled={!targetId}
                          onSelect={() => handleSelect(c)}
                        />
                      ))}
                    </PaletteGroup>
                  )}
                </Command.List>
              )}
              <div className="flex items-center justify-between border-t border-border px-3 py-2">
                <span className="font-mono text-[10px] text-faint">
                  ↵ paste · ⌘↵ paste & run
                </span>
                <button
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => setStep({ kind: "add" })}
                >
                  <Plus size={11} /> New command
                </button>
              </div>
            </Command>
          )}

          {step.kind === "inputs" && (
            <InputsForm
              cmd={step.cmd}
              labels={step.labels}
              defaultSubmit={step.submit}
              onBack={() => setStep({ kind: "list" })}
              onInsert={(values, submit) =>
                insert(step.cmd.text, submit, values)
              }
            />
          )}

          {step.kind === "add" && (
            <AddForm
              folderKey={folderKey}
              folderLabel={agent?.cwd ? folderName(agent.cwd) : null}
              onDone={() => setStep({ kind: "list" })}
            />
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function CommandRow({
  cmd,
  disabled,
  onSelect,
}: {
  cmd: CustomCommand;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <PaletteItem
      value={`${cmd.label} ${cmd.text} ${cmd.id}`}
      onSelect={disabled ? () => {} : onSelect}
    >
      <ScrollText size={13} className="shrink-0 text-faint" />
      <span className="truncate text-foreground">{cmd.label}</span>
      <span className="ml-auto max-w-[45%] truncate pl-3 font-mono text-[10px] text-faint">
        {cmd.text.replace(/\s+/g, " ")}
      </span>
    </PaletteItem>
  );
}

/** Ask for {{input:Label}} values before inserting. */
function InputsForm({
  cmd,
  labels,
  defaultSubmit,
  onBack,
  onInsert,
}: {
  cmd: CustomCommand;
  labels: string[];
  defaultSubmit: boolean;
  onBack: () => void;
  onInsert: (values: Record<string, string>, submit: boolean) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <form
      className="flex flex-col gap-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        onInsert(values, defaultSubmit);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.metaKey) {
          e.preventDefault();
          onInsert(values, true);
        }
      }}
    >
      <div className="text-sm font-medium text-foreground">{cmd.label}</div>
      {labels.map((label, i) => (
        <div key={label}>
          <Label htmlFor={`cmd-input-${i}`}>{label}</Label>
          <Input
            id={`cmd-input-${i}`}
            autoFocus={i === 0}
            value={values[label] ?? ""}
            onChange={(e) =>
              setValues((v) => ({ ...v, [label]: e.target.value }))
            }
          />
        </div>
      ))}
      <div className="flex items-center justify-end gap-2 pt-1">
        <span className="mr-auto font-mono text-[10px] text-faint">
          esc back · ⌘↵ paste & run
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" size="sm">
          {defaultSubmit ? "Paste & run" : "Paste"}
        </Button>
      </div>
    </form>
  );
}

/** Quick-add a new command without opening Settings. */
function AddForm({
  folderKey,
  folderLabel,
  onDone,
}: {
  folderKey: string | null;
  folderLabel: string | null;
  onDone: () => void;
}) {
  const saveCustomCommand = useSwarm((s) => s.saveCustomCommand);
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [scope, setScope] = useState<"folder" | "global">(
    folderKey ? "folder" : "global",
  );
  return (
    <form
      className="flex flex-col gap-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        saveCustomCommand(scope === "folder" ? folderKey : null, label, text);
        onDone();
      }}
    >
      <div className="text-sm font-medium text-foreground">New command</div>
      <div>
        <Label htmlFor="cmd-add-label">Label</Label>
        <Input
          id="cmd-add-label"
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Fix failing tests"
        />
      </div>
      <div>
        <Label htmlFor="cmd-add-text">Text</Label>
        <Textarea
          id="cmd-add-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"Run the tests in {{folder}} and fix every failure."}
        />
        <p className="mt-1.5 font-mono text-[10px] text-faint">
          {"{{folder}} {{cwd}} {{branch}} {{agent}} {{input:Label}}"}
        </p>
      </div>
      <div className="flex gap-1.5">
        <ScopeButton
          active={scope === "folder"}
          disabled={!folderKey}
          onClick={() => setScope("folder")}
        >
          {folderLabel ? `This folder (${folderLabel})` : "This folder"}
        </ScopeButton>
        <ScopeButton active={scope === "global"} onClick={() => setScope("global")}>
          Global
        </ScopeButton>
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <span className="mr-auto font-mono text-[10px] text-faint">esc back</span>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!text.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
}

function ScopeButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={
        "rounded-md border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 " +
        (active
          ? "border-ring/60 bg-ring/15 text-foreground"
          : "border-border bg-secondary/60 text-muted-foreground hover:text-foreground")
      }
    >
      {children}
    </button>
  );
}
