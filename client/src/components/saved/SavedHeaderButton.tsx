/**
 * SavedHeaderButton — bookmark icon in the sidebar header; opens the Saved
 * tab. Also warms the saved-id index so message context menus can label
 * Save / Remove bookmark correctly on first open.
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../../stores/uiStore";
import { useSavedStore } from "../../stores/savedStore";

function SavedHeaderButton() {
  const { t } = useTranslation("saved");
  const openTab = useUIStore((s) => s.openTab);
  const ensureIds = useSavedStore((s) => s.ensureIds);

  useEffect(() => {
    void ensureIds();
  }, [ensureIds]);

  return (
    <button
      type="button"
      className="sb-header-btn"
      onClick={() => openTab("saved", "saved", t("title"))}
      title={t("title")}
      aria-label={t("title")}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </svg>
    </button>
  );
}

export default SavedHeaderButton;
