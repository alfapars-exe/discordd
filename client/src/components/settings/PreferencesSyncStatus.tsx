import { useTranslation } from "react-i18next";
import { useState } from "react";
import { usePreferencesStore } from "../../stores/preferencesStore";
import "../../styles/preferences-sync.css";

/** Durable preferences have their own status, separate from local device settings. */
export default function PreferencesSyncStatus() {
  const { t } = useTranslation("settings");
  const status = usePreferencesStore((s) => s.syncStatus);
  const syncError = usePreferencesStore((s) => s.syncError);
  const retry = usePreferencesStore((s) => s.retrySync);
  const legacyAvailable = usePreferencesStore((s) => s.legacyImportAvailable);
  const importLegacy = usePreferencesStore((s) => s.importLegacyPreferences);
  const [importError, setImportError] = useState(false);
  const accountChanged = status === "error" && syncError === "preferences_account_mismatch";
  if (status === "idle" && !legacyAvailable) return null;
  return (
    <>
      {status !== "idle" && <div className={`preferences-sync preferences-sync--${status}`} role="status" aria-live="polite">
        <span>{t(`preferencesSync.${accountChanged ? "accountChanged" : status}`)}</span>
        {status === "error" && <button type="button" onClick={() => void retry()}>
          {t("preferencesSync.retry")}
        </button>}
      </div>}
      {legacyAvailable && !accountChanged && <div className="preferences-sync">
        <span>{t("preferencesSync.legacyDescription")}</span>
        <button type="button" onClick={async () => setImportError(!await importLegacy())}>
          {t("preferencesSync.importLegacy")}
        </button>
        {importError && <span role="alert">{t("preferencesSync.legacyError")}</span>}
      </div>}
    </>
  );
}
