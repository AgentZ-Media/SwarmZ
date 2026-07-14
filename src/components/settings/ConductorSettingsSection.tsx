import { ChevronDown } from "lucide-react";
import { useSwarm } from "@/store";
import { IS_TAURI } from "@/lib/transport";
import { prettyModel } from "@/lib/utils";
import { recentCodexModels } from "@/lib/orchestrator/models";
import { ModelEffortPicker } from "@/components/orchestrator/ModelEffortPicker";
import {
  MAX_AUTONOMY_BUDGET_LIMIT,
  MAX_AUTONOMOUS_TURNS_PER_WINDOW,
  MAX_CONSECUTIVE_AUTONOMOUS_TURNS,
  MIN_AUTONOMY_BUDGET_LIMIT,
  normalizeAutonomyBudgetLimit,
} from "@/lib/orchestrator/autonomy";
import {
  MAX_REVIEW_ITERATIONS,
  normalizeReviewIterationLimit,
} from "@/lib/orchestrator/review-policy";
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

function BudgetLimitInput({
  label,
  value,
  onCommit,
  disabled,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  disabled: boolean;
}) {
  return (
    <label className="min-w-0 font-mono text-10 text-fnt">
      {label}
      <input
        key={value}
        type="number"
        min={MIN_AUTONOMY_BUDGET_LIMIT}
        max={MAX_AUTONOMY_BUDGET_LIMIT}
        step={1}
        defaultValue={value}
        disabled={disabled}
        onBlur={(event) => {
          const next = normalizeAutonomyBudgetLimit(
            Number(event.currentTarget.value),
            value,
          );
          event.currentTarget.value = String(next);
          if (next !== value) onCommit(next);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className="focus-ring mt-1 h-8 w-full rounded-md border border-line2 bg-pop px-2 font-mono text-12 tabular-nums text-txt disabled:cursor-not-allowed disabled:opacity-40"
      />
    </label>
  );
}

function ReviewLimitInput({
  value,
  disabled,
  onCommit,
}: {
  value: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  return (
    <label className="block font-mono text-10 text-fnt">
      Maximum review iterations per worktree
      <input
        key={value}
        type="number"
        min={1}
        max={MAX_REVIEW_ITERATIONS}
        step={1}
        defaultValue={value}
        disabled={disabled}
        onBlur={(event) => {
          const next = normalizeReviewIterationLimit(
            Number(event.currentTarget.value),
          );
          event.currentTarget.value = String(next);
          if (next !== value) onCommit(next);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className="focus-ring mt-1 h-8 w-full rounded-md border border-line2 bg-pop px-2 font-mono text-12 tabular-nums text-txt disabled:cursor-not-allowed disabled:opacity-40"
      />
    </label>
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
  const maxReviewIterations = useSwarm((state) =>
    normalizeReviewIterationLimit(state.settings.autoReviewMaxIterations),
  );
  const autoCompact = useSwarm((state) => state.settings.autoCompact !== false);
  const budgetEnabled = useSwarm(
    (state) => state.settings.autonomyBudgetEnabled !== false,
  );
  const maxConsecutive = useSwarm((state) =>
    normalizeAutonomyBudgetLimit(
      state.settings.autonomyMaxConsecutiveTurns,
      MAX_CONSECUTIVE_AUTONOMOUS_TURNS,
    ),
  );
  const maxPerHour = useSwarm((state) =>
    normalizeAutonomyBudgetLimit(
      state.settings.autonomyMaxTurnsPerHour,
      MAX_AUTONOMOUS_TURNS_PER_WINDOW,
    ),
  );
  const updateSettings = useSwarm((state) => state.updateSettings);

  if (!IS_TAURI) return null;

  return (
    <SettingsSection label="Autonomy">
      <div className="flex flex-col gap-2">
        <SettingsToggleCard
          title="Automated code-review loop"
          sub="Off by default. When enabled, finished feature work is reviewed and findings are fixed in the same worktree. The hard limit prevents endless review/fix cycles."
          checked={autoReview}
          onChange={(value) =>
            updateSettings({ autoReviewFinishedLanes: value })
          }
        >
          <div
            className={
              autoReview
                ? "mt-3 border-t border-line pt-3"
                : "pointer-events-none mt-3 border-t border-line pt-3 opacity-40"
            }
          >
            <ReviewLimitInput
              value={maxReviewIterations}
              disabled={!autoReview}
              onCommit={(value) =>
                updateSettings({ autoReviewMaxIterations: value })
              }
            />
          </div>
        </SettingsToggleCard>
        <SettingsToggleCard
          title="Auto-compact context"
          sub="When a worker or Orchestrator chat nears its context window (≥85%), it compacts automatically before the next turn. The visible transcript stays intact."
          checked={autoCompact}
          onChange={(value) => updateSettings({ autoCompact: value })}
        />
        <SettingsToggleCard
          title="Autonomy budget"
          sub="Caps autonomous turns per project. A reached limit pauses autonomy until your next message; turn this off for unlimited autonomous turns."
          checked={budgetEnabled}
          onChange={(value) =>
            updateSettings({ autonomyBudgetEnabled: value })
          }
        >
          <div
            className={
              budgetEnabled
                ? "mt-3 grid grid-cols-2 gap-2 border-t border-line pt-3"
                : "pointer-events-none mt-3 grid grid-cols-2 gap-2 border-t border-line pt-3 opacity-40"
            }
          >
            <BudgetLimitInput
              label="Consecutive turns"
              value={maxConsecutive}
              disabled={!budgetEnabled}
              onCommit={(value) =>
                updateSettings({ autonomyMaxConsecutiveTurns: value })
              }
            />
            <BudgetLimitInput
              label="Turns per hour"
              value={maxPerHour}
              disabled={!budgetEnabled}
              onCommit={(value) =>
                updateSettings({ autonomyMaxTurnsPerHour: value })
              }
            />
          </div>
        </SettingsToggleCard>
        <SettingsInfoRow
          title="Approval policy"
          text="Routine read-only/test approvals can be decided by the Orchestrator; anything destructive always waits for you."
        />
      </div>
    </SettingsSection>
  );
}
