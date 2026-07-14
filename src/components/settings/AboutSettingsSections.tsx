import { ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { IS_TAURI, openUrl } from "@/lib/transport";
import { useUpdates } from "@/lib/updates";
import { useSwarm } from "@/store";
import { SettingsRow, SettingsSection } from "./SettingsPrimitives";

const REPO_URL = "https://github.com/AgentZ-Media/SwarmZ";
const AGENTZ_URL = "https://linktr.ee/deragentz";

export function UpdatesSettingsSection() {
  const settings = useSwarm((state) => state.settings);
  const updateSettings = useSwarm((state) => state.updateSettings);
  const stage = useUpdates((state) => state.stage);
  const version = useUpdates((state) => state.version);
  const progress = useUpdates((state) => state.progress);
  const manualCheck = useUpdates((state) => state.manualCheck);
  const checkNow = useUpdates((state) => state.checkNow);
  const downloadAndInstall = useUpdates(
    (state) => state.downloadAndInstall,
  );
  const restart = useUpdates((state) => state.restart);

  if (!IS_TAURI) {
    return (
      <SettingsSection
        label="Updates"
        sub="Keep SwarmZ up to date from GitHub Releases."
      >
        <p className="border-t border-line py-3 text-12 leading-relaxed text-mut">
          In-app updates ship with the native macOS app.
        </p>
      </SettingsSection>
    );
  }

  const status =
    stage === "available"
      ? `Update ${version ?? ""} available`
      : stage === "downloading"
        ? `Downloading… ${progress}%`
        : stage === "ready"
          ? "Update downloaded — restart to apply"
          : stage === "error"
            ? "Update failed"
            : manualCheck === "uptodate"
              ? "You're up to date"
              : `SwarmZ v${__APP_VERSION__}`;

  return (
    <SettingsSection
      label="Updates"
      sub="Keep SwarmZ up to date from GitHub Releases."
    >
      <SettingsRow
        label="Automatic updates"
        help="Download new versions in the background as soon as they're found. Installing still happens on the next restart."
      >
        <Switch
          checked={!!settings.autoUpdate}
          onCheckedChange={(value) => updateSettings({ autoUpdate: value })}
          label="Automatic updates"
        />
      </SettingsRow>

      <SettingsRow label="Check for updates" help={status}>
        {stage === "available" && (
          <Button size="sm" onClick={() => void downloadAndInstall()}>
            Download
          </Button>
        )}
        {stage === "ready" && (
          <Button size="sm" onClick={() => void restart()}>
            Restart now
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={
            manualCheck === "checking" ||
            stage === "available" ||
            stage === "downloading" ||
            stage === "ready"
          }
          onClick={() => void checkNow()}
        >
          <RefreshCw
            size={13}
            className={manualCheck === "checking" ? "animate-spin" : ""}
          />
          {manualCheck === "checking" ? "Checking…" : "Check now"}
        </Button>
      </SettingsRow>
    </SettingsSection>
  );
}

function LinkRow({
  label,
  help,
  text,
  url,
}: {
  label: string;
  help?: string;
  text: string;
  url: string;
}) {
  return (
    <SettingsRow label={label} help={help}>
      <button
        className="focus-ring flex items-center gap-1.5 font-mono text-12 text-acc hover:underline"
        onClick={() => void openUrl(url)}
      >
        {text}
        <ExternalLink size={11} />
      </button>
    </SettingsRow>
  );
}

export function AboutSettingsSection() {
  return (
    <SettingsSection label="About">
      <div className="mb-3 pt-1">
        <div className="flex items-center gap-2 text-14 font-bold tracking-[-0.01em] text-txt">
          <span className="hex-mark hex-mark-flat inline-block h-5 w-5" />
          SwarmZ
          <span className="font-mono text-12 font-normal text-mut">
            v{__APP_VERSION__}
          </span>
        </div>
        <p className="mt-1 text-12 leading-relaxed text-mut">
          Run and monitor a swarm of temporary Codex workers — live sessions,
          approvals, tokens &amp; cost. 100% local.
        </p>
      </div>

      <LinkRow
        label="Source code"
        help="Issues, releases and the README live on GitHub."
        text="AgentZ-Media/SwarmZ"
        url={REPO_URL}
      />
      <LinkRow
        label="Made by AgentZ"
        text="linktr.ee/deragentz"
        url={AGENTZ_URL}
      />
    </SettingsSection>
  );
}
