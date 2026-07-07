import { SessionRail } from "./SessionRail";
import { FocusStage } from "./FocusStage";
import {
  CloseSessionConfirm,
  NewVibeSessionDialog,
} from "./NewVibeSessionDialog";

/**
 * The Vibe view: a left session rail + the focus stage, filling the same
 * grid-area box as the WorkspaceLayer. Stays mounted in grid mode (hidden by
 * the App's visibility wrapper) so switching modes is instant and lossless —
 * exactly the WorkspaceLayer pattern. Its own dialogs live here since they're
 * only reachable from this view.
 */
export function VibeLayer() {
  return (
    <div className="flex h-full w-full min-h-0 bg-background">
      <SessionRail />
      <FocusStage />
      <NewVibeSessionDialog />
      <CloseSessionConfirm />
    </div>
  );
}
