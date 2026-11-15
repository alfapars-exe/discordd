import { useTranslation } from "react-i18next";
import { useState } from "react";
import { capturePreferenceScope } from "../../stores/preferenceScope";
import { logToServer } from "../../api/clientLog";
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
  function retryCurrent() {
    const isCurrent = capturePreferenceScope();
    void retry().catch(() => {
      if (isCurrent()) void logToServer("error", "preferences_retry_failed");
    });
  }
  const accountChanged = status === "error" && syncError === "preferences_account_mismatch";
  const statusKey = accountChanged ? "accountChanged" : status === "error" && syncError === "preferences_apply_failed" ? "applyError" : status;
  if (status === "idle" && !legacyAvailable) return null;
  return (
    <>
      {status !== "idle" && <div className={`preferences-sync preferences-sync--${status}`} role="status" aria-live="polite">
        <span>{t(`preferencesSync.${statusKey}`)}</span>
        {status === "error" && <button type="button" onClick={retryCurrent}>
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
