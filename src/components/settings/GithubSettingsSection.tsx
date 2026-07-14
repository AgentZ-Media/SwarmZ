import { useSwarm } from "@/store";
import { IS_TAURI } from "@/lib/transport";
import { cn } from "@/lib/utils";
import {
  SettingsRow,
  SettingsSection,
  SettingsToggleCard,
} from "./SettingsPrimitives";

const WATCH_INTERVALS = [
  { label: "1m", sec: 60 },
  { label: "2m", sec: 120 },
  { label: "5m", sec: 300 },
  { label: "10m", sec: 600 },
] as const;

export function GithubSettingsSection() {
  const settings = useSwarm((state) => state.settings);
  const updateSettings = useSwarm((state) => state.updateSettings);
  if (!IS_TAURI) return null;

  const enabled = !!settings.githubIntegration;
  const intervalSec = settings.githubWatchIntervalSec ?? 120;

  return (
    <SettingsSection
      label="GitHub"
      sub="Uses your locally installed, logged-in gh CLI — SwarmZ never handles tokens or its own login. The panel (title bar) is always read-only available; this switch adds the automation."
    >
      <div className="flex flex-col gap-2">
        <SettingsToggleCard
          title="GitHub integration"
          sub="Gives the Orchestrator GitHub PR tools, starts the watcher and Deck indicator, and permits routine review/comment approvals. Merging and closing PRs always stay with you."
          checked={enabled}
          onChange={(value) => updateSettings({ githubIntegration: value })}
        />
        <div
          className={
            enabled
              ? "flex flex-col gap-2"
              : "pointer-events-none flex flex-col gap-2 opacity-40"
          }
        >
          <SettingsToggleCard
            title="Auto-review new PRs"
            sub="A newly opened PR wakes the Orchestrator for an autonomous, budget-capped review turn."
            checked={!!settings.githubAutoReviewPrs}
            onChange={(value) =>
              updateSettings({ githubAutoReviewPrs: value })
            }
          />
          <SettingsToggleCard
            title="Suggest a PR when a lane finishes"
            sub="When an Orchestrator-assigned worker finishes a branch without an open PR, the report suggests opening one. Creation still needs your order."
            checked={!!settings.githubSuggestPrOnFinish}
            onChange={(value) =>
              updateSettings({ githubSuggestPrOnFinish: value })
            }
          />
          <SettingsToggleCard
            title="Autonomous GitHub writes"
            sub="Lets the Orchestrator open PRs, comment and post reviews during autonomous turns. Off means it proposes those writes first. Merge and close always remain human-only."
            checked={!!settings.autonomousGithubWrites}
            onChange={(value) =>
              updateSettings({ autonomousGithubWrites: value })
            }
          />
          <SettingsRow
            label="Watch interval"
            help="How often open PRs are polled for check/review changes."
          >
            <div className="flex items-center gap-1">
              {WATCH_INTERVALS.map((interval) => (
                <button
                  key={interval.sec}
                  onClick={() =>
                    updateSettings({ githubWatchIntervalSec: interval.sec })
                  }
                  className={cn(
                    "focus-ring rounded-md border px-2 py-0.5 font-mono text-10 transition-colors",
                    intervalSec === interval.sec
                      ? "border-acc/60 text-txt"
                      : "border-line text-mut hover:text-txt",
                  )}
                >
                  {interval.label}
                </button>
              ))}
            </div>
          </SettingsRow>
        </div>
      </div>
    </SettingsSection>
  );
}
