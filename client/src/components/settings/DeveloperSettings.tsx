import { useTranslation } from "react-i18next";
import { useDeveloperSettingsStore } from "../../stores/developerSettingsStore";

export default function DeveloperSettings() {
  const { t } = useTranslation("settings");
  const developerMode = useDeveloperSettingsStore((state) => state.developerMode);
  const setDeveloperMode = useDeveloperSettingsStore((state) => state.setDeveloperMode);

  return (
    <section aria-labelledby="developer-settings-title">
      <h2 id="developer-settings-title" className="settings-section-title">{t("developer.title")}</h2>
      <p className="settings-hint">{t("developer.description")}</p>
      <label className="settings-toggle-row">
        <span>
          <strong>{t("developer.mode")}</strong>
          <small>{t("developer.modeDescription")}</small>
        </span>
        <input
          type="checkbox"
          checked={developerMode}
          onChange={(event) => setDeveloperMode(event.target.checked)}
        />
      </label>
    </section>
  );
}
