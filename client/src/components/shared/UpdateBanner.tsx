/**
 * UpdateBanner — top-of-page nudge shown when the server has been redeployed
 * since this tab loaded. Click "Güncelle" to reload, picking up the new
 * bundle. Uses inline styles to avoid having to plumb a CSS file change
 * through the Vite build pipeline for a single component.
 */

import { useTranslation } from "react-i18next";
import { useWebUpdateChecker } from "../../hooks/useWebUpdateChecker";

function UpdateBanner() {
  const { t } = useTranslation("common");
  const updateAvailable = useWebUpdateChecker();

  if (!updateAvailable) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: "10px 16px",
        background: "linear-gradient(90deg,#06b6d4,#7c3aed)",
        color: "#fff",
        fontWeight: 600,
        fontSize: 14,
        boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
      }}
    >
      <span>{t("updateAvailable")}</span>
      <button
        onClick={() => window.location.reload()}
        style={{
          background: "#fff",
          color: "#06b6d4",
          border: "none",
          padding: "6px 16px",
          borderRadius: 6,
          fontWeight: 700,
          cursor: "pointer",
          fontSize: 14,
        }}
      >
        {t("updateApp")}
      </button>
    </div>
  );
}

export default UpdateBanner;
