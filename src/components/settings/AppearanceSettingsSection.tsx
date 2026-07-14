import { useSwarm } from "@/store";
import { SettingsSection, SettingsToggleCard } from "./SettingsPrimitives";

export function AppearanceSettingsSection() {
  const reduceMotion = useSwarm((state) => !!state.settings.reduceMotion);
  const updateSettings = useSwarm((state) => state.updateSettings);

  return (
    <SettingsSection label="Appearance">
      <SettingsToggleCard
        title="Reduce motion"
        sub="Collapses sweeps, pulses and entrance animations."
        checked={reduceMotion}
        onChange={(value) => updateSettings({ reduceMotion: value })}
      />
    </SettingsSection>
  );
}
