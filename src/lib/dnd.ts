import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useSwarm } from "@/store";
import { escapeDropPath } from "./utils";
import { IS_TAURI, ptyWrite } from "./transport";
import { getTerm } from "./term-registry";

/**
 * OS file drag & drop onto terminals (native only). Tauri intercepts file
 * drags at the NSView level (`dragDropEnabled` default), so the DOM never
 * sees HTML5 drop events — we listen to the Tauri drag events instead, hit-
 * test the cursor against `[data-file-drop]` zones (agent panes + floating
 * terminals, value = pty id) and on drop type the escaped path(s) into that
 * PTY, exactly like dropping a file on Terminal.app/iTerm. Claude Code picks
 * image paths up as attachments.
 */
export function startFileDropListener(): () => void {
  if (!IS_TAURI) return () => {};

  // NOTE: typed as PhysicalPosition, but on macOS the chain wry → tauri →
  // JS never scales the NSView point coordinates, so x/y are effectively
  // logical CSS px and can feed elementFromPoint directly.
  const hitTest = (pos: { x: number; y: number }): string | null =>
    document
      .elementFromPoint(pos.x, pos.y)
      ?.closest("[data-file-drop]")
      ?.getAttribute("data-file-drop") ?? null;

  const unlistenP = getCurrentWebview().onDragDropEvent((event) => {
    const { setFileDrag } = useSwarm.getState();
    const p = event.payload;
    if (p.type === "enter" || p.type === "over") {
      setFileDrag({ targetId: hitTest(p.position) });
    } else if (p.type === "drop") {
      setFileDrag(null);
      const targetId = hitTest(p.position);
      if (!targetId || p.paths.length === 0) return;
      // trailing space so the user can keep typing / hit enter right away
      const text = p.paths.map(escapeDropPath).join(" ") + " ";
      // insert as a PASTE, like iTerm/Terminal.app do on drop: term.paste()
      // wraps in bracketed-paste markers when the app enabled mode 2004 —
      // Claude Code only attaches image paths that arrive that way (raw
      // PTY writes count as typed keystrokes and stay plain text)
      const term = getTerm(targetId);
      if (term) {
        term.paste(text);
        term.focus();
      } else {
        void ptyWrite(targetId, text);
      }
      // make the receiving terminal the active one
      const { agents, floatingTerminals, focusAgent, raiseFloatingTerminal } =
        useSwarm.getState();
      if (agents[targetId]) focusAgent(targetId);
      else if (floatingTerminals[targetId]) raiseFloatingTerminal(targetId);
    } else {
      setFileDrag(null);
    }
  });

  return () => {
    void unlistenP.then((u) => u());
    useSwarm.getState().setFileDrag(null);
  };
}
