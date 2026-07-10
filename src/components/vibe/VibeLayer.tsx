import { SessionRail } from "./SessionRail";
import { FocusStage } from "./FocusStage";
import {
  CloseProjectConfirm,
  CloseSessionConfirm,
  NewVibeSessionDialog,
} from "./NewVibeSessionDialog";

/**
 * The app's one and only view: a left session rail + the focus stage. Its
 * own dialogs live here since they're only reachable from this view.
 */
export function VibeLayer() {
  return (
    <div className="flex h-full w-full min-h-0 bg-background">
      <SessionRail />
      <FocusStage />
      <NewVibeSessionDialog />
      <CloseSessionConfirm />
      <CloseProjectConfirm />
    </div>
  );
}
