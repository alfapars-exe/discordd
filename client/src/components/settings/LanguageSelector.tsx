/** LanguageSelector — Language selection dropdown. */

import { useTranslation } from "react-i18next";
import { useTimeFormatStore, type TimeFormat } from "../../stores/timeFormatStore";

type LanguageSelectorProps = {
  currentLanguage: string;
  onChange: (language: string) => void;
};

const LANGUAGES = [
  { code: "en", labelKey: "english" },
  { code: "tr", labelKey: "turkish" },
] as const;

function LanguageSelector({ currentLanguage, onChange }: LanguageSelectorProps) {
  const { t } = useTranslation("settings");
  const timeFormat = useTimeFormatStore((state) => state.timeFormat);
  const setTimeFormat = useTimeFormatStore((state) => state.setTimeFormat);

  return (
    <div className="settings-field">
      <label className="settings-label">{t("language")}</label>
      <p style={{ fontSize: 11, color: "var(--t2)", marginBottom: 6 }}>{t("languageDescription")}</p>
      <select
        value={currentLanguage}
        onChange={(e) => onChange(e.target.value)}
        className="settings-select"
      >
        {LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {t(lang.labelKey)}
          </option>
        ))}
      </select>
      <label className="settings-label" htmlFor="time-format">{t("timeFormat")}</label>
      <select id="time-format" value={timeFormat} onChange={(event) => setTimeFormat(event.target.value as TimeFormat)} className="settings-select">
        <option value="auto">{t("timeFormatAuto")}</option>
        <option value="12">{t("timeFormat12")}</option>
        <option value="24">{t("timeFormat24")}</option>
      </select>
    </div>
  );
}

export default LanguageSelector;
