import { useSwarm } from "@/store";
import { playAttentionSound } from "@/lib/attention/sound";
import { SettingsSection, SettingsToggleCard } from "./SettingsPrimitives";

export function AppearanceSettingsSection() {
  const reduceMotion = useSwarm((state) => !!state.settings.reduceMotion);
  const attentionSound = useSwarm(
    (state) => state.settings.attentionSound !== false,
  );
  const updateSettings = useSwarm((state) => state.updateSettings);

  return (
    <SettingsSection label="Appearance">
      <SettingsToggleCard
        title="Reduce motion"
        sub="Collapses sweeps, pulses and entrance animations."
        checked={reduceMotion}
        onChange={(value) => updateSettings({ reduceMotion: value })}
      />
      <div className="mt-2">
        <SettingsToggleCard
          title="Attention sound"
          sub="Plays a short chime once when an agent starts waiting for your input."
          checked={attentionSound}
          onChange={(value) => {
            updateSettings({ attentionSound: value });
            if (value) void playAttentionSound();
          }}
        />
      </div>
    </SettingsSection>
  );
}
