/**
 * UpdateBanner — top-of-page nudge for both update channels:
 *
 *   • Web (browser tab):  /api/version polled by useWebUpdateChecker.
 *     When a newer build is deployed, the banner says "Güncelleme var"
 *     and clicking Güncelle reloads the tab.
 *
 *   • Desktop (Electron): release feed polled by setupAutoUpdater in main.
 *     We get three states from useUpdateChecker:
 *       - downloading → show progress bar + version, no button yet
 *       - ready       → show "Yeniden Başlat" button (calls quitAndInstall)
 *
 * Electron takes priority — if the user is running the desktop app and a
 * new installer is downloading, we show the desktop banner even if a
 * server-side redeploy also happened (the desktop will pick up the new
 * client bundle on restart anyway).
 */

import { useTranslation } from "react-i18next";
import { useUpdateChecker } from "../../hooks/useUpdateChecker";
import { useWebUpdateChecker } from "../../hooks/useWebUpdateChecker";

const BANNER_STYLE: React.CSSProperties = {
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
};

const PRIMARY_BTN_STYLE: React.CSSProperties = {
  background: "#fff",
  color: "#06b6d4",
  border: "none",
  padding: "6px 16px",
  borderRadius: 6,
  fontWeight: 700,
  cursor: "pointer",
  fontSize: 14,
};

const PROGRESS_TRACK_STYLE: React.CSSProperties = {
  width: 140,
  height: 6,
  borderRadius: 999,
  background: "rgba(255,255,255,0.25)",
  overflow: "hidden",
};

function UpdateBanner() {
  const { t } = useTranslation("common");
  const electron = useUpdateChecker();
  const webUpdateAvailable = useWebUpdateChecker();

  // Electron has priority because a desktop user upgrading the installer
  // also gets the new client bundle on restart — no need to surface both.
  if (electron.status === "ready") {
    return (
      <div role="status" aria-live="polite" style={BANNER_STYLE}>
        <span>
          {t("updateReadyToInstall", { defaultValue: "Yeni sürüm hazır" })}
          {electron.update?.version ? ` — v${electron.update.version}` : ""}
        </span>
        <button onClick={electron.restartAndInstall} style={PRIMARY_BTN_STYLE}>
          {t("updateRestartAndInstall", { defaultValue: "Yeniden Başlat ve Yükle" })}
        </button>
        <button
          onClick={electron.dismiss}
          style={{ ...PRIMARY_BTN_STYLE, background: "transparent", color: "#fff", fontWeight: 500 }}
          aria-label={t("dismiss", { defaultValue: "Kapat" })}
        >
          ✕
        </button>
      </div>
    );
  }

  if (electron.status === "downloading") {
    return (
      <div role="status" aria-live="polite" style={BANNER_STYLE}>
        <span>
          {t("updateDownloading", { defaultValue: "Güncelleme indiriliyor" })}
          {electron.update?.version ? ` — v${electron.update.version}` : ""}
        </span>
        <div style={PROGRESS_TRACK_STYLE} aria-hidden="true">
          <div
            style={{
              width: `${electron.progress}%`,
              height: "100%",
              background: "#fff",
              transition: "width .25s ease",
            }}
          />
        </div>
        <span style={{ minWidth: 36, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          {electron.progress}%
        </span>
      </div>
    );
  }

  if (webUpdateAvailable) {
    return (
      <div role="status" aria-live="polite" style={BANNER_STYLE}>
        <span>{t("updateAvailable")}</span>
        <button onClick={() => window.location.reload()} style={PRIMARY_BTN_STYLE}>
          {t("updateApp")}
        </button>
      </div>
    );
  }

  return null;
}

export default UpdateBanner;
