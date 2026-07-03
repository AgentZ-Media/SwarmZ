import { useSwarm } from "@/store";
import { ptyWrite } from "@/lib/transport";
import { getTerm } from "@/lib/term-registry";
import { substituteVars } from "@/lib/command-vars";

/**
 * Paste a custom command into an agent pane — shared by the ⌘⇧K insert picker
 * and the ⌘K command palette. Pastes via term.paste() (bracketed paste — agent
 * CLIs treat it as input, not keystrokes); `submit` sends a SEPARATE `\r`
 * because a `\r` inside the paste would only be a literal newline.
 */
export function insertCommandText(
  targetId: string,
  text: string,
  submit: boolean,
  inputs?: Record<string, string>,
) {
  const s = useSwarm.getState();
  const a = s.agents[targetId];
  const final = substituteVars(
    text,
    { cwd: a?.cwd, agentName: a?.name, branch: a?.git?.branch ?? null },
    inputs,
  );
  const term = getTerm(targetId);
  if (term) {
    term.paste(final);
    term.focus();
    if (submit) setTimeout(() => void ptyWrite(targetId, "\r"), 20);
  } else {
    void ptyWrite(targetId, submit ? final + "\r" : final);
  }
  s.focusAgent(targetId);
}
