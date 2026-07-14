import { ChevronDown } from "lucide-react";
import { useSwarm } from "@/store";
import { IS_TAURI } from "@/lib/transport";
import { prettyModel } from "@/lib/utils";
import { recentCodexModels } from "@/lib/orchestrator/models";
import { ModelEffortPicker } from "@/components/orchestrator/ModelEffortPicker";
import {
  SettingsInfoRow,
  SettingsRow,
  SettingsSection,
  SettingsToggleCard,
} from "./SettingsPrimitives";

function CodexDefaultsRows() {
  const settings = useSwarm((state) => state.settings);
  const updateSettings = useSwarm((state) => state.updateSettings);
  const model = settings.orchestratorCodexModel;
  const effort = settings.orchestratorCodexEffort;

  return (
    <SettingsRow
      label="Default model & effort"
      help="Model and reasoning effort new chats start on — the same picker (Available · Recent · Custom) each chat's header uses. Every chat can still change it per turn. Default = your plain codex config."
    >
      <ModelEffortPicker
        model={model}
        effort={effort}
        models={recentCodexModels()}
        footer="Default for new chats."
        onApply={(next) =>
          updateSettings({
            orchestratorCodexModel: next.model || undefined,
            orchestratorCodexEffort: next.effort || undefined,
          })
        }
      >
        <button
          title="Default model & reasoning effort for new chats"
          className="focus-ring flex items-center gap-1 rounded-full border border-line bg-pop px-2.5 py-1 font-mono text-11 text-mut transition-colors hover:border-acc/55 hover:text-txt"
        >
          <span className="max-w-40 truncate">
            {model ? prettyModel(model) : "Default"}
          </span>
          {effort && <span className="text-fnt">· {effort}</span>}
          <ChevronDown size={11} className="text-fnt" />
        </button>
      </ModelEffortPicker>
    </SettingsRow>
  );
}

export function ConductorSettingsSection() {
  if (!IS_TAURI) {
    return (
      <SettingsSection
        label="Orchestrator"
        sub="The persistent AI engineering lead for each project."
      >
        <p className="border-t border-line py-3 text-12 leading-relaxed text-mut">
          The Orchestrator ships with the native macOS app.
        </p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      label="Orchestrator"
      sub="The project's fixed AI engineering lead — runs on your ChatGPT subscription via the codex CLI."
    >
      <CodexDefaultsRows />
    </SettingsSection>
  );
}

export function AutonomySettingsSection() {
  const autoReview = useSwarm(
    (state) => !!state.settings.autoReviewFinishedLanes,
  );
  const autoCompact = useSwarm((state) => state.settings.autoCompact !== false);
  const updateSettings = useSwarm((state) => state.updateSettings);

  if (!IS_TAURI) return null;

  return (
    <SettingsSection label="Autonomy">
      <div className="flex flex-col gap-2">
        <SettingsToggleCard
          title="Auto-review finished lanes"
          sub="When an Orchestrator-assigned worker finishes code changes, a detached Codex review runs automatically and its findings join the Orchestrator report. Costs one extra review turn per lane."
          checked={autoReview}
          onChange={(value) =>
            updateSettings({ autoReviewFinishedLanes: value })
          }
        />
        <SettingsToggleCard
          title="Auto-compact context"
          sub="When a worker or Orchestrator chat nears its context window (≥85%), it compacts automatically before the next turn. The visible transcript stays intact."
          checked={autoCompact}
          onChange={(value) => updateSettings({ autoCompact: value })}
        />
        <SettingsInfoRow
          title="Autonomy budget"
          text="Autonomous turns are budget-capped — max 5 consecutive without your message, 20 per hour per project. A tripped breaker re-arms on your next message."
        />
        <SettingsInfoRow
          title="Approval policy"
          text="Routine read-only/test approvals can be decided by the Orchestrator; anything destructive always waits for you."
        />
      </div>
    </SettingsSection>
  );
}
