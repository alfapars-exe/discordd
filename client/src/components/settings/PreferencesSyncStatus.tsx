import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { capturePreferenceScope, getPreferenceScopeGeneration } from "../../stores/preferenceScope";
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
  // Every binding reset publishes store state, including same-user backend changes.
  const binding = usePreferencesStore(() => getPreferenceScopeGeneration());
  const [importState, setImportState] = useState<{ version: number; pending: boolean; error: boolean } | null>(null);
  const importAttempt = useRef<{ version: number } | null>(null);
  const currentImport = importState?.version === binding ? importState : null;
  useEffect(() => () => { importAttempt.current = null; }, []);
  async function importCurrent() {
    const version = getPreferenceScopeGeneration();
    if (importAttempt.current?.version === version) return;
    const attempt = { version };
    importAttempt.current = attempt;
    setImportState({ version, pending: true, error: false });
    const isCurrent = () => importAttempt.current === attempt && getPreferenceScopeGeneration() === version;
    try {
      const imported = await importLegacy();
      if (isCurrent()) setImportState({ version, pending: false, error: !imported });
    } catch {
      if (isCurrent()) {
        setImportState({ version, pending: false, error: true });
        void logToServer("error", "preferences_import_failed");
      }
    } finally {
      if (importAttempt.current === attempt) importAttempt.current = null;
    }
  }
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
        <button type="button" disabled={currentImport?.pending === true} aria-busy={currentImport?.pending === true} onClick={() => void importCurrent()}>
          {t("preferencesSync.importLegacy")}
        </button>
        {currentImport?.error && <span role="alert">{t("preferencesSync.legacyError")}</span>}
      </div>}
    </>
  );
}
