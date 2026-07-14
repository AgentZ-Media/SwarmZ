import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import {
  AutonomySettingsSection,
  ConductorSettingsSection,
} from "./settings/ConductorSettingsSection";
import { GithubSettingsSection } from "./settings/GithubSettingsSection";
import { AppearanceSettingsSection } from "./settings/AppearanceSettingsSection";
import { ApprovalSettingsSection } from "./settings/ApprovalSettingsSection";
import {
  MemorySettingsSection,
  PathsSettingsSection,
} from "./settings/MemoryPathsSettingsSections";
import {
  AboutSettingsSection,
  UpdatesSettingsSection,
} from "./settings/AboutSettingsSections";

/** Settings v2 — a scrolling composition of domain-owned sections. */
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl overflow-hidden p-0"
        aria-describedby={undefined}
      >
        <div className="flex h-[560px] max-h-[80vh] flex-col">
          <div className="shrink-0 border-b border-line px-6 pb-3 pt-5">
            <DialogTitle>Settings</DialogTitle>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
            <ConductorSettingsSection />
            <AutonomySettingsSection />
            <ApprovalSettingsSection />
            <GithubSettingsSection />
            <AppearanceSettingsSection />
            <MemorySettingsSection />
            <PathsSettingsSection />
            <UpdatesSettingsSection />
            <AboutSettingsSection />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
